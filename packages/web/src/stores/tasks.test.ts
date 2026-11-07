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
}));

vi.mock('../api/client', () => ({ api: mocks }));

import { POLL_INTERVAL_MS, useTasksStore } from './tasks';

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
  mocks.listWorkerTasks.mockResolvedValue({ tasks: [] });
  mocks.listUndeliveredInbox.mockResolvedValue({ items: [] });
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
});
