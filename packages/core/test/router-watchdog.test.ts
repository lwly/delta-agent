/**
 * F-58 T2d：看门狗 L1/L2 单测（设计稿 §9、AC7）+ L3 标记接口。
 * 核心防回归：「L1 不得在 30 分钟处杀掉活着的 Worker」（§9.3，isRunning 坑）。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { WATCHDOG_L2C_SILENT_MS, isPathOutsideWorkRoot, watchdogTick } from '../src/router/watchdog.js';
import {
  cleanupAllDirs,
  createDispatcherEnv,
  preflightPass,
  type DispatcherEnv,
} from './helpers/fake-hub.js';

const envs: DispatcherEnv[] = [];

async function env(opts?: Parameters<typeof createDispatcherEnv>[0]): Promise<DispatcherEnv> {
  const e = await createDispatcherEnv({ preflight: preflightPass, ...opts });
  envs.push(e);
  return e;
}

afterEach(async () => {
  for (const e of envs.splice(0)) await e.dispose();
  await cleanupAllDirs();
});

/** 造一个 running 任务（内置 Worker，可伪造 started_at；默认进程存活） */
async function runningTask(e: DispatcherEnv, title = '任务', overrides?: { startedAt?: number }) {
  const t = e.dispatch({ title });
  await e.dispatcher.claimSlot();
  const row = e.dispatcher.workerTasks.get(t.id);
  const ws = row.worker_session_id!;
  e.hub.running.add(ws); // 模拟 hub 正在运行该 Worker（L1 视为存活）
  if (overrides?.startedAt !== undefined) {
    // started_at 由 transition 写入，测试用 DB 直改伪造「超 30 分钟」的伪起点
    e.svc.store.db
      .prepare('UPDATE worker_tasks SET started_at = ? WHERE id = ?')
      .run(overrides.startedAt, t.id);
  }
  return { t, ws };
}

describe('L1 存活兜底', () => {
  it('peekRunning===false 且 status=running → failed(runtime) + inbox batch（不 abort：进程已不在）', async () => {
    const e = await env();
    const { t, ws } = await runningTask(e, '死任务');
    e.hub.running.delete(ws); // 会话已死

    await watchdogTick(e.dispatcher);
    const row = e.dispatcher.workerTasks.get(t.id);
    expect(row.status).toBe('failed');
    expect(row.failure_kind).toBe('runtime');
    expect(e.hub.aborted).not.toContain(ws);
    const items = e.dispatcher.inbox.listUndelivered(e.routerId);
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe('batch');
  });

  it('防回归（§9.3 最贵的 bug）：started_at 超 31 分钟 + 进程活着 → 任务仍 running，running 表未清理、未推 run_error、未 abort', async () => {
    const e = await env();
    const { t, ws } = await runningTask(e, '长寿任务', { startedAt: Date.now() - 31 * 60_000 });
    e.hub.running.add(ws); // 进程活着（peekRunning 为真）

    await watchdogTick(e.dispatcher);
    const row = e.dispatcher.workerTasks.get(t.id);
    expect(row.status).toBe('running'); // 看门狗不杀
    expect(row.failure_kind).toBeNull();
    expect(e.hub.sends.filter((s) => s.sessionId === e.routerId || s.sessionId === ws)).toHaveLength(1); // 仅有 Worker 首发消息，未新增任何 run_error
    expect(e.hub.aborted).toHaveLength(0);
    expect(e.hub.isRunningCalls).toBe(0); // 全程未碰 isRunning（zombieReap 零触发）
    expect(e.dispatcher.inbox.listUndelivered(e.routerId)).toHaveLength(0);
  });

  it('running 行缺 worker_session_id（异常态）→ 按 L1 收敛', async () => {
    const e = await env();
    const t = e.dispatch();
    e.dispatcher.workerTasks.claimSlot(t.id);
    // 手工推到 running 但不写 worker_session_id（模拟异常数据）
    e.svc.store.db
      .prepare(`UPDATE worker_tasks SET status = 'running', started_at = ? WHERE id = ?`)
      .run(Date.now(), t.id);

    await watchdogTick(e.dispatcher);
    expect(e.dispatcher.workerTasks.get(t.id).status).toBe('failed');
  });
});

