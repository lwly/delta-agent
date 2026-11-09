/**
 * F-58 任务台 store 行为测试（无 DOM、无后端：mock api/client，node 环境可跑）。
 * 结构对齐 bgTasks.test.ts（F-54 既有惯例）。
 *
 * 覆盖：
 * - watch(null/'') 不发请求、清空旧状态；同项目重复 watch 幂等
 * - interruptCount 只数未送达 interrupt（needs_decision / L2 kill → 红点，AC8 Web 侧）
 * - 项目切换：旧项目的过期响应被丢弃（不串台）
 * - 裁决成功后立即 refresh（不等下一轮轮询）
 * - 红线：无乐观更新——裁决端点失败时列表保持原样（decide 向上抛）
 * - cancel 失败静默、仍刷新对齐服务端真值
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const mocks = vi.hoisted(() => ({
  listWorkerTasks: vi.fn(),
  listUndeliveredInbox: vi.fn(),
  decideWorkerTask: vi.fn(),
  cancelWorkerTask: vi.fn(),
  createWorkerTask: vi.fn(),
  connectActivityStream: vi.fn(),
}));

vi.mock('../api/client', () => ({ api: mocks }));
// T5b：activity SSE 连接在 store 测试中 mock（不触网）；用例通过捕获回调模拟连接状态切换
vi.mock('../composables/useActivityStream', () => ({
  connectActivityStream: mocks.connectActivityStream,
}));

import { ACTIVITY_IDLE_INTERVAL_MS, POLL_INTERVAL_MS, useTasksStore } from './tasks';

const task = (id: string, status: string, project = 'p1') => ({
  id,
  project_id: project,
  router_session_id: 'r1',
  title: `任务 ${id}`,
  goal: `goal-${id}`,
  acceptance: null,
  role_label: null,
  executor: null,
  permission_mode: 'default',
  status,
  priority: 0,
  depends_on: [],
  artifacts: [],
  worker_session_id: null,
  result_summary: null,
  failure_kind: null,
  decision: null,
  watchdog_flag: null,
  attempt: 0,
  created_at: Date.now() - 60_000,
  started_at: status === 'running' ? Date.now() - 60_000 : null,
  finished_at: ['done', 'failed', 'canceled'].includes(status) ? Date.now() : null,
  updated_at: Date.now(),
});

const inboxItem = (id: number, severity: string, task_id: string | null = null) => ({
  id,
  router_session_id: 'r1',
  task_id,
  kind: severity === 'interrupt' ? 'needs_decision' : 'digest',
  severity,
  payload: {},
  created_at: Date.now(),
  delivered_at: null,
  ack_at: null,
});

/** 推进 n 轮轮询（含微任务冲洗），避免 runAllTimersAsync 与 interval 死循环 */
const advance = (rounds = 1) => vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * rounds);

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  mocks.listWorkerTasks.mockReset();
  mocks.listUndeliveredInbox.mockReset();
  mocks.decideWorkerTask.mockReset();
  mocks.cancelWorkerTask.mockReset();
  mocks.createWorkerTask.mockReset();
  mocks.connectActivityStream.mockReset();
  mocks.listWorkerTasks.mockResolvedValue({ tasks: [] });
  mocks.listUndeliveredInbox.mockResolvedValue({ items: [] });
  // T5b：默认空句柄（未连接 → 轮询保持 2s 基础间隔）
  mocks.connectActivityStream.mockReturnValue({ disconnect: () => undefined });
});

afterEach(async () => {
  useTasksStore().stop(); // 防 interval 泄漏到下一个用例
  vi.useRealTimers();
});

