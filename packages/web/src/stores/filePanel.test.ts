/**
 * F-38 面板 store 行为测试（无 DOM、无后端：mock api/client，node 环境可跑）
 *
 * 为什么在 web 侧补这一份：面板的交互逻辑全在 `stores/filePanel.ts`，
 * 组件只是模板壳；本机没有 @vue/test-utils / jsdom（design §8.9 要求零新增依赖），
 * 因此用「Pinia + mock api」把可自动化的行为固定下来，模板层用静态审查兜底。
 *
 * 覆盖：
 * - 空态可达性（activeTabId ''，PRD F-38-3 的回归守卫）
 * - 无作用域时不发任何 /browse/* 请求（空态动作区不应产生流量）
 * - reveal 动作参数契约（工作根 chip → reveal('') = POST 无 path）
 * - 变更 300 截断的三个数据字段（前端截断文案的数据来源）
 * - 标签：固定标签也可 × 关（关光回空态、可插回/恢复）/ 动态标签去重 / 上限 8
 * - 树请求飞行合并（同一路径并发只打一次后端）
 * - 业务态（非 git / git 失败）与请求失败（error）分流
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const mocks = vi.hoisted(() => ({
  browseTree: vi.fn(),
  browseFile: vi.fn(),
  browseChanges: vi.fn(),
  browseDiff: vi.fn(),
  browseReveal: vi.fn(),
}));

vi.mock('../api/client', () => ({ api: mocks }));

import { MAX_DYNAMIC_TABS, useFilePanelStore } from './filePanel';
import type { BrowseScope, ChangeFile, ChangesResponse } from '../api/client';

const SCOPE: BrowseScope = { kind: 'project', id: 'p-1' };

/** 让 bootstrap / 动作里的 fire-and-forget Promise 落地 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function changeFile(path: string): ChangeFile {
  return { path, status: 'modified', added: 1, removed: 0, binary: false, orig_path: null };
}

function changesPayload(over: Partial<ChangesResponse> = {}): ChangesResponse {
  return {
    ok: true,
    is_repo: true,
    files: [],
    totals: { added: 0, removed: 0 },
    total_files: 0,
    truncated: false,
    ...over,
  } as ChangesResponse;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();

  mocks.browseTree.mockResolvedValue({
    ok: true,
    path: '',
    root_name: 'demo-root',
    entries: [{ name: 'docs', type: 'dir' }],
    total: 1,
    truncated: false,
  });
  mocks.browseChanges.mockResolvedValue(changesPayload({ root_name: 'demo-root' }));
  mocks.browseFile.mockResolvedValue({
    ok: true,
    path: 'a.md',
    name: 'a.md',
    size: 3,
    kind: 'markdown',
    language: 'markdown',
    content: '# a',
    modified_at: '2026-10-24T09:00:00.000Z',
  });
  mocks.browseDiff.mockResolvedValue({
    ok: true,
    path: 'a.md',
    status: 'modified',
    binary: false,
    truncated: false,
    added: 1,
    removed: 0,
    rows: [],
  });
  mocks.browseReveal.mockResolvedValue({ ok: true });
});

describe('空态动作区可达性（PRD F-38-3 回归守卫）', () => {
  it('初始 activeTabId 为空串；切根后回到空态；点标签才离开空态', async () => {
    const panel = useFilePanelStore();
    expect(panel.activeTabId).toBe('');

    panel.setOpen(true);
    panel.setScope(SCOPE);
    // 切根 = 根变了 → 回到空态动作区（不残留旧根的标签内容）
    expect(panel.activeTabId).toBe('');
    expect(panel.scope).toEqual(SCOPE);

    panel.openTab('files');
    expect(panel.activeTabId).toBe('files');
    panel.openTab('changes');
    expect(panel.activeTabId).toBe('changes');

    panel.invalidateAll();
    expect(panel.activeTabId).toBe('');
    expect(panel.tabs).toHaveLength(2); // 只剩两个固定标签
    expect(panel.tabs.map((t) => t.id)).toEqual(['files', 'changes']);
    await flush();
  });

  it('无作用域时切标签 / reveal 不产生任何 /browse/* 请求', async () => {
    const panel = useFilePanelStore();
    panel.openTab('files');
    panel.openTab('changes');
    await panel.reveal('');
    await panel.refreshChanges();
    await panel.ensureTree('');
    await flush();

    expect(mocks.browseTree).not.toHaveBeenCalled();
    expect(mocks.browseChanges).not.toHaveBeenCalled();
    expect(mocks.browseReveal).not.toHaveBeenCalled();
    expect(panel.changes).toEqual([]);
  });
});

describe('reveal 动作参数契约（工作根 chip 入口）', () => {
  it("reveal('') → 只发一次 POST 且 path 为空串（= 工作根）", async () => {
    const panel = useFilePanelStore();
    panel.setScope(SCOPE);
    await panel.reveal('');

    expect(mocks.browseReveal).toHaveBeenCalledTimes(1);
    expect(mocks.browseReveal).toHaveBeenCalledWith(SCOPE, '');
  });

  it('reveal(相对路径) → 原样透传（文件级「在文件管理器中显示」）', async () => {
    const panel = useFilePanelStore();
    panel.setScope({ kind: 'session', id: 's-9' });
    await panel.reveal('docs/a.md');

    expect(mocks.browseReveal).toHaveBeenCalledWith({ kind: 'session', id: 's-9' }, 'docs/a.md');
  });

  it('reveal 失败 → 写入 revealError 内联展示，不抛出', async () => {
    mocks.browseReveal.mockRejectedValueOnce(new Error('路径非法或超出根目录范围'));
    const panel = useFilePanelStore();
    panel.setScope(SCOPE);
    await expect(panel.reveal('')).resolves.toBeUndefined();
    expect(panel.revealError).toBe('路径非法或超出根目录范围');
  });
});

describe('变更清单：300 截断的数据字段（前端文案数据源）', () => {
  it('truncated 响应 → changes 保留 300 条、total_files=305、changesTruncated=true', async () => {
    mocks.browseChanges.mockResolvedValue(
      changesPayload({
        files: Array.from({ length: 300 }, (_, i) => changeFile(`f${i}.ts`)),
        totals: { added: 300, removed: 0 },
        total_files: 305,
        truncated: true,
        root_name: 'demo-root',
      }),
    );
    const panel = useFilePanelStore();
    panel.setOpen(true);
    panel.setScope(SCOPE);
    await panel.refreshChanges(true);

    expect(panel.changes).toHaveLength(300);
    expect(panel.changeTotalFiles).toBe(305);
    expect(panel.changesTruncated).toBe(true);
    expect(panel.changeTotals).toEqual({ added: 300, removed: 0 });
    // 模板文案 = 「已截断，仅显示前 {{changes.length}} 个（共 {{changeTotalFiles}} 个文件）」
    expect(panel.changes.length).toBeLessThan(panel.changeTotalFiles);
  });
});

describe('标签：固定标签可关 / 去重 / 上限 / 关光回落空态', () => {
  it('两个固定标签都能 × 关闭；关光后 activeTabId 回到空态（PRD F-38-3 动作区可达）', () => {
    const panel = useFilePanelStore();
    panel.openTab('changes');
    expect(panel.activeTabId).toBe('changes');

    panel.closeTab('changes');
    expect(panel.tabs.map((t) => t.id)).toEqual(['files']);
    expect(panel.activeTabId).toBe('files'); // 关「变更」→ 落到剩余的「文件」

    panel.closeTab('files');
    expect(panel.tabs).toHaveLength(0);
    expect(panel.activeTabId).toBe(''); // 全部关光 → 空态动作区
    expect(panel.missingFixedTabs).toBe(true);
  });

  it('关掉非激活的固定标签不影响当前激活标签', () => {
    const panel = useFilePanelStore();
    panel.openTab('files');
    panel.closeTab('changes');
    expect(panel.tabs.map((t) => t.id)).toEqual(['files']);
    expect(panel.activeTabId).toBe('files');
    expect(panel.missingFixedTabs).toBe(true);
  });

  it('openTab 把被关掉的固定标签按规范位置插回（文件 → 变更 → 动态标签）', async () => {
    const panel = useFilePanelStore();
    panel.setScope(SCOPE);
    panel.openFile('docs/a.md');
    await flush();
    panel.closeTab('files');
    panel.closeTab('changes');
    expect(panel.tabs.map((t) => t.id)).toEqual(['file:docs/a.md']);

    panel.openTab('changes');
    expect(panel.tabs.map((t) => t.id)).toEqual(['changes', 'file:docs/a.md']);
    panel.openTab('files');
    expect(panel.tabs.map((t) => t.id)).toEqual(['files', 'changes', 'file:docs/a.md']);
    expect(panel.missingFixedTabs).toBe(false);
  });

  it('restoreFixedTabs：一次恢复被关掉的固定标签并激活「文件」', () => {
    const panel = useFilePanelStore();
    panel.closeTab('files');
    panel.closeTab('changes');
    expect(panel.activeTabId).toBe('');

    panel.restoreFixedTabs();
    expect(panel.tabs.map((t) => t.id)).toEqual(['files', 'changes']);
    expect(panel.activeTabId).toBe('files');
    expect(panel.missingFixedTabs).toBe(false);
  });

  it('同一路径重复 openFile 只有 1 个动态标签（id = file:<rel>）', async () => {
    const panel = useFilePanelStore();
    panel.setScope(SCOPE);
    panel.openFile('docs/a.md');
    panel.openFile('docs/a.md');
    await flush();

    const dyn = panel.tabs.filter((t) => t.kind === 'file');
    expect(dyn).toHaveLength(1);
    expect(dyn[0]!.id).toBe('file:docs/a.md');
    expect(panel.activeTabId).toBe('file:docs/a.md');
    expect(mocks.browseFile).toHaveBeenCalledTimes(1); // 第二次已被 previews 缓存短路
  });

  it(`动态标签上限 ${MAX_DYNAMIC_TABS}：超出关最早的`, async () => {
    const panel = useFilePanelStore();
    panel.setScope(SCOPE);
    for (let i = 0; i < MAX_DYNAMIC_TABS + 1; i += 1) panel.openFile(`f${i}.md`);
    await flush();

    const dyn = panel.tabs.filter((t) => t.kind === 'file');
    expect(dyn).toHaveLength(MAX_DYNAMIC_TABS);
    expect(dyn.map((t) => (t.kind === 'file' ? t.path : ''))).not.toContain('f0.md');
    expect(dyn.map((t) => (t.kind === 'file' ? t.path : ''))).toContain('f8.md');
  });

  it('关掉当前动态标签 → 激活邻居标签（顺序取右邻→左邻→首个），预览缓存同步清理', async () => {
    const panel = useFilePanelStore();
    panel.setScope(SCOPE);
    panel.openFile('only.md');
    await flush();
    panel.closeTab('file:only.md');

    // 口径（store.ts closeTab）：关闭后优先接管**动态**邻居，没有动态邻居则回「文件」标签。
    // tabs = ['files','changes','file:only.md']，关末位后无动态邻居 → 'files'
    // （固定标签不参与回退，否则恒落到 'changes'，与「文件树 → 点文件 → 关预览」的主流程不符）。
    expect(panel.activeTabId).toBe('files');
    expect(panel.tabs).toHaveLength(2);
    expect(panel.previews['only.md']).toBeUndefined(); // 预览缓存同步清理
  });
});

describe('树请求：飞行合并与错误分流', () => {
  it('同一路径并发 ensureTree 只打一次后端', async () => {
    const panel = useFilePanelStore();
    panel.setScope(SCOPE);
    await flush();
    mocks.browseTree.mockClear();

    await Promise.all([panel.ensureTree('docs'), panel.ensureTree('docs')]);
    const docsCalls = mocks.browseTree.mock.calls.filter((c) => c[1] === 'docs');
    expect(docsCalls).toHaveLength(1);
    expect(panel.treeCache['docs']).toHaveLength(1);
  });

  it('非 git 业务态 → 写 changesReason、不写 changesError', async () => {
    mocks.browseChanges.mockResolvedValue(
      changesPayload({
        is_repo: false,
        reason: '当前目录不是 git 仓库，无法查看变更',
        root_name: 'plain',
      }),
    );
    const panel = useFilePanelStore();
    panel.setScope(SCOPE);
    await panel.refreshChanges(true);

    expect(panel.changesReason).toBe('当前目录不是 git 仓库，无法查看变更');
    expect(panel.changesError).toBe('');
    expect(panel.changes).toEqual([]);
  });

  it('git 失败业务态（ok:false）→ 进 changesError（内联错误卡 + 重试）', async () => {
    mocks.browseChanges.mockResolvedValue(
      changesPayload({ ok: false, reason: 'git 超时（15s）' }),
    );
    const panel = useFilePanelStore();
    panel.setScope(SCOPE);
    await panel.refreshChanges(true);

    expect(panel.changesError).toBe('git 超时（15s）');
  });

  it('相同作用域重复 setScope 短路（不重复拉取）', async () => {
    const panel = useFilePanelStore();
    panel.setOpen(true);
    panel.setScope(SCOPE);
    await flush();
    const after = mocks.browseChanges.mock.calls.length;

    panel.setScope({ ...SCOPE });
    await flush();
    expect(mocks.browseChanges.mock.calls.length).toBe(after);
  });
});