describe('L2a 路径越界（内置 Worker）', () => {
  function wdDeps(workRoot: string) {
    return {
      listFileChanges: (sessionId: string) => eChanges(sessionId),
      getWorkRoot: () => workRoot,
    };
  }
  // 用闭包装当前 env 的 changes store（在用例内赋值）
  let eChanges: (sessionId: string) => { path: string }[];

  it('写 work_root 之外 → hub.abort + failed(watchdog_l2) + inbox interrupt + 不重试（attempt 不变）', async () => {
    const e = await env();
    eChanges = (sessionId) => e.svc.changes.list(sessionId).map((r) => ({ path: r.path }));
    const { t, ws } = await runningTask(e, '越界任务');
    e.svc.changes.record(ws, { tool: 'write_file', path: '/etc/passwd', before: null, after: 'x' });

    await watchdogTick(e.dispatcher, wdDeps('/tmp/demo-f58-dispatcher'));
    const row = e.dispatcher.workerTasks.get(t.id);
    expect(row.status).toBe('failed');
    expect(row.failure_kind).toBe('watchdog_l2');
    expect(row.attempt).toBe(1); // 不重试：attempt 停在 claim 的值
    expect(e.hub.aborted).toContain(ws);
    const items = e.dispatcher.inbox.listUndelivered(e.routerId);
    expect(items[0]!.severity).toBe('interrupt');
    expect(items[0]!.kind).toBe('task_failed');
  });

  it('相对路径 ../ 越界同样命中；全部在界内 → 不处置', async () => {
    const e = await env();
    eChanges = (sessionId) => e.svc.changes.list(sessionId).map((r) => ({ path: r.path }));
    const { t, ws } = await runningTask(e, '守规矩任务');
    e.svc.changes.record(ws, { tool: 'write_file', path: 'src/a.ts', before: null, after: 'x' });
    e.svc.changes.record(ws, { tool: 'write_file', path: '../escape.txt', before: null, after: 'x' });

    await watchdogTick(e.dispatcher, wdDeps('/tmp/demo-f58-dispatcher'));
    expect(e.dispatcher.workerTasks.get(t.id).status).toBe('failed');
    expect(e.dispatcher.workerTasks.get(t.id).failure_kind).toBe('watchdog_l2');
  });

  it('全部在界内 → 不处置', async () => {
    const e = await env();
    eChanges = (sessionId) => e.svc.changes.list(sessionId).map((r) => ({ path: r.path }));
    const { t, ws } = await runningTask(e, '守规矩任务');
    e.svc.changes.record(ws, { tool: 'write_file', path: 'src/a.ts', before: null, after: 'x' });
    e.svc.changes.record(ws, { tool: 'write_file', path: 'docs/b.md', before: null, after: 'x' });

    await watchdogTick(e.dispatcher, wdDeps('/tmp/demo-f58-dispatcher'));
    expect(e.dispatcher.workerTasks.get(t.id).status).toBe('running');
    expect(e.hub.aborted).toHaveLength(0);
  });

  it('外部 Worker（executor 非 null）不适用 L2a（无 file_changes 落点，§9.1）', async () => {
    const e = await env();
    eChanges = (sessionId) => e.svc.changes.list(sessionId).map((r) => ({ path: r.path }));
    const t = e.dispatch({ title: '外部任务', executor: 'cli:codebuddy' });
    await e.dispatcher.claimSlot();
    const ws = e.dispatcher.workerTasks.get(t.id).worker_session_id!;
    e.hub.running.add(ws); // 进程存活（否则 L1 先收敛，轮不到 L2a 判定）
    e.svc.changes.record(ws, { tool: 'write_file', path: '/etc/passwd', before: null, after: 'x' });

    await watchdogTick(e.dispatcher, wdDeps('/tmp/demo-f58-dispatcher'));
    expect(e.dispatcher.workerTasks.get(t.id).status).toBe('running');
  });
});