describe('tasks store (F-58 任务台)', () => {
  it("watch(null/'') 不发请求；同项目重复 watch 幂等", async () => {
    const s = useTasksStore();
    s.watch(null);
    s.watch('');
    expect(mocks.listWorkerTasks).not.toHaveBeenCalled();

    s.watch('p1');
    s.watch('p1');
    await advance(2);
    expect(s.projectId).toBe('p1');
    s.watch(null);
    expect(s.tasks).toHaveLength(0);
    expect(s.inbox).toHaveLength(0);
    // 每轮都是 tasks + inbox 两个请求
    expect(mocks.listWorkerTasks.mock.calls.every((c) => c.length === 1)).toBe(true);
  });

  it('interruptCount 只数未送达 interrupt（silent/batch 不计入红点）', async () => {
    const s = useTasksStore();
    mocks.listWorkerTasks.mockResolvedValue({ tasks: [task('a', 'needs_decision')] });
    mocks.listUndeliveredInbox.mockResolvedValue({
      items: [inboxItem(1, 'silent'), inboxItem(2, 'batch'), inboxItem(3, 'interrupt'), inboxItem(4, 'interrupt')],
    });
    s.watch('p1');
    await advance();
    expect(s.tasks).toHaveLength(1);
    expect(s.inbox).toHaveLength(4);
    expect(s.interruptCount).toBe(2);
    expect(s.pendingDecision.map((t) => t.id)).toEqual(['a']);
  });

  it('项目切换后旧响应被丢弃（不串台）', async () => {
    const s = useTasksStore();
    let resolveP1!: (v: unknown) => void;
    let resolveInboxP1!: (v: unknown) => void;
    mocks.listWorkerTasks.mockImplementationOnce(() => new Promise((r) => (resolveP1 = r)));
    mocks.listUndeliveredInbox.mockImplementationOnce(() => new Promise((r) => (resolveInboxP1 = r)));
    s.watch('p1');
    // 未等 p1 响应返回就切项目
    mocks.listWorkerTasks.mockResolvedValue({ tasks: [task('z', 'running', 'p2')] });
    mocks.listUndeliveredInbox.mockResolvedValue({ items: [] });
    s.watch('p2');
    resolveP1([task('a', 'running')]);
    resolveInboxP1([inboxItem(9, 'interrupt')]);
    await advance();
    expect(s.tasks.map((t) => t.id)).toEqual(['z']);
    expect(s.interruptCount).toBe(0);
    s.watch(null);
  });

  it('裁决成功后立即 refresh（不等下一轮轮询）', async () => {
    const s = useTasksStore();
    mocks.listWorkerTasks.mockResolvedValue({ tasks: [task('a', 'needs_decision')] });
    s.watch('p1');
    await advance();
    expect(s.tasks[0]!.status).toBe('needs_decision');

    mocks.listWorkerTasks.mockResolvedValue({ tasks: [task('a', 'canceled')] });
    mocks.decideWorkerTask.mockResolvedValue({ task: task('a', 'canceled') });
    await s.decide('a', 'cancel');
    expect(mocks.decideWorkerTask).toHaveBeenCalledWith('a', 'cancel');
    // 端点成功后才 refresh，且列表取到刷新结果
    expect(s.tasks[0]!.status).toBe('canceled');
    s.watch(null);
  });

  it('红线：无乐观更新——裁决失败时列表保持原样（decide 向上抛错）', async () => {
    const s = useTasksStore();
    mocks.listWorkerTasks.mockResolvedValue({ tasks: [task('a', 'needs_decision')] });
    s.watch('p1');
    await advance();

    mocks.decideWorkerTask.mockRejectedValue(new Error('HTTP 409'));
    await expect(s.decide('a', 'retry')).rejects.toThrow('HTTP 409');
    // 列表未被乐观改动，仍是服务端真值
    expect(s.tasks).toHaveLength(1);
    expect(s.tasks[0]!.status).toBe('needs_decision');
    s.watch(null);
  });

  it('cancel 失败静默、仍 refresh 对齐服务端真值', async () => {
    const s = useTasksStore();
    mocks.listWorkerTasks.mockResolvedValue({ tasks: [task('a', 'running')] });
    s.watch('p1');
    await advance();

    mocks.cancelWorkerTask.mockRejectedValue(new Error('HTTP 404'));
    mocks.listWorkerTasks.mockResolvedValue({ tasks: [task('a', 'canceled')] });
    await s.cancel('a');
    expect(mocks.cancelWorkerTask).toHaveBeenCalledWith('a');
    expect(s.tasks[0]!.status).toBe('canceled');
    s.watch(null);
  });

  it('refresh 失败（501 等）静默保持现状，下轮重试', async () => {
    const s = useTasksStore();
    mocks.listWorkerTasks.mockResolvedValue({ tasks: [task('a', 'running')] });
    s.watch('p1');
    await advance();
    expect(s.tasks).toHaveLength(1);

    mocks.listWorkerTasks.mockRejectedValue(new Error('HTTP 501'));
    mocks.listUndeliveredInbox.mockRejectedValue(new Error('HTTP 501'));
    await s.refresh();
    expect(s.tasks).toHaveLength(1);
    s.watch(null);
  });

  // ── 轻首页委派式工作台：分组 getter / 面板状态 / dispatch action ──

  it('groups 按「需要你 / 处理中 / 已完成」三组分组', async () => {
    const s = useTasksStore();
    mocks.listWorkerTasks.mockResolvedValue({
      tasks: [
        task('d', 'done'),
        task('n', 'needs_decision'),
        task('q', 'queued'),
        task('r', 'running'),
        task('f', 'failed'),
        task('pf', 'preflight'),
        task('c', 'canceled'),
      ],
    });
    s.watch('p1');
    await advance();
    expect(s.groups.needYou.map((t) => t.id)).toEqual(['n']);
    expect(s.groups.active.map((t) => t.id)).toEqual(['q', 'r', 'pf']);
    expect(s.groups.finished.map((t) => t.id)).toEqual(['d', 'f', 'c']);
    s.watch(null);
  });

  it('openTaskPanel / openTask：面板状态跟随轮询刷新的最新任务行', async () => {
    const s = useTasksStore();
    mocks.listWorkerTasks.mockResolvedValue({ tasks: [task('a', 'running')] });
    s.watch('p1');
    await advance();
    s.openTaskPanel('a');
    expect(s.openTask?.id).toBe('a');
    // 轮询刷新后 openTask 跟随最新行（状态变化可见）
    mocks.listWorkerTasks.mockResolvedValue({ tasks: [task('a', 'done')] });
    await advance();
    expect(s.openTask?.id).toBe('a');
    expect(s.openTask?.status).toBe('done');
    // 关闭面板
    s.openTaskPanel(null);
    expect(s.openTaskId).toBeNull();
    expect(s.openTask).toBeNull();
    s.watch(null);
  });

  it('dispatch：goal 收敛 title、透传 executor / dispatch:true，成功后刷新列表', async () => {
    const s = useTasksStore();
    s.watch('p1'); // dispatch 后的 refresh 依赖项目上下文（与首页 watch 接线一致）
    mocks.createWorkerTask.mockResolvedValue({ task: task('new1', 'queued') });
    const created = await s.dispatch('p1', { goal: '做一个 ppt\n要求 10 页', executor: 'cli:codebuddy' });
    expect(created.id).toBe('new1');
    expect(mocks.createWorkerTask).toHaveBeenCalledWith('p1', {
      title: '做一个 ppt',
      goal: '做一个 ppt\n要求 10 页',
      executor: 'cli:codebuddy',
      permission_mode: 'default',
      dispatch: true,
    });
    // dispatch 内部已 refresh
    expect(mocks.listWorkerTasks).toHaveBeenCalled();
    // 空内容拒绝派单
    await expect(s.dispatch('p1', { goal: '   ' })).rejects.toThrow('任务内容为空');
    expect(mocks.createWorkerTask).toHaveBeenCalledTimes(1);
  });

  it('dispatch 失败向上抛（调用方 toast），不吞错', async () => {
    const s = useTasksStore();
    mocks.createWorkerTask.mockRejectedValue(new Error('HTTP 400'));
    await expect(s.dispatch('p1', { goal: 'x' })).rejects.toThrow('HTTP 400');
  });

  it('stop 清空 openTaskId（面板状态不跨项目泄漏）', async () => {
    const s = useTasksStore();
    mocks.listWorkerTasks.mockResolvedValue({ tasks: [task('a', 'running')] });
    s.watch('p1');
    await advance();
    s.openTaskPanel('a');
    s.watch(null); // watch(null) 内部走 stop
    expect(s.openTaskId).toBeNull();
  });
});

