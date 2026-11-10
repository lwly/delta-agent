/**
 * workspace store 项目徽标数量（session_count）刷新行为测试（无 DOM、无后端：mock api/client）
 *
 * 缺陷回归：侧栏项目组的会话数量徽标来自 /api/projects 快照（`p.session_count`），
 * 但 createSession / removeSession 此前只刷新会话列表不刷新 projects——
 * 新建会话徽标不 +1、删除不 -1，停在进入页面时的旧值。
 * 修复：两个动作在刷新会话列表的同时并行刷新 projects。
 *
 * 测试模式与 filePanel.test.ts 一致：Pinia + mock api，node 环境可跑（零新增依赖）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listSessionsPage: vi.fn(),
  createSession: vi.fn(),
  removeSession: vi.fn(),
  runningSessions: vi.fn(),
  listTrash: vi.fn(),
}));

vi.mock('../api/client', () => ({ api: mocks }));

import { useWorkspaceStore } from './workspace';
import { useChatStore } from './chat';

const P1 = { id: 'p-1', name: 'delta-agent', root_path: '/tmp/p1', session_count: 0 };

function sessionRow(id: string) {
  return {
    id,
    project_id: 'p-1',
    title: `新对话 ${id}`,
    mode: 'react',
    model: '',
    status: 'active',
    created_at: '2026-11-05T06:00:00Z',
    updated_at: '2026-11-05T06:00:00Z',
    deleted_at: null,
    worktree_path: null,
    worktree_branch: null,
  };
}

describe('workspace store：项目徽标 session_count 随新建/删除会话刷新', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    // 默认桩：列表返回空、项目快照可多次变更
    mocks.listProjects.mockResolvedValue([P1]);
    mocks.listSessionsPage.mockResolvedValue({ sessions: [], has_more: false, next_cursor: null });
    mocks.runningSessions.mockResolvedValue({ ids: [], projects: [] });
    mocks.listTrash.mockResolvedValue({ projects: [], sessions: [] });
  });

  it('createSession 后再次拉取 /api/projects（徽标 +1 的数据源）', async () => {
    const ws = useWorkspaceStore();
    await ws.selectProject('p-1'); // selectProject 只刷会话列表，不刷项目快照
    await ws.refreshProjects();
    expect(mocks.listProjects).toHaveBeenCalledTimes(1);

    mocks.createSession.mockResolvedValue(sessionRow('s-1'));
    await ws.createSession({ title: '新对话' });

    expect(mocks.createSession).toHaveBeenCalledWith('p-1', { title: '新对话' });
    expect(mocks.listProjects).toHaveBeenCalledTimes(2); // 修复点：创建后刷新项目快照
    expect(mocks.listSessionsPage).toHaveBeenCalled(); // 会话列表照常刷新
  });

  it('removeSession 后再次拉取 /api/projects（徽标 -1 的数据源）并同步回收站', async () => {
    const ws = useWorkspaceStore();
    await ws.selectProject('p-1');
    await ws.refreshProjects();
    expect(mocks.listProjects).toHaveBeenCalledTimes(1);

    mocks.removeSession.mockResolvedValue({ ok: true });
    await ws.removeSession('s-1');

    expect(mocks.removeSession).toHaveBeenCalledWith('s-1', false);
    expect(mocks.listProjects).toHaveBeenCalledTimes(2); // 修复点：删除后刷新项目快照
    expect(mocks.listTrash).toHaveBeenCalled();
  });

  it('刷新后徽标值来自最新的 /api/projects（新建后 count 递增可见）', async () => {
    const ws = useWorkspaceStore();
    await ws.selectProject('p-1');
    mocks.listProjects.mockResolvedValue([P1]);
    await ws.refreshProjects();
    expect(ws.projects[0]?.session_count).toBe(0);

    // 后端口径（store.ts:123 排除软删）正确，前端拿到新快照即显示 1
    mocks.listProjects.mockResolvedValue([{ ...P1, session_count: 1 }]);
    mocks.createSession.mockResolvedValue(sessionRow('s-1'));
    await ws.createSession();
    expect(ws.projects[0]?.session_count).toBe(1);
  });
});

describe('workspace store：架构收口 T2（侧栏只列 chat + 切项目清态）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mocks.listProjects.mockResolvedValue([P1]);
    mocks.listSessionsPage.mockResolvedValue({ sessions: [], has_more: false, next_cursor: null });
    mocks.runningSessions.mockResolvedValue({ ids: [], projects: [] });
    mocks.listTrash.mockResolvedValue({ projects: [], sessions: [] });
  });

  it('refreshSessions / loadMoreSessions 请求带 kind=chat；refreshProjects 带 session_kind=chat', async () => {
    const ws = useWorkspaceStore();
    await ws.selectProject('p-1');
    expect(mocks.listSessionsPage).toHaveBeenLastCalledWith('p-1', { limit: 50, kind: 'chat' });
    await ws.refreshProjects();
    expect(mocks.listProjects).toHaveBeenLastCalledWith({ sessionKind: 'chat' });

    // 触底加载：同样带 kind=chat（游标取 store 当前值）
    mocks.listSessionsPage.mockResolvedValue({ sessions: [], has_more: true, next_cursor: 'c|1' });
    ws.sessionsHasMore = true;
    ws.sessionsCursor = 'c|1';
    await ws.loadMoreSessions();
    expect(mocks.listSessionsPage).toHaveBeenLastCalledWith('p-1', {
      limit: 50,
      before: 'c|1',
      kind: 'chat',
    });
  });

  it('切项目清掉上一项目绑定的当前会话（chat.sessionId / sessionMeta 复位）', async () => {
    const ws = useWorkspaceStore();
    const chat = useChatStore();
    await ws.selectProject('p-1');
    // 模拟在 p-1 打开了会话
    chat.sessionId = 's-old';
    chat.sessionMeta = { title: '旧项目会话', mode: 'react', model: '' };
    chat.messages = [];
    await ws.selectProject('p-2');
    expect(ws.activeProjectId).toBe('p-2');
    expect(chat.sessionId).toBe('');
    expect(chat.sessionMeta).toBeNull();
    // 新项目会话列表照常拉取
    expect(mocks.listSessionsPage).toHaveBeenLastCalledWith('p-2', { limit: 50, kind: 'chat' });
  });

  it('ensureReady：拉项目/回收站并选中首个项目（幂等）', async () => {
    const ws = useWorkspaceStore();
    expect(ws.ready).toBe(false);
    await ws.ensureReady();
    expect(ws.ready).toBe(true);
    expect(ws.activeProjectId).toBe('p-1');
    expect(mocks.listTrash).toHaveBeenCalled();
    const calls = mocks.listProjects.mock.calls.length;
    await ws.ensureReady();
    expect(mocks.listProjects.mock.calls.length).toBe(calls);
  });

  it('首次 selectProject（无上一个项目）不误清会话态', async () => {
    const ws = useWorkspaceStore();
    const chat = useChatStore();
    chat.sessionId = 's-keep';
    await ws.selectProject('p-1');
    // 无上一个项目：不清（保守口径；真实场景首切时 chat 尚无会话）
    expect(chat.sessionId).toBe('s-keep');
  });
});