describe('isPathOutsideWorkRoot（path.relative 判据，含 Windows 盘符大小写）', () => {
  it('POSIX', () => {
    expect(isPathOutsideWorkRoot('/repo', '/repo/src/a.ts')).toBe(false);
    expect(isPathOutsideWorkRoot('/repo', 'src/a.ts')).toBe(false); // 相对路径按界内 resolve
    expect(isPathOutsideWorkRoot('/repo', '../escape.txt')).toBe(true);
    expect(isPathOutsideWorkRoot('/repo', '/etc/passwd')).toBe(true);
    expect(isPathOutsideWorkRoot('/repo', '/repoEvil/x')).toBe(true); // startsWith 会漏判的前缀陷阱
    expect(isPathOutsideWorkRoot('/repo', '/repo')).toBe(false);
  });

  it('Windows 盘符大小写与分隔符（path.win32 纯 JS，任意宿主可判）', () => {
    expect(isPathOutsideWorkRoot('C:\\repo', 'c:\\repo\\a.txt')).toBe(false); // 盘符大小写不误判
    expect(isPathOutsideWorkRoot('C:\\repo', 'C:\\repo\\sub\\b.txt')).toBe(false);
    expect(isPathOutsideWorkRoot('C:\\repo', 'C:\\repoEvil\\x')).toBe(true);
    expect(isPathOutsideWorkRoot('C:\\repo', 'D:\\other\\x')).toBe(true); // 跨盘符必越界
    expect(isPathOutsideWorkRoot('C:\\repo', 'c:\\repo\\..\\escape.txt')).toBe(true);
  });
});

describe('L2c 静默（≥20 分钟无 AgentEvent；阈值 <30min 避开 zombieReap）', () => {
  it('最后事件距今 ≥20min → abort + failed(watchdog_l2) + interrupt', async () => {
    const e = await env();
    // 静默时长 = now - max(started_at, 最后事件)，起点也必须 ≥20min 前才可能静默 20min
    const { t, ws } = await runningTask(e, '静默任务', { startedAt: Date.now() - 21 * 60_000 });
    await watchdogTick(e.dispatcher, {
      lastEventAt: () => Date.now() - WATCHDOG_L2C_SILENT_MS - 1000,
    });
    const row = e.dispatcher.workerTasks.get(t.id);
    expect(row.status).toBe('failed');
    expect(row.failure_kind).toBe('watchdog_l2');
    expect(e.hub.aborted).toContain(ws);
  });

  it('事件仍在流动 → 不处置（补齐「长寿但活跃」的对照）', async () => {
    const e = await env();
    const { t } = await runningTask(e, '活跃任务', { startedAt: Date.now() - 31 * 60_000 });
    await watchdogTick(e.dispatcher, { lastEventAt: () => Date.now() - 5_000 });
    expect(e.dispatcher.workerTasks.get(t.id).status).toBe('running');
  });

  it('未注入 lastEventAt（无法观察事件流）→ 跳过 L2c，不误杀', async () => {
    const e = await env();
    const { t } = await runningTask(e, '无观察任务', { startedAt: Date.now() - 25 * 60_000 });
    await watchdogTick(e.dispatcher, {});
    expect(e.dispatcher.workerTasks.get(t.id).status).toBe('running');
  });
});

describe('L3 标记接口（P0 只落标记）', () => {
  it('markSuspect → watchdog_flag=suspect + silent inbox；状态不变', async () => {
    const e = await env();
    const { t } = await runningTask(e, '存疑任务');
    e.dispatcher.markSuspect(t.id);

    const row = e.dispatcher.workerTasks.get(t.id);
    expect(row.status).toBe('running');
    expect(row.watchdog_flag).toBe('suspect');
    const items = e.dispatcher.inbox.listUndelivered(e.routerId);
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe('silent');
  });

  it('重复标记幂等（不叠加 inbox 条目）', async () => {
    const e = await env();
    const { t } = await runningTask(e, '存疑任务');
    e.dispatcher.markSuspect(t.id);
    e.dispatcher.markSuspect(t.id);
    expect(e.dispatcher.inbox.listUndelivered(e.routerId)).toHaveLength(1);
  });
});

describe('tick 集成（看门狗与播报共用 60s tick）', () => {
  it('tick 内跑看门狗：死会话被 L1 收敛', async () => {
    const e = await env();
    const { t, ws } = await runningTask(e, '死任务');
    e.hub.running.delete(ws);
    await e.dispatcher.tick();
    expect(e.dispatcher.workerTasks.get(t.id).status).toBe('failed');
  });
});
