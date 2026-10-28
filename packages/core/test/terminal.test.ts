/**
 * F-47 终端管理层单测（Fake pty，不依赖 node-pty 原生模块）。
 * 断言基准：docs/design-f41-f53-next-round.md F-47 节（D3 生命周期 / D5 安全口径）。
 */
import { describe, expect, it, vi } from 'vitest';
import { TerminalManager, type TerminalManagerDeps } from '../src/server/terminal.js';
import type { WebSocket } from 'ws';

/** Fake pty：记录 write/resize/kill，可手动注入 output / exit */
class FakePty {
  written: string[] = [];
  resized: Array<{ cols: number; rows: number }> = [];
  killed = false;
  pid = 424242;
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number }) => void) | null = null;
  write(d: string) {
    this.written.push(d);
  }
  resize(cols: number, rows: number) {
    this.resized.push({ cols, rows });
  }
  kill() {
    this.killed = true;
    this.exitCb?.({ exitCode: 0 });
  }
  onData(cb: (d: string) => void) {
    this.dataCb = cb;
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCb = cb;
  }
  emitData(d: string) {
    this.dataCb?.(d);
  }
  emitExit(code = 0) {
    this.exitCb?.({ exitCode: code });
  }
}

/** Fake WebSocket：捕获发送帧 */
function fakeWs(): WebSocket & { frames: Array<Record<string, unknown>> } {
  const frames: Array<Record<string, unknown>> = [];
  return {
    frames,
    readyState: 1,
    send: (raw: unknown) => frames.push(JSON.parse(String(raw)) as Record<string, unknown>),
    close: () => undefined,
    on: (() => undefined) as never,
  } as never;
}

function makeManager(over: Partial<TerminalManagerDeps> = {}) {
  const spawneds: FakePty[] = [];
  const ptyModule = {
    spawn(_file: string, _args: string[], opts: { cwd: string }) {
      const p = new FakePty();
      (p as unknown as { cwd: string }).cwd = opts.cwd;
      spawneds.push(p);
      return p as never;
    },
  };
  const mgr = new TerminalManager({
    resolveWorkRoot: (sid) => `/tmp/workroot-${sid}`,
    maxSessions: 2,
    pty: ptyModule as never,
    ...over,
  });
  return { mgr, spawneds };
}

describe('TerminalManager', () => {
  it('create：pty 以会话工作根为 cwd 启动，返回 id/workRoot/shell', async () => {
    const { mgr, spawneds } = makeManager();
    const r = await mgr.create('sess-1');
    expect(r.ok).toBe(true);
    expect(r.terminalId).toMatch(/^tty_sess-1_/);
    expect(r.workRoot).toBe('/tmp/workroot-sess-1');
    expect((spawneds[0] as unknown as { cwd: string }).cwd).toBe('/tmp/workroot-sess-1');
    expect(r.shell).toBeTruthy();
  });

  it('attach：ready 帧带 workRoot + 环形缓冲回放；output 推送到连接', async () => {
    const { mgr, spawneds } = makeManager();
    const r = await mgr.create('sess-1');
    spawneds[0]!.emitData('hello ');
    spawneds[0]!.emitData('world');
    const ws = fakeWs();
    mgr.attach(r.terminalId!, ws as unknown as WebSocket);
    expect(ws.frames[0]).toMatchObject({ type: 'ready', workRoot: '/tmp/workroot-sess-1' });
    expect(ws.frames[1]).toMatchObject({ type: 'output', data: 'hello world' });
    // 后续输出实时推送
    spawneds[0]!.emitData('!');
    expect(ws.frames.at(-1)).toMatchObject({ type: 'output', data: '!' });
  });

  it('handleClientMessage：input 转发 pty.write；resize 越界钳制', async () => {
    const { mgr, spawneds } = makeManager();
    const r = await mgr.create('sess-1');
    mgr.handleClientMessage(r.terminalId!, JSON.stringify({ type: 'input', data: 'ls\r' }));
    expect(spawneds[0]!.written).toEqual(['ls\r']);
    mgr.handleClientMessage(r.terminalId!, JSON.stringify({ type: 'resize', cols: 9999, rows: 0 }));
    expect(spawneds[0]!.resized.at(-1)).toEqual({ cols: 500, rows: 2 });
    // 非 JSON 帧不炸
    mgr.handleClientMessage(r.terminalId!, 'garbage');
  });

  it('pty 退出 → 会话移除 + exit 帧通知；后续 attach 得到明确错误', async () => {
    const { mgr, spawneds } = makeManager();
    const r = await mgr.create('sess-1');
    const ws = fakeWs();
    mgr.attach(r.terminalId!, ws as unknown as WebSocket);
    spawneds[0]!.emitExit(3);
    expect(mgr.close(r.terminalId!)).toBe(false); // 已移除
    const ws2 = fakeWs();
    mgr.attach(r.terminalId!, ws2 as unknown as WebSocket);
    expect(ws2.frames[0]).toMatchObject({ type: 'error', message: '终端会话不存在或已退出' });
  });

  it('并发上限：达到 maxSessions 后 create 拒绝并给出原因', async () => {
    const { mgr } = makeManager();
    await mgr.create('a');
    await mgr.create('b');
    const r = await mgr.create('c');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('上限');
    const st = await mgr.status();
    expect(st).toMatchObject({ available: false, active: 2, max: 2 });
  });

  it('用户主动 close：杀 pty 并移除；killAll 清空全部', async () => {
    const { mgr, spawneds } = makeManager();
    const r1 = await mgr.create('a');
    const r2 = await mgr.create('b');
    expect(mgr.close(r1.terminalId!)).toBe(true);
    expect(spawneds[0]!.killed).toBe(true);
    mgr.killAll();
    expect(spawneds[1]!.killed).toBe(true);
    expect((await mgr.status()).active).toBe(0);
  });

  it('无 pty 注入（能力不可用）→ create/status 明确降级', async () => {
    const mgr = new TerminalManager({ resolveWorkRoot: () => '/tmp/x', pty: null });
    const st = await mgr.status();
    expect(st.available).toBe(false);
    expect(st.reason).toBeTruthy();
    const r = await mgr.create('sess-1');
    expect(r.ok).toBe(false);
  });

  it('空闲回收：超过 idleMs 且未连接的 pty 被回收（vi.useFakeTimers）', async () => {
    vi.useFakeTimers();
    try {
      const { mgr, spawneds } = makeManager({ idleMs: 1_000 });
      const r = await mgr.create('a');
      await vi.advanceTimersByTimeAsync(61_000);
      expect(spawneds[0]!.killed).toBe(true);
      void r;
    } finally {
      vi.useRealTimers();
    }
  });
});
