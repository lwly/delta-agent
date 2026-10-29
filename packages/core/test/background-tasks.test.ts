import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BackgroundTaskManager, MAX_FINISHED_PER_SESSION } from '../src/session/background-tasks.js';

// 后台任务走真实 shell spawn（同 shell.test.ts 口径）；win32 的 PowerShell 分支
// 由 shell.test.ts 单独覆盖，这里聚焦任务生命周期语义。
const isWin = process.platform === 'win32';
const tmpDir = () => mkdtempSync(path.join(os.tmpdir(), 'delta-bg-'));

describe('BackgroundTaskManager (F-54)', () => {
  it.skipIf(isWin)('start 立即返回 id，命令后台完成状态收敛 done', async () => {
    const mgr = new BackgroundTaskManager();
    const id = mgr.start('s1', 'echo bg-hello', tmpDir());
    expect(id).toMatch(/^bg_/);

    const running = mgr.list('s1').find((t) => t.id === id);
    expect(running).toBeTruthy();

    // 轮询等完成（echo 秒级）
    let view = mgr.list('s1').find((t) => t.id === id)!;
    for (let i = 0; i < 50 && view.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      view = mgr.list('s1').find((t) => t.id === id)!;
    }
    expect(view.status).toBe('done');
    expect(view.exit_code).toBe(0);
    expect(view.finished_at).toBeGreaterThan(view.started_at);

    const out = mgr.getOutput(id)!;
    expect(out.status).toBe('done');
    expect(out.output).toContain('bg-hello');
  });

  it.skipIf(isWin)('kill 终止运行中任务 → killed；kill 二次返回 false', async () => {
    const mgr = new BackgroundTaskManager();
    const id = mgr.start('s1', 'sleep 30', tmpDir());
    expect(mgr.kill('s1', id)).toBe(true);

    let view = mgr.list('s1').find((t) => t.id === id)!;
    for (let i = 0; i < 50 && view.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      view = mgr.list('s1').find((t) => t.id === id)!;
    }
    expect(view.status).toBe('killed');
    expect(mgr.kill('s1', id)).toBe(false);
  });

  it.skipIf(isWin)('kill 跨会话 id 拒绝；list 按会话过滤', async () => {
    const mgr = new BackgroundTaskManager();
    const id = mgr.start('s1', 'sleep 30', tmpDir());
    expect(mgr.kill('s2', id)).toBe(false);
    expect(mgr.list('s2')).toHaveLength(0);
    expect(mgr.list('s1').map((t) => t.id)).toContain(id);
    expect(mgr.killAll()).toBeUndefined();
  });

  it.skipIf(isWin)('description 缺省取命令前 60 字符', () => {
    const mgr = new BackgroundTaskManager();
    const longCmd = `echo ${'x'.repeat(100)}`;
    const id = mgr.start('s1', longCmd, tmpDir());
    const view = mgr.list('s1').find((t) => t.id === id)!;
    expect(view.description).toBe(longCmd.slice(0, 60));
    mgr.killAll();
  });

  it.skipIf(isWin)('每会话已完成记录封顶，最旧淘汰，运行中不受影响', async () => {
    const mgr = new BackgroundTaskManager();
    const longId = mgr.start('s1', 'sleep 30', tmpDir());
    const ids: string[] = [];
    for (let i = 0; i < MAX_FINISHED_PER_SESSION + 2; i++) {
      ids.push(mgr.start('s1', 'echo prune-test', tmpDir()));
    }
    // 等全部完成
    for (let i = 0; i < 100; i++) {
      const runningCount = mgr.list('s1').filter((t) => t.status === 'running' && t.id !== longId).length;
      if (runningCount === 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const finished = mgr.list('s1').filter((t) => t.status !== 'running');
    expect(finished.length).toBeLessThanOrEqual(MAX_FINISHED_PER_SESSION);
    // 恰好淘汰最早完成的 2 条（spawn 顺序 ≠ 完成顺序，按“被淘汰个数”断言而非具体 id）
    const prunedCount = ids.filter((id) => mgr.getOutput(id) === undefined).length;
    expect(prunedCount).toBe(2);
    // 运行中的不受影响
    expect(mgr.list('s1').find((t) => t.id === longId)?.status).toBe('running');
    mgr.killAll();
  });
});