describe('tasks store (T5b：activity SSE 降级与即时刷新)', () => {
  it('watch 后订阅 activity stream（同 id）；activity_changed 立即刷新', async () => {
    const s = useTasksStore();
    let onActivity: (() => void) | undefined;
    mocks.connectActivityStream.mockImplementation((_pid: string, cb: () => void) => {
      onActivity = cb;
      return { disconnect: () => undefined };
    });
    mocks.listWorkerTasks.mockResolvedValue({ tasks: [task('a', 'running')] });
    s.watch('p1');
    await advance();
    expect(mocks.connectActivityStream).toHaveBeenCalledWith('p1', expect.any(Function), expect.any(Function));
    const baseCalls = mocks.listWorkerTasks.mock.calls.length;
    onActivity?.(); // activity_changed：立即刷新，不等下一轮
    await advance(0);
    expect(mocks.listWorkerTasks.mock.calls.length).toBeGreaterThan(baseCalls);
    s.watch(null);
  });

  it('SSE 在线 → 轮询放宽 10s；断线 → 自动回 2s', async () => {
    const s = useTasksStore();
    let onConn: ((connected: boolean) => void) | undefined;
    mocks.connectActivityStream.mockImplementation((_pid: string, _a: () => void, cb: (c: boolean) => void) => {
      onConn = cb;
      return { disconnect: () => undefined };
    });
    s.watch('p1');
    await advance();
    // 未连接：2s 口径（POLL_INTERVAL_MS 节奏）
    const c1 = mocks.listWorkerTasks.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(mocks.listWorkerTasks.mock.calls.length).toBe(c1 + 3);
    // 在线：10s 口径（10s 内只 1 轮）
    onConn?.(true);
    const c2 = mocks.listWorkerTasks.mock.calls.length;
    await vi.advanceTimersByTimeAsync(ACTIVITY_IDLE_INTERVAL_MS);
    expect(mocks.listWorkerTasks.mock.calls.length).toBe(c2 + 1);
    // 断线：回 2s（10s 内 5 轮）
    onConn?.(false);
    const c3 = mocks.listWorkerTasks.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
    expect(mocks.listWorkerTasks.mock.calls.length).toBe(c3 + 5);
    s.watch(null);
  });

  it('stop 时断开 activity 订阅', async () => {
    const s = useTasksStore();
    const disconnect = vi.fn();
    mocks.connectActivityStream.mockReturnValue({ disconnect });
    s.watch('p1');
    s.watch(null);
    expect(disconnect).toHaveBeenCalled();
    expect(mocks.connectActivityStream).toHaveBeenCalledTimes(1); // watch(null) 不订阅
  });
});
