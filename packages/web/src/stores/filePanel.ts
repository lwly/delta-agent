/**
 * F-38 项目文件浏览器 + 变更文件面板：面板全部状态与动作（Pinia）
 *
 * 设计：docs/design-f38-project-file-panel.md（§3.2 / D12 / D13 / §8 共享约定）
 * - 组件内不持业务状态，一律经本 store（切根失效只需清一处）
 * - 缓存 key：树 = relPath（根为 ''）；标签 id = 'files' | 'changes' | `file:<rel>`；
 *   在飞行请求合并 key = `tree:<rel>` / `file:<rel>` / `diff:<rel>` / `changes`
 * - 联动：切会话/切项目/分支/worktree → invalidateAll()（根变了，旧内容一定错）；
 *   chat.running true→false → 300ms 去抖 refreshAfterRun()（内容变了，保留树的展开态）
 * - 错误一律写进对应 error 字段，由面板内联展示（不弹全局 toast，F-38-8）
 * - 只读观察窗：本 store 不含任何写/编辑/暂存/提交动作
 */
import { defineStore } from 'pinia';
import {
  api,
  type BrowseEntry,
  type BrowseScope,
  type ChangeFile,
  type DiffResponse,
  type FilePreviewResponse,
} from '../api/client';
import {
  PANEL_OPEN_KEY,
  PANEL_WIDTH_KEY,
  clampPanelWidth,
  isNarrowViewport,
  readPanelOpen,
  readPanelWidth,
} from '../utils/panelSize';

/** 面板标签：两个固定标签 + 若干动态文件预览标签 */
export type PanelTab =
  | { id: 'files'; kind: 'files' }
  | { id: 'changes'; kind: 'changes' }
  | { id: string; kind: 'file'; path: string };

/** 动态标签上限（超出关最早的，§3.2 openFile） */
export const MAX_DYNAMIC_TABS = 8;

/** 未选中任何东西时的空态文案（PRD F-38-8） */
export const NO_SCOPE_HINT = '请先在左侧选择一个项目';

/** 两个固定标签（可 × 关闭，关掉后可用标签条末尾的「＋」恢复） */
function fixedTabs(): PanelTab[] {
  return [
    { id: 'files', kind: 'files' },
    { id: 'changes', kind: 'changes' },
  ];
}

/**
 * 把固定标签插回规范位置：「文件」恒在首位，「变更」紧跟其后、位于动态标签之前。
 * （恢复被 × 关掉的固定标签时用，保证标签条顺序稳定，不因恢复顺序而漂移）
 */
function insertFixedTab(tabs: PanelTab[], tab: PanelTab): PanelTab[] {
  if (tab.id === 'files') return [tab, ...tabs];
  const dynIndex = tabs.findIndex((t) => t.kind === 'file');
  const at = dynIndex < 0 ? tabs.length : dynIndex;
  return [...tabs.slice(0, at), tab, ...tabs.slice(at)];
}

/** localStorage 安全访问（隐私模式 / SSR / 禁用存储时返回 null，不抛错） */
function panelStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 视口宽度兜底（非浏览器环境按桌面宽度） */
function viewportWidth(): number {
  try {
    return typeof window === 'undefined' ? 1440 : window.innerWidth;
  } catch {
    return 1440;
  }
}

/**
 * 在飞行请求合并表（模块级、非响应式）：
 * 同一 key 的重复请求复用同一个 Promise（PRD §6 并发约束）。
 */
const inflight = new Map<string, Promise<void>>();

/** 作用域是否相同（用于 setScope 短路 / 飞行响应过期判定） */
function sameScope(a: BrowseScope | null, b: BrowseScope | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && a.id === b.id;
}

