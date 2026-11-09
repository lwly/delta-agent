/**
 * F-54 后台任务 store 行为测试（无 DOM、无后端：mock api/client，node 环境可跑）。
 *
 * 覆盖：
 * - runningCount 只数 running（done/failed/killed 不计入胶囊数字）
 * - watch('') 与 watch(null) 等价：不发请求、清空旧状态
 * - 会话切换：旧会话的过期响应被丢弃（不串台）
 * - kill 成功后立即刷新（不等下一轮轮询）
 * - refresh 失败（501 等）静默保持现状
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const mocks = vi.hoisted(() => ({
  backgroundTasks: vi.fn(),
  killBackgroundTask: vi.fn(),
  connectActivityStream: vi.fn(),
}));

vi.mock('../api/client', () => ({ api: mocks }));
// T5b：activity SSE 连接 mock（bgTasks 无项目上下文时不订阅；此处防触网）
vi.mock('../composables/useActivityStream', () => ({
  connectActivityStream: mocks.connectActivityStream,
}));

import { ACTIVITY_IDLE_INTERVAL_MS, POLL_INTERVAL_MS, useBgTasksStore } from './bgTasks';
import { useWorkspaceStore } from './workspace';

const task = (id: string, status: string, session = 's1') => ({
  id,
  session_id: session,
  command: `cmd-${id}`,
  description: `任务 ${id}`,
  started_at: Date.now() - 60_000,
  finished_at: status === 'running' ? null : Date.now(),
  status,
  exit_code: status === 'done' ? 0 : null,
});

/** 推进 n 轮轮询（含微任务冲洗），避免 runAllTimersAsync 与 interval 死循环 */
const advance = (rounds = 1) => vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * rounds);

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  mocks.backgroundTasks.mockReset();
  mocks.killBackgroundTask.mockReset();
  mocks.connectActivityStream.mockReset();
  mocks.connectActivityStream.mockReturnValue({ disconnect: () => undefined });
});

afterEach(async () => {
  useBgTasksStore().stop(); // 防 interval 泄漏到下一个用例
  vi.useRealTimers();
});

describe('bgTasks store (F-54)', () => {
  it("watch(null/'') 不发请求；同会话重复 watch 幂等", async () => {
    const s = useBgTasksStore();
    s.watch(null);
    s.watch('');
    expect(mocks.backgroundTasks).not.toHaveBeenCalled();

    mocks.backgroundTasks.mockResolvedValue([]);
    s.watch('s1');
    s.watch('s1');
    await advance(2);
    expect(s.sessionId).toBe('s1');
    s.watch(null);
    expect(s.tasks).toHaveLength(0);
    expect(mocks.backgroundTasks.mock.calls.every((c) => c.length === 1)).toBe(true);
  });

  it('runningCount 只数 running', async () => {
    const s = useBgTasksStore();
    mocks.backgroundTasks.mockResolvedValue([
      task('a', 'running'),
      task('b', 'running'),
      task('c', 'done'),
      task('d', 'killed'),
    ]);
    s.watch('s1');
    await advance();
    expect(s.tasks).toHaveLength(4);
    expect(s.runningCount).toBe(2);
  });

  it('kill 后立即刷新；刷新失败保持现状', async () => {
    const s = useBgTasksStore();
    mocks.backgroundTasks.mockResolvedValue([task('a', 'running')]);
    s.watch('s1');
    await advance(0);
    expect(s.runningCount).toBe(1);

    mocks.killBackgroundTask.mockResolvedValue({ ok: true });
    mocks.backgroundTasks.mockResolvedValue([task('a', 'killed')]);
    await s.kill('a');
    expect(mocks.killBackgroundTask).toHaveBeenCalledWith('s1', 'a');
    expect(s.runningCount).toBe(0);

    // 后续刷新失败 → 保持现状不炸
    mocks.backgroundTasks.mockRejectedValue(new Error('HTTP 501'));
    await s.refresh();
    expect(s.tasks).toHaveLength(1);
    s.watch(null);
  });

  it('会话切换后旧响应被丢弃（不串台）', async () => {
    const s = useBgTasksStore();
    let resolveA!: (v: unknown) => void;
    mocks.backgroundTasks.mockImplementationOnce(() => new Promise((r) => (resolveA = r)));
    s.watch('s1');
    // 未等 s1 响应返回就切会话
    mocks.backgroundTasks.mockResolvedValue([task('z', 'running', 's2')]);
    s.watch('s2');
    resolveA([task('a', 'running')]);
    await advance();
    expect(s.tasks.map((t) => t.id)).toEqual(['z']);
    s.watch(null);
  });

  it('toggle 展开收起；stop 重置 expanded', () => {
    const s = useBgTasksStore();
    s.toggle();
    expect(s.expanded).toBe(true);
    s.stop();
    expect(s.expanded).toBe(false);
  });
});

describe('bgTasks store (T5b：activity 订阅口径)', () => {
  it('无项目上下文（activeProjectId 为空）时不订阅 activity', async () => {
    const s = useBgTasksStore();
    mocks.backgroundTasks.mockResolvedValue([]);
    s.watch('s1');
    await advance();
    expect(mocks.backgroundTasks).toHaveBeenCalled();
    expect(mocks.connectActivityStream).not.toHaveBeenCalled();
    s.watch(null);
  });

  it('有项目上下文时按项目订阅 activity（轮询降级由回调驱动）', async () => {
    const ws = useWorkspaceStore();
    ws.activeProjectId = 'p-ws';
    const s = useBgTasksStore();
    let onConn: ((connected: boolean) => void) | undefined;
    mocks.connectActivityStream.mockImplementation((pid: string, _a: () => void, cb: (c: boolean) => void) => {
      expect(pid).toBe('p-ws');
      onConn = cb;
      return { disconnect: () => undefined };
    });
    mocks.backgroundTasks.mockResolvedValue([]);
    s.watch('s1');
    await advance();
    expect(mocks.connectActivityStream).toHaveBeenCalledTimes(1);
    // 在线 → 10s；10s 内只 1 轮
    onConn?.(true);
    const c1 = mocks.backgroundTasks.mock.calls.length;
    await vi.advanceTimersByTimeAsync(ACTIVITY_IDLE_INTERVAL_MS);
    expect(mocks.backgroundTasks.mock.calls.length).toBe(c1 + 1);
    // stop 断开订阅
    s.watch(null);
    s.stop();
    expect(mocks.connectActivityStream).toHaveBeenCalledTimes(1);
  });
});
