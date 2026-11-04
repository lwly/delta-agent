/**
 * F-55 外部进程 spawn 底座单测（docs/design-f55-external-cli-agents.md §9）：
 *  - 全部走 fixture 脚本（process.execPath 运行 .mjs），零网络、零真实 CLI；
 *  - POSIX 专属断言（进程组 kill / SIGTERM）用平台守卫跳过，保证 Windows CI 不红。
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnExternal, MAX_LINE_BYTES } from '../src/external/spawn.js';
import type { ProcEvent, SpawnedProcess } from '../src/external/spawn.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const NODE = process.execPath;

const IS_POSIX = process.platform !== 'win32';
const itPosix = IS_POSIX ? it : it.skip;

/** 事件收集器：迭代到 exit 事件为止 */
async function collect(proc: SpawnedProcess): Promise<ProcEvent[]> {
  const events: ProcEvent[] = [];
  for await (const ev of proc.events) {
    events.push(ev);
    if (ev.type === 'exit') break;
  }
  return events;
}

function linesOf(events: ProcEvent[]): string[] {
  return events.filter((e): e is Extract<ProcEvent, { type: 'line' }> => e.type === 'line').map((e) => e.text);
}

function exitOf(events: ProcEvent[]): Extract<ProcEvent, { type: 'exit' }> {
  const last = events[events.length - 1];
  if (!last || last.type !== 'exit') throw new Error('最后一个事件必须是 exit');
  return last;
}

function runFixture(script: string, opts: Partial<Parameters<typeof spawnExternal>[0]> = {}) {
  return spawnExternal({
    command: NODE,
    args: [path.join(FIXTURES, script)],
    cwd: FIXTURES,
    signal: new AbortController().signal,
    ...opts,
  });
}

describe('spawnExternal（F-55 进程生命周期底座）', () => {
  it('正常多行输出：line 事件依序、exit code 透传', async () => {
    const proc = runFixture('echo-lines.mjs');
    const events = await collect(proc);
    expect(linesOf(events)).toEqual(['alpha', 'beta', 'gamma']);
    expect(exitOf(events).code).toBe(0);
    expect(exitOf(events).signal).toBeNull();
    expect(await proc.wait()).toEqual({ code: 0, signal: null });
  });

  it('非零退出码透传（fixture exit 3）', async () => {
    const proc = runFixture('exit-code.mjs');
    const events = await collect(proc);
    expect(exitOf(events).code).toBe(3);
  });

  it('超过 1MiB 的单行：截断到 1MiB、后续行仍到达、stderr 环形缓冲含警告', async () => {
    const proc = runFixture('huge-line.mjs');
    const events = await collect(proc);
    const lines = linesOf(events);
    expect(lines).toHaveLength(2);
    expect(lines[0].length).toBeLessThanOrEqual(MAX_LINE_BYTES);
    expect(lines[0]).toBe('x'.repeat(MAX_LINE_BYTES));
    expect(lines[1]).toBe('after-huge');
    expect(proc.stderrTail().join('\n')).toContain('stdout line exceeded 1MiB');
  });

  it('stderr 环形缓冲只保留最近 200 行（500 行输入，最早的丢失）', async () => {
    const proc = runFixture('stderr-flood.mjs');
    const events = await collect(proc);
    const stderrEvents = events.filter((e) => e.type === 'stderr_line');
    expect(stderrEvents).toHaveLength(500); // 事件全量产出
    const tail = proc.stderrTail();
    expect(tail).toHaveLength(200); // 环形缓冲只留最近 200 行
    expect(tail[0]).toBe('err-300'); // 第一行 err-0 已被挤出
    expect(tail[199]).toBe('err-499');
  });

  itPosix('cancel()：onAbort 被调用、进程组被杀（pid 消失）、cancel 幂等', async () => {
    let abortCalled = false;
    const proc = runFixture('long-running.mjs', {
      onAbort: () => {
        abortCalled = true;
      },
    });
    // 等 fixture 就绪行，确保子进程已起来
    for await (const ev of proc.events) {
      if (ev.type === 'line' && ev.text === 'ready') break;
    }
    const pid = proc.pid!;
    await proc.cancel();
    const result = await proc.wait();
    expect(result.signal).toBe('SIGKILL');
    expect(abortCalled).toBe(true);
    // 进程确实消失（wait 之后再查会抛 ESRCH）
    let gone = false;
    try {
      process.kill(pid, 0);
    } catch {
      gone = true;
    }
    expect(gone).toBe(true);
    // 幂等：二次 cancel 不炸、立即 resolve
    await expect(proc.cancel()).resolves.toBeUndefined();
  });

  itPosix('onAbort 先于强杀：钩子内 SIGTERM 让进程自然退出（wait code 0）', async () => {
    const proc = runFixture('graceful-exit.mjs', {
      onAbort: () => {
        if (proc.pid !== undefined) process.kill(proc.pid, 'SIGTERM');
      },
    });
    for await (const ev of proc.events) {
      if (ev.type === 'line' && ev.text === 'ready') break;
    }
    await proc.cancel();
    const result = await proc.wait();
    expect(result.code).toBe(0); // 自然退出，没走到杀进程组
    expect(result.signal).toBeNull();
  });

  it('env 白名单：只透传基础白名单 + envWhitelist，delta 进程杂项不泄漏', async () => {
    const savedSecret = process.env.DELTA_TEST_SECRET;
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.DELTA_TEST_SECRET = 'should-not-leak';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      const proc = runFixture('env-dump.mjs', { envWhitelist: ['ANTHROPIC_API_KEY'] });
      const events = await collect(proc);
      const lines = linesOf(events);
      expect(lines).toHaveLength(1);
      const childEnv = JSON.parse(lines[0]) as Record<string, string>;
      // 白名单内的自定义变量放行
      expect(childEnv['ANTHROPIC_API_KEY']).toBe('sk-test');
      // 非白名单变量一律不出现
      expect(childEnv['DELTA_TEST_SECRET']).toBeUndefined();
      // 出现的键必须全部属于白名单（POSIX 额外允许 `_`）
      const allowed = new Set(['PATH', 'HOME', 'SHELL', 'LANG', 'TMPDIR', 'ANTHROPIC_API_KEY']);
      if (IS_POSIX) allowed.add('_');
      else for (const k of ['SystemRoot', 'COMPUTERNAME', 'USERNAME', 'PATHEXT']) allowed.add(k);
      if (process.platform === 'darwin') {
        // darwin 下 CoreFoundation 会向每个新起进程注入 __CF_USER_TEXT_ENCODING（OS 行为，非 env 透传）
        allowed.add('__CF_USER_TEXT_ENCODING');
      }
      for (const key of Object.keys(childEnv)) {
        expect(allowed.has(key), `意外的环境变量: ${key}`).toBe(true);
      }
    } finally {
      // 还原宿主环境，避免污染其他用例
      if (savedSecret === undefined) delete process.env.DELTA_TEST_SECRET;
      else process.env.DELTA_TEST_SECRET = savedSecret;
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  it('exit 后资源不悬挂：事件流在 100ms 内 done（流监听已移除）', async () => {
    const proc = runFixture('echo-lines.mjs');
    const iter = proc.events[Symbol.asyncIterator]();
    for (;;) {
      const r = await iter.next();
      if (r.done || r.value.type === 'exit') break;
    }
    const t0 = Date.now();
    const r = await iter.next();
    expect(r.done).toBe(true);
    expect(Date.now() - t0).toBeLessThan(100);
    await proc.wait();
  });
});