export const useFilePanelStore = defineStore('filePanel', {
  state: () => ({
    // ── 容器（PRD F-38-1）────────────────────────────────────────────────
    open: readPanelOpen(panelStorage()),
    width: readPanelWidth(panelStorage(), viewportWidth()),
    viewportWidth: viewportWidth(),
    // ── 作用域与根 ───────────────────────────────────────────────────────
    scope: null as BrowseScope | null,
    /** 工作根目录名（服务端 root_name，仅展示，不暴露绝对路径） */
    rootName: '',
    // ── 标签 ─────────────────────────────────────────────────────────────
    tabs: fixedTabs() as PanelTab[],
    /** 当前激活标签；'' = 无激活标签（首次打开面板显示空态动作区，PRD F-38-3） */
    activeTabId: '' as string,
    // ── 文件树（key = relPath，根为 ''）─────────────────────────────────
    expanded: {} as Record<string, boolean>,
    treeCache: {} as Record<string, BrowseEntry[]>,
    /** relPath → 截断前的原始条目总数（>500 时提示） */
    treeTruncated: {} as Record<string, number>,
    treeLoading: {} as Record<string, boolean>,
    treeError: {} as Record<string, string>,
    // ── 变更清单 ─────────────────────────────────────────────────────────
    changes: [] as ChangeFile[],
    changesLoading: false,
    changesError: '',
    /** 非 git / git 超时等业务态文案（200 + ok:false / is_repo:false） */
    changesReason: '',
    changeTotals: { added: 0, removed: 0 },
    changeTotalFiles: 0,
    changesTruncated: false,
    selectedChangePath: '',
    // ── 预览 / diff（key = relPath）──────────────────────────────────────
    previews: {} as Record<string, FilePreviewResponse>,
    previewLoading: {} as Record<string, boolean>,
    previewError: {} as Record<string, string>,
    diffs: {} as Record<string, DiffResponse>,
    diffLoading: {} as Record<string, boolean>,
    diffError: {} as Record<string, string>,
    /** 「在文件管理器中显示」失败文案（内联展示，不弹全局 toast） */
    revealError: '',
  }),

  getters: {
    /** 窄屏（<1200px）：面板走覆盖式定位且默认收起（D11） */
    narrow(state): boolean {
      return isNarrowViewport(state.viewportWidth);
    },
    /** 动态文件标签（固定标签之后） */
    fileTabs(state): PanelTab[] {
      return state.tabs.filter((t): t is Extract<PanelTab, { kind: 'file' }> => t.kind === 'file');
    },
    /** 当前激活的文件标签路径（无 → ''） */
    activeFilePath(state): string {
      const tab = state.tabs.find((t) => t.id === state.activeTabId);
      return tab && tab.kind === 'file' ? tab.path : '';
    },
    /** 是否有固定标签被 × 关掉（为 true 时标签条末尾渲染恢复用的「＋」） */
    missingFixedTabs(state): boolean {
      return !state.tabs.some((t) => t.id === 'files') || !state.tabs.some((t) => t.id === 'changes');
    },
  },

  actions: {
    // ── 容器 ─────────────────────────────────────────────────────────────

    /** 开合面板（写 yz.filePanel）；展开时补一次全量拉取（组件 v-if 卸载后重开即重拉，D13） */
    setOpen(v: boolean): void {
      this.open = v;
      const store = panelStorage();
      if (store) {
        try {
          store.setItem(PANEL_OPEN_KEY, v ? '1' : '0');
        } catch {
          // 存储不可写不影响交互
        }
      }
      if (v) this.bootstrap();
    },

    togglePanel(): void {
      this.setOpen(!this.open);
    },

    /** 拖拽调宽（clamp 后写 yz.filePanelWidth） */
    setWidth(w: number): void {
      this.width = clampPanelWidth(w, this.viewportWidth);
      const store = panelStorage();
      if (store) {
        try {
          store.setItem(PANEL_WIDTH_KEY, String(this.width));
        } catch {
          // 存储不可写不影响交互
        }
      }
    },

    /** 视口变化：重算夹取；进入窄屏默认收起（D11，不覆盖用户的持久化开合偏好之外的状态） */
    syncViewport(vw: number): void {
      this.viewportWidth = vw;
      this.width = clampPanelWidth(this.width, vw);
      if (isNarrowViewport(vw)) this.open = false;
    },

    /** 展开态下的首次数据拉取（幂等：已有缓存不重复请求） */
    bootstrap(): void {
      if (!this.scope) return;
      void this.ensureTree('');
      void this.refreshChanges();
    },

    // ── 作用域 ───────────────────────────────────────────────────────────

    /** 切根（会话 / 项目）→ 全量失效（D13） */
    setScope(scope: BrowseScope | null): void {
      if (sameScope(this.scope, scope)) return;
      this.scope = scope;
      this.rootName = '';
      this.invalidateAll();
    },

    /** 清树缓存 / 预览 / diff + 关全部动态标签 + 重拉变更（D13） */
    invalidateAll(): void {
      inflight.clear();
      this.tabs = fixedTabs();
      // 切根后回到「无激活标签」空态（PRD F-38-3），不残留上一个根的标签选中
      this.activeTabId = '';
      this.expanded = {};
      this.treeCache = {};
      this.treeTruncated = {};
      this.treeLoading = {};
      this.treeError = {};
      this.previews = {};
      this.previewLoading = {};
      this.previewError = {};
      this.diffs = {};
      this.diffLoading = {};
      this.diffError = {};
      this.selectedChangePath = '';
      this.changes = [];
      this.changesError = '';
      this.changesReason = '';
      this.changeTotals = { added: 0, removed: 0 };
      this.changeTotalFiles = 0;
      this.changesTruncated = false;
      // 面板收起时不必拉数据（重新打开时 setOpen(true) → bootstrap 会全量重拉）
      if (this.scope && this.open) this.bootstrap();
    },

    /** 任务结束（running true→false）后的去抖刷新：变更重拉 + 重新加载当前激活的预览/diff */
    async refreshAfterRun(): Promise<void> {
      if (!this.scope) return;
      await this.refreshChanges(true);
      const path = this.activeFilePath;
      if (path) await this.loadPreview(path, true);
      if (this.selectedChangePath) await this.loadDiff(this.selectedChangePath, true);
    },

    // ── 标签 ─────────────────────────────────────────────────────────────

    /** 切到固定标签（'files' / 'changes'）；标签被 × 关掉过则先按规范位置插回 */
    openTab(kind: 'files' | 'changes'): void {
      if (!this.tabs.some((t) => t.id === kind)) {
        const tab: PanelTab = kind === 'files' ? { id: 'files', kind: 'files' } : { id: 'changes', kind: 'changes' };
        this.tabs = insertFixedTab(this.tabs, tab);
      }
      this.activeTabId = kind;
      if (kind === 'changes' && this.changes.length === 0 && !this.changesError) void this.refreshChanges();
    },

    /** 恢复被 × 关掉的固定标签（顺序恒为「文件」→「变更」→ 动态标签）；已全关时激活「文件」 */
    restoreFixedTabs(): void {
      let tabs = this.tabs;
      let firstRestored = '';
      for (const base of fixedTabs()) {
        if (!tabs.some((t) => t.id === base.id)) {
          tabs = insertFixedTab(tabs, base);
          if (!firstRestored) firstRestored = base.id;
        }
      }
      this.tabs = tabs;
      if (!this.activeTabId || !this.tabs.some((t) => t.id === this.activeTabId)) {
        this.activeTabId = firstRestored || 'files';
      }
    },

    /** 打开文件预览标签（已存在则复用并激活；动态标签超上限关最早的） */
    openFile(rel: string): void {
      const path = String(rel ?? '');
      if (!path) return;
      const tabId = `file:${path}`;
      if (!this.tabs.some((t) => t.id === tabId)) {
        const next: PanelTab[] = [...this.tabs, { id: tabId, kind: 'file', path }];
        const dynamic = next.filter((t) => t.kind === 'file');
        if (dynamic.length > MAX_DYNAMIC_TABS) {
          const drop = new Set(dynamic.slice(0, dynamic.length - MAX_DYNAMIC_TABS).map((t) => t.id));
          this.tabs = next.filter((t) => !drop.has(t.id));
        } else {
          this.tabs = next;
        }
      }
      this.activeTabId = tabId;
      void this.loadPreview(path);
    },

    /** 关闭标签（含「文件」「变更」两个固定标签；关光后 activeTabId='' 回到空态动作区） */
    closeTab(tabId: string): void {
      const index = this.tabs.findIndex((t) => t.id === tabId);
      if (index < 0) return;
      const closing = this.tabs[index]!;
      this.tabs = this.tabs.filter((t) => t.id !== tabId);
      if (this.activeTabId === tabId) {
        // 回退顺序：① 右邻动态标签 ② 左邻动态标签 ③ 仍开着的「文件」 ④ 右邻 ⑤ 左邻 ⑥ 全关 → ''（空态）。
        // ①② 优先动态标签，是为了主流程「文件树 → 点文件 → 关预览」回到「文件」而不是被「变更」抢走；
        // 固定标签也能被关掉之后，③④⑤ 保证关「文件」/「变更」时落到相邻标签，⑥ 让空态动作区可达。
        const right = this.tabs[index];
        const left = this.tabs[index - 1];
        const neighbor =
          (right && right.kind === 'file' ? right : undefined) ??
          (left && left.kind === 'file' ? left : undefined) ??
          this.tabs.find((t) => t.id === 'files') ??
          right ??
          left ??
          null;
        this.activeTabId = neighbor ? neighbor.id : '';
      }
      if (closing.kind === 'file') {
        const rest = { ...this.previews };
        delete rest[closing.path];
        this.previews = rest;
        const restErr = { ...this.previewError };
        delete restErr[closing.path];
        this.previewError = restErr;
      }
    },

    activateTab(tabId: string): void {
      if (!this.tabs.some((t) => t.id === tabId)) return;
      this.activeTabId = tabId;
      const tab = this.tabs.find((t) => t.id === tabId);
      if (tab && tab.kind === 'file') void this.loadPreview(tab.path);
    },

    // ── 文件树 ───────────────────────────────────────────────────────────

    /** 展开/收起目录；首次展开才拉子层（懒加载） */
    async toggleDir(rel: string): Promise<void> {
      const path = String(rel ?? '');
      if (this.expanded[path]) {
        this.expanded = { ...this.expanded, [path]: false };
        return;
      }
      this.expanded = { ...this.expanded, [path]: true };
      await this.ensureTree(path);
    },

    /** 确保某层已加载（在飞行请求合并，PRD §6 并发约束） */
    async ensureTree(rel: string, force = false): Promise<void> {
      const scope = this.scope;
      if (!scope) return;
      const path = String(rel ?? '');
      if (!force && this.treeCache[path]) return;
      const key = `tree:${path}`;
      const pending = inflight.get(key);
      if (pending) return pending;

      const task = (async (): Promise<void> => {
        this.treeLoading = { ...this.treeLoading, [path]: true };
        this.treeError = { ...this.treeError, [path]: '' };
        try {
          const res = await api.browseTree(scope, path);
          // 飞行期间作用域已切换 → 丢弃过期响应
          if (!sameScope(this.scope, scope)) return;
          this.treeCache = { ...this.treeCache, [path]: res.entries };
          if (res.truncated) this.treeTruncated = { ...this.treeTruncated, [path]: res.total };
          if (path === '') this.rootName = res.root_name;
        } catch (e) {
          this.treeError = { ...this.treeError, [path]: (e as Error).message };
        } finally {
          this.treeLoading = { ...this.treeLoading, [path]: false };
          inflight.delete(key);
        }
      })();
      inflight.set(key, task);
      return task;
    },

    // ── 变更清单 ─────────────────────────────────────────────────────────

    /**
     * 拉取工作区变更（force = 点 ⟳：绕过在飞行合并强制重查）。
     * 非 git / git 超时是 200 业务态：写入 changesReason，不写 changesError。
     */
    async refreshChanges(force = false): Promise<void> {
      const scope = this.scope;
      if (!scope) {
        this.changes = [];
        this.changesError = '';
        this.changesReason = '';
        this.changesLoading = false;
        return;
      }
      const key = 'changes';
      if (!force) {
        const pending = inflight.get(key);
        if (pending) return pending;
      }
      const task = (async (): Promise<void> => {
        this.changesLoading = true;
        this.changesError = '';
        try {
          const res = await api.browseChanges(scope);
          if (!sameScope(this.scope, scope)) return;
          this.changes = res.files;
          this.changeTotals = res.totals;
          this.changeTotalFiles = res.total_files;
          this.changesTruncated = res.truncated;
          this.changesReason = res.reason ?? '';
          if (res.root_name) this.rootName = res.root_name;
          this.changesError = res.ok ? '' : (res.reason ?? '加载失败，点击重试');
        } catch (e) {
          this.changes = [];
          this.changesError = (e as Error).message;
        } finally {
          this.changesLoading = false;
          inflight.delete(key);
        }
      })();
      inflight.set(key, task);
      return task;
    },

    /** 选中变更行 + 拉单文件 diff */
    async selectChange(rel: string): Promise<void> {
      this.selectedChangePath = String(rel ?? '');
      if (!this.selectedChangePath) return;
      await this.loadDiff(this.selectedChangePath);
    },

    /** 清除选中（详情区回到「请选择一个产物查看详情」空态） */
    clearChangeSelection(): void {
      this.selectedChangePath = '';
    },

    // ── 预览 / diff ──────────────────────────────────────────────────────

    /** 读取文件预览（同一路径在飞行请求合并；force = 任务结束后强制重读） */
    async loadPreview(rel: string, force = false): Promise<void> {
      const scope = this.scope;
      const path = String(rel ?? '');
      if (!scope || !path) return;
      if (!force && this.previews[path]) return;
      const key = `file:${path}`;
      if (!force) {
        const pending = inflight.get(key);
        if (pending) return pending;
      }
      const task = (async (): Promise<void> => {
        this.previewLoading = { ...this.previewLoading, [path]: true };
        this.previewError = { ...this.previewError, [path]: '' };
        try {
          const res = await api.browseFile(scope, path);
          if (!sameScope(this.scope, scope)) return;
          this.previews = { ...this.previews, [path]: res };
        } catch (e) {
          this.previewError = { ...this.previewError, [path]: (e as Error).message };
        } finally {
          this.previewLoading = { ...this.previewLoading, [path]: false };
          inflight.delete(key);
        }
      })();
      inflight.set(key, task);
      return task;
    },

    /** 读取单文件 diff（同一路径在飞行请求合并） */
    async loadDiff(rel: string, force = false): Promise<void> {
      const scope = this.scope;
      const path = String(rel ?? '');
      if (!scope || !path) return;
      if (!force && this.diffs[path]) return;
      const key = `diff:${path}`;
      if (!force) {
        const pending = inflight.get(key);
        if (pending) return pending;
      }
      const task = (async (): Promise<void> => {
        this.diffLoading = { ...this.diffLoading, [path]: true };
        this.diffError = { ...this.diffError, [path]: '' };
        try {
          const res = await api.browseDiff(scope, path);
          if (!sameScope(this.scope, scope)) return;
          this.diffs = { ...this.diffs, [path]: res };
        } catch (e) {
          this.diffError = { ...this.diffError, [path]: (e as Error).message };
        } finally {
          this.diffLoading = { ...this.diffLoading, [path]: false };
          inflight.delete(key);
        }
      })();
      inflight.set(key, task);
      return task;
    },

    /** 在系统文件管理器中显示（唯一 POST；省略 path = 工作根） */
    async reveal(path = ''): Promise<void> {
      const scope = this.scope;
      if (!scope) return;
      this.revealError = '';
      try {
        await api.browseReveal(scope, path);
      } catch (e) {
        this.revealError = (e as Error).message;
      }
    },
  },
});
