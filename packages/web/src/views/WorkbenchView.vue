<script setup lang="ts">
// 工作台主页（对齐 prototype/index.html 高保真原型）：
// 左侧「项目 × 会话」树形侧边栏 + 主区对话流（工具卡片/事件卡/审批卡）+ 底部输入区
// 模型配置（记忆/配置/用量已迁移至独立设置页 /settings）；设置入口固定在侧栏底部（Token 用量条上方），角标保留待确认记忆提示；
// 定时任务为工作台子路由 /cron（侧栏常驻，主区按路由切换）；回收站 / 检索仍为弹窗；回放走独立路由 /replay/:sessionId
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useWorkspaceStore } from '../stores/workspace';
import { useChatStore } from '../stores/chat';
import { toolLabel } from '../utils/toolNames';
import { api, apiFetch, type ChatMessage, type ExternalAgentInfo, type MessageHit, type MessageImage, type ProviderView, type SkillCandidate } from '../api/client';
import { renderMarkdown } from '../render';
import ModalShell from '../components/ModalShell.vue';
import TrashModal from '../components/TrashModal.vue';
// F-39：ExpertDetail 在根级渲染（见模板尾部）
import SearchModal from '../components/SearchModal.vue';
import GitStatusBar from '../components/GitStatusBar.vue';
import ToolCallCard from '../components/ToolCallCard.vue';
import ExpertPanel from '../components/ExpertPanel.vue';
import ExpertComposerBadge from '../components/ExpertComposerBadge.vue';
import ExpertDetail from '../components/ExpertDetail.vue';
import ExpertTrustDialog from '../components/ExpertTrustDialog.vue';
import ExpertMemberCard from '../components/ExpertMemberCard.vue';
import { useExpertsStore } from '../stores/experts';
import type { ExpertListItem } from '../api/client';
import RunStatusBar from '../components/RunStatusBar.vue';
import FilePanel from '../components/FilePanel.vue';
import TerminalPane from '../components/TerminalPane.vue';
import { useFilePanelStore } from '../stores/filePanel';
// F-54 后台任务条：轮询与状态在 store，本视图只做「随会话切换 watch」接线
import BackgroundTasksBar from '../components/BackgroundTasksBar.vue';
import { useBgTasksStore } from '../stores/bgTasks';
// F-58 任务台：轮询与状态在 store，本视图只做「随项目切换 watch」接线
import TaskBoard from '../components/TaskBoard.vue';
// 任务详情右滑面板（Worker 会话轻量视图；零新通道，复用既有会话 API）
import TaskDetailPanel from '../components/TaskDetailPanel.vue';
import { useTasksStore } from '../stores/tasks';
// 桌面壳桥接：注册项目弹窗「浏览…」选择目录（浏览器形态自动隐藏，保留手输）
import { hasDesktopBridge, pickDirectory } from '../utils/desktop';
import { resolveSelectedModel } from '../utils/modelChoice';

const ws = useWorkspaceStore();
const chat = useChatStore();
const expertsStore = useExpertsStore();
// F-38 右侧文件面板：状态全在 store，本视图只做「作用域推导 + 联动失效」接线
const panel = useFilePanelStore();
// F-54 后台任务：随会话切换启停轮询（离开工作台即停，防孤儿定时器）
const bgTasks = useBgTasksStore();
watch(
  () => chat.sessionId,
  (id) => bgTasks.watch(id ?? null),
  { immediate: true },
);
onUnmounted(() => bgTasks.watch(null));
// F-58 任务台：随项目切换启停轮询（离开工作台即停，防孤儿定时器）
const tasksStore = useTasksStore();
watch(
  () => ws.activeProjectId,
  (id) => tasksStore.watch(id || null),
  { immediate: true },
);
onUnmounted(() => tasksStore.watch(null));
const route = useRoute();
const router = useRouter();

/** 是否处于工作台子路由（定时任务 /cron、运行日志 /logs）：主区渲染 <router-view>，对话流/输入区不渲染 */
const isSubRoute = computed(() => route.path.startsWith('/cron') || route.path.startsWith('/logs'));

// ── 深色工作台改版（纯视觉层） ──────────────────────────────
/** <1024px 侧栏折叠为抽屉：tabbar ☰ 按钮开合（桌面宽度该状态不影响布局） */
const sidebarOpen = ref(false);
/** 标签栏会话 tab 标题：当前会话 > 当前项目 > 兜底 */
const tabTitle = computed(() => chat.sessionMeta?.title || activeProjectName.value || '工作台');
/** 会话列表头像蓝/红渐变交替（纯展示：按会话 id 哈希决定色调，不参与任何业务） */
function avatarTone(id: string): 'blue' | 'red' {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 2 === 0 ? 'blue' : 'red';
}

// ── 侧边栏状态 ──────────────────────────────────────────────
const expanded = ref<Set<string>>(new Set());
const newRoot = ref('');
const error = ref('');
const addError = ref('');

// ── 弹窗开关 ────────────────────────────────────────────────
const showNewProject = ref(false);
const showRemove = ref(false);
const removeTarget = ref<{ kind: 'project' | 'session'; id: string; name: string } | null>(null);
const removeConfirmName = ref('');
const showTrash = ref(false);
const showSearch = ref(false);
// F-47：内置终端面板开关（依赖已打开的会话——pty 工作根跟随会话工作根）。
// 位置调整：终端停靠在右侧栏底部（文件面板下方），不再占据聊天输入区上方。
const showTerminal = ref(false);
/** 打开终端：停靠在右侧栏底部，右侧栏未展开时自动展开（终端可视区域跟随面板） */
function openTerminal(): void {
  showTerminal.value = true;
  if (!panel.open) panel.setOpen(true);
}
function toggleTerminal(): void {
  if (showTerminal.value) showTerminal.value = false;
  else openTerminal();
}
// ── F-39 专家 / 专家团 ──────────────────────────────────────────────
const showExpertPanel = ref(false);
const expertChipRef = ref<HTMLElement | null>(null);
const expertDetailName = ref<string | null>(null);
/** P1（T16）：待信任确认的专家（弹层挂起；确认后继续召唤流程） */
const expertTrustPending = ref<ExpertListItem | null>(null);

// ⌘K / Ctrl+K 全局快捷键：打开会话检索弹窗（仅新增入口，不改动既有逻辑）
// ⌘B / Ctrl+B：开合右侧文件面板（F-38，与顶栏 📁 按钮等价）
function onGlobalKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    showSearch.value = true;
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    panel.togglePanel();
  }
}
onMounted(() => window.addEventListener('keydown', onGlobalKeydown));
onUnmounted(() => window.removeEventListener('keydown', onGlobalKeydown));

// ── 新对话偏好（模式 / 模型）────────────────────────────────
// 执行模式枚举：value 为后端存储值，label 为界面中文显示名
const MODES = [
  { value: 'react', label: 'ReAct 推理', ico: '⚡', cls: 'react' },
  { value: 'plan-execute', label: '计划执行', ico: '📋', cls: 'plan' },
  { value: 'multi-agent', label: '多智能体', ico: '🤖', cls: 'multi' },
] as const;
const modeChoice = ref<string>('react');
const preferredModel = ref(localStorage.getItem('yz.preferredModel') ?? '');
const providers = ref<ProviderView[]>([]);
// F-56：探测到的外部 Agent（模型选择器以 cli: 前缀选项接入，与 Provider 选项并列）
const externalAgents = ref<ExternalAgentInfo[]>([]);
const memoryPendingCount = ref(0);

// ── 今日 token（侧栏底部 + 顶栏预算胶囊）───────────────────
const todayTokens = ref(0);
const DAILY_TOKEN_BUDGET = 2_000_000; // 展示口径：2M tokens/日
const todayPct = computed(() => Math.min(100, Math.round((todayTokens.value / DAILY_TOKEN_BUDGET) * 100)));
const todayLabel = computed(() =>
  todayTokens.value >= 1000 ? `${(todayTokens.value / 1000).toFixed(1)}k` : String(todayTokens.value),
);
async function refreshTodayUsage() {
  try {
    const s = await api.usageSummary('today');
    todayTokens.value = s.totals.input_tokens + s.totals.output_tokens;
  } catch {
    // 用量接口不可用不阻塞工作台
  }
}

// ── 平台展示 ──
// navigator.platform 在 Apple Silicon Mac 上仍返回历史遗留值 "MacIntel"（苹果为兼容未改过），
// 改用 userAgentData 优先，降级解析 UA；Chrome 下再异步补架构（arm → arm64）
const platform = ref(navigator.platform || '—');
void (async () => {
  const uad = (
    navigator as Navigator & {
      userAgentData?: {
        platform?: string;
        getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string; platform?: string }>;
      };
    }
  ).userAgentData;
  let name = uad?.platform;
  if (!name) {
    const ua = navigator.userAgent;
    if (/Windows/.test(ua)) name = 'Windows';
    else if (/Mac/.test(ua)) name = 'macOS';
    else if (/Android/.test(ua)) name = 'Android';
    else if (/Linux/.test(ua)) name = 'Linux';
  }
  let arch = '';
  if (uad?.getHighEntropyValues) {
    try {
      const { architecture } = await uad.getHighEntropyValues(['architecture']);
      if (architecture) arch = architecture === 'arm' ? 'arm64' : architecture;
    } catch {
      // 高熵提示不可用时忽略，仅展示 OS 名
    }
  }
  platform.value = [name, arch].filter(Boolean).join(' · ') || platform.value;
})();

// ── 会话模式徽标（react / plan-execute / multi-agent → react/plan/multi 配色）──
function modeCls(mode: string): string {
  if (mode === 'plan-execute') return 'plan';
  if (mode === 'multi-agent') return 'multi';
  return 'react';
}
function modeLabel(mode: string): string {
  const m = MODES.find((x) => x.value === mode);
  return m ? m.label : mode;
}
/** 侧栏徽标短名（中文） */
function modeShort(mode: string): string {
  if (mode === 'plan-execute') return '计划';
  if (mode === 'multi-agent') return '多智能体';
  return '推理';
}

/** 会话条目次级预览行：updated_at 的相对时间（仅展示层格式化，不改变数据来源与事件逻辑） */
function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(t).toLocaleDateString('zh-CN');
}

// ── F-38 右侧文件面板：作用域推导与联动失效（design D13 / T05）──────────
/**
 * 数据根 = 当前会话工作根（有会话）→ 当前项目根（无会话）→ 无（null）。
 * 作用域变化由 store 的 setScope 内部统一 invalidateAll（清树缓存 + 关全部动态标签 + 重拉变更）。
 */
function syncPanelScope(): void {
  if (chat.sessionId) panel.setScope({ kind: 'session', id: chat.sessionId });
  else if (ws.activeProjectId) panel.setScope({ kind: 'project', id: ws.activeProjectId });
  else panel.setScope(null);
}
watch([() => chat.sessionId, () => ws.activeProjectId], () => syncPanelScope());

/** 分支 / worktree 变化 = 根变了：作用域不变但内容整体失效（D13） */
const panelRootKey = computed(() => {
  const gs = chat.gitState;
  if (!gs) return 'none';
  return `${gs.branch ?? ''}|${gs.worktree.enabled ? 1 : 0}|${gs.worktree.path ?? ''}`;
});
watch(panelRootKey, () => {
  if (panel.scope) panel.invalidateAll();
});

/** 运行结束（running true→false）：300ms 去抖后刷新变更 + 重载当前预览/diff（树缓存保留） */
let panelRefreshTimer: number | null = null;
watch(
  () => chat.running,
  (now, prev) => {
    if (prev !== true || now !== false || !panel.open || !panel.scope) return;
    if (panelRefreshTimer) clearTimeout(panelRefreshTimer);
    panelRefreshTimer = window.setTimeout(() => void panel.refreshAfterRun(), 300);
  },
);
onUnmounted(() => {
  if (panelRefreshTimer) clearTimeout(panelRefreshTimer);
});

/** 视口宽度同步：窄屏（<1200px）面板默认收起，宽度按 D11 重新夹取 */
function onViewportResize(): void {
  panel.syncViewport(window.innerWidth);
}
onMounted(() => {
  onViewportResize();
  syncPanelScope();
  window.addEventListener('resize', onViewportResize);
});
onUnmounted(() => window.removeEventListener('resize', onViewportResize));

// ── 初始化 ──────────────────────────────────────────────────
onMounted(async () => {
  try {
    await ws.refreshProjects();
    await ws.refreshTrash();
    if (ws.projects.length > 0) await ws.selectProject(ws.projects[0]!.id);
  } catch (e) {
    error.value = (e as Error).message;
  }
  void refreshTodayUsage();
  void refreshProviders();
  void refreshMemoryBadge();
});

// ── PASI-9：会话运行态（执行中支持暂停 / 禁止删除）──────────
// 轮询运行中会话 id：侧栏据此切换 ⏸（暂停）/ ✕（删除）按钮；暂停态来自会话行 status
const RUN_POLL_MS = 5000;
let runPollTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  void ws.refreshRunning();
  runPollTimer = setInterval(() => void ws.refreshRunning(), RUN_POLL_MS);
});
onUnmounted(() => {
  if (runPollTimer) clearInterval(runPollTimer);
});
function isSessionRunning(id: string): boolean {
  return ws.runningIds.includes(id);
}
/** 暂停侧栏会话：中止本轮执行并落库 paused（发消息即恢复） */
async function pauseSession(id: string) {
  error.value = '';
  try {
    await ws.pauseSession(id);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function refreshProviders() {
  try {
    const res = await apiFetch('/api/providers');
    const json = await res.json();
    // serve 未挂 ProviderManager 时该端点 404/返回错误对象，退化为空列表
    providers.value = Array.isArray(json) ? (json as ProviderView[]) : [];
  } catch {
    // Provider 列表不可用时模型下拉退化为当前会话模型
  }
  // F-56：外部 Agent 探测（失败静默空态，模型下拉无外部选项——AC-55-7 精神不弹错误）
  try {
    externalAgents.value = (await api.externalAgents()).agents;
  } catch {
    externalAgents.value = [];
  }
}
async function refreshMemoryBadge() {
  try {
    const res = await api.listMemory(undefined, undefined, 'pending');
    memoryPendingCount.value = res.items.length;
  } catch {
    // 角标失败不影响主流程
  }
}

// ── 项目 / 会话操作 ─────────────────────────────────────────
function toggleExpand(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

async function selectProject(id: string) {
  await ws.selectProject(id);
  if (!expanded.value.has(id)) toggleExpand(id);
}

async function addProject() {
  addError.value = '';
  const root = newRoot.value.trim();
  if (!root) return;
  try {
    const p = await ws.createProject(root);
    newRoot.value = '';
    showNewProject.value = false;
    await ws.selectProject(p.id);
    if (!expanded.value.has(p.id)) toggleExpand(p.id);
  } catch (e) {
    addError.value = (e as Error).message;
  }
}

// 注册项目：桌面壳内可调系统目录选择器回填输入框；浏览器形态无桥接（canPick=false）不展示按钮
const canPickDirectory = hasDesktopBridge();
async function browseProjectRoot() {
  const dir = await pickDirectory();
  if (dir) newRoot.value = dir;
}

/** F-39：返回新会话 id（null = 失败；失败方只写 error 不推提示，调用方据返回值决定是否推成功提示） */
async function newSession(mode?: string, expert?: string): Promise<string | null> {
  if (!ws.activeProjectId) {
    error.value = '请先选择或注册一个项目';
    return null;
  }
  try {
    const s = await ws.createSession({
      title: `新对话 ${new Date().toLocaleString('zh-CN')}`,
      mode: mode ?? modeChoice.value,
      model: selectedModel.value || undefined,
      ...(expert ? { expert } : {}),
    });
    await openSession(s.id);
    return s.id;
  } catch (e) {
    error.value = (e as Error).message;
    return null;
  }
}

// ── F-39：召唤面板 / 胶囊 / 详情 ────────────────────────────────────
const expertCapsule = computed(() => {
  const name = chat.sessionMeta?.expert;
  if (!name) return null;
  const item = expertsStore.byName(name);
  const type = (chat.sessionMeta?.expertType ?? item?.expertType ?? 'agent') as 'agent' | 'team';
  return { name, displayName: item?.displayName.zh || item?.displayName.en || name, type };
});
const teamModeForced = computed(() => chat.sessionMeta?.expertType === 'team');
/** 召唤面板列表：停用的包不出现在面板（设置页可见可恢复） */
const summonList = computed(() => expertsStore.list.filter((e) => !expertsStore.disabled.includes(e.name)));

async function toggleExpertPanel(open: boolean) {
  showExpertPanel.value = open;
  if (open && !expertsStore.loaded) void expertsStore.load(ws.activeProjectId ?? undefined);
}

/** F-39「↗ 召唤更多专家」：关闭面板并跳设置页专家 tab（design-f39 §6.8.1） */
function onExpertMore() {
  showExpertPanel.value = false;
  void router.push({ path: '/settings', query: { tab: 'experts' } });
}

/**
 * 选中专家：再次点当前专家 = 只关闭；
 * 空会话（无消息且未运行）→ 就地改绑（P1 F-39-16①）；否则新建会话并绑定。
 * 提示必须在 open/改绑之后（open() 首行 close() 会清 notices）。
 */
async function onExpertSelect(item: ExpertListItem) {
  if (item.name === chat.sessionMeta?.expert) {
    showExpertPanel.value = false;
    return;
  }
  // P1（T16）信任门：user/project 层未信任 → 先弹确认卡（builtin 恒 trusted）
  if (item.trusted === false) {
    expertTrustPending.value = item;
    showExpertPanel.value = false;
    return;
  }
  const dn = item.displayName.zh || item.displayName.en;
  // 空会话 → 就地改绑（不新建，不产生侧栏噪声）
  if (chat.messages.length === 0 && !chat.running) {
    try {
      await api.rebindSessionExpert(chat.sessionId, item.name);
      if (chat.sessionId !== chat.sessionId) return;
      chat.sessionMeta = { ...chat.sessionMeta!, expert: item.name, expertType: item.expertType };
      chat.notice(item.expertType === 'team' ? `已召唤「${dn}」（本会话就地绑定，模式固定为 ReAct）` : `已召唤「${dn}」专家（本会话就地绑定）`);
      showExpertPanel.value = false;
      return;
    } catch {
      // 409 等 → 回退新建会话
    }
  }
  const id = await newSession(undefined, item.name);
  if (!id) return; // 失败：newSession 已写 error，不推提示
  chat.notice(
    item.expertType === 'team'
      ? `已召唤「${dn}」（已新建对话，模式固定为 ReAct）`
      : `已召唤「${dn}」专家（已新建对话）`,
  );
  if (item.missingMcp.length) {
    chat.notice(`该专家声明了未启用的 MCP 依赖：${item.missingMcp.join('、')}（本次仍按无依赖运行）`);
  }
  showExpertPanel.value = false;
}

/** 信任确认通过 → 继续召唤流程 */
async function onTrustConfirmed(name: string) {
  const item = expertTrustPending.value;
  expertTrustPending.value = null;
  if (item?.name === name) {
    expertsStore.invalidate();
    await expertsStore.load(ws.activeProjectId ?? undefined);
    const fresh = expertsStore.byName(name);
    await onExpertSelect(fresh ?? { ...item, trusted: true });
  }
}

/** 胶囊 ✕：空会话就地解绑；有消息 → 新建无专家会话（绝不改写历史会话字段） */
async function onExpertRemove() {
  if (chat.messages.length === 0 && !chat.running && !chat.expertMissing) {
    try {
      await api.rebindSessionExpert(chat.sessionId, null);
      chat.sessionMeta = { ...chat.sessionMeta!, expert: null, expertType: null };
      chat.notice('已取消专家（本会话就地解绑）');
      return;
    } catch {
      // 409 → 回退新建
    }
  }
  const id = await newSession();
  if (!id) return;
  chat.notice('已取消专家（已新建对话）');
}

function onExpertDetail(item: ExpertListItem) {
  expertDetailName.value = item.name;
}

async function onDetailSummon(name: string) {
  expertDetailName.value = null;
  const item = expertsStore.byName(name);
  if (item) await onExpertSelect(item);
}

/** 「由 X 执行」标签：实时取 msg.agentName；回放从 content 前缀解析（权威写入方 = task 工具） */
function agentLabelOf(m: ChatMessage): string | null {
  if (m.agentName) return m.agentName;
  const r = /^\[expert:([A-Za-z0-9_-]{1,40})\]\s*([^\n]*)/.exec(m.content);
  if (!r) return null;
  return (r[2] ?? '').trim() || r[1]!;
}

async function openSession(id: string) {
  error.value = '';
  try {
    await chat.open(id);
    // 子路由（定时任务 /cron、运行日志 /logs）下点会话/新建对话：切回工作台主区，否则 router-view 仍占主区
    if (isSubRoute.value) void router.push('/');
  } catch (e) {
    error.value = (e as Error).message;
  }
}

/** 顶栏模式切换：模式在会话创建时确定，切换 = 以该模式新建对话 */
function onModeSwitch(mode: string) {
  if (chat.sessionId && mode === chat.sessionMeta?.mode) return;
  modeChoice.value = mode;
  void newSession(mode);
}

/** 会话级权限切换：plan 只读 / default 询问确认 / yolo 全部放行（影响该会话后续运行） */
function onPermissionChange(mode: 'plan' | 'default' | 'yolo') {
  if (mode === chat.permissionMode) return;
  void chat.setPermissionMode(mode);
}

const modelOptions = computed(() => {
  // provider 未配置模型名时不得把 provider id 当模型名传给 API（曾致 deepseek 400），
  // 此时 value 留空，由后端回退到该 Provider 的默认模型
  const opts = providers.value
    .filter((p) => p.enabled)
    .map((p) => ({
      value: p.model || '',
      label: p.model ? `${p.model}（${p.id}）` : `${p.id}（默认模型）`,
    }));
  // F-56：外部 Agent 选项（cli: 前缀即外部会话；展示名 displayName > label > id，指定模型时带出）
  for (const a of externalAgents.value) {
    const name = a.displayName || a.label || a.id;
    const suffix = a.model ? ` · ${a.model}` : '';
    opts.push({ value: a.id, label: `${name}（外部 Agent${suffix}）` });
  }
  const cur = chat.sessionMeta?.model;
  if (cur && !opts.some((o) => o.value === cur)) opts.unshift({ value: cur, label: cur });
  return opts;
});

// 下拉选中值：会话模型 > 已记录偏好 > 列表第一项（新会话未选模型时默认选中第一个，不显示空白）
const selectedModel = computed(() =>
  resolveSelectedModel(chat.sessionMeta?.model, preferredModel.value, modelOptions.value.map((o) => o.value)),
);

function onModelChange(ev: Event) {
  const v = (ev.target as HTMLSelectElement).value;
  preferredModel.value = v;
  localStorage.setItem('yz.preferredModel', v);
  // F-56：有打开的会话 → 即时切换该会话模型（下一条消息生效，含外部 Agent）；
  // 无会话 → 仅记录偏好（对新建对话生效）。切换状态直接反映在选择器本身，不打 toast。
  if (chat.sessionMeta) void chat.setSessionModel(v);
}

// ── F-55 外部会话降级提示条（AC-55-7：能力降级是显式常驻提示，不弹错误）──
// 前缀判定与 core isExternalModel（external/registry.ts）对齐；web 不依赖 @delta/core，本地实现。
function isExternalModelId(model: string | undefined | null): boolean {
  return typeof model === 'string' && /^(cli|acp):/.test(model);
}
const externalModel = computed(() => {
  const m = chat.sessionMeta?.model;
  return isExternalModelId(m) ? m! : '';
});
// 关闭态按 model id 记 localStorage：关闭 A 后切到外部 Agent B 仍提示一次（同 A 恢复会话不再打扰）
const EXTERNAL_BAR_KEY = 'yz.externalSessionBarDismissed';
const externalBarDismissed = ref(localStorage.getItem(EXTERNAL_BAR_KEY) ?? '');
const showExternalBar = computed(
  () => externalModel.value !== '' && externalBarDismissed.value !== externalModel.value,
);
function dismissExternalBar() {
  externalBarDismissed.value = externalModel.value;
  localStorage.setItem(EXTERNAL_BAR_KEY, externalBarDismissed.value);
}

function askRemoveProject(p: { id: string; name: string }) {
  projectMenuFor.value = '';
  removeTarget.value = { kind: 'project', id: p.id, name: p.name };
  removeConfirmName.value = '';
  showRemove.value = true;
}

// ── 项目行「更多菜单」（对齐空间侧栏交互：打开文件夹 / 复制路径 / 重命名 / 移除）──
const projectMenuFor = ref('');
const renamingProjectId = ref('');
const renameProjectText = ref('');

function toggleProjectMenu(id: string) {
  projectMenuFor.value = projectMenuFor.value === id ? '' : id;
  renamingProjectId.value = '';
}
/** 在系统文件管理器中打开项目目录 */
async function revealProject(p: { id: string }) {
  projectMenuFor.value = '';
  try {
    await api.revealProject(p.id);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
function copyProjectPath(p: { root_path: string }) {
  projectMenuFor.value = '';
  copyText(p.root_path);
}
function startRenameProject(p: { id: string; name: string }) {
  projectMenuFor.value = '';
  renamingProjectId.value = p.id;
  renameProjectText.value = p.name;
}
async function saveRenameProject(p: { id: string }) {
  if (renamingProjectId.value !== p.id) return;
  const name = renameProjectText.value.trim();
  renamingProjectId.value = '';
  if (!name) return;
  try {
    await api.renameProject(p.id, name);
    await ws.refreshProjects();
  } catch (e) {
    error.value = (e as Error).message;
  }
}
function askRemoveSession(s: { id: string; title: string }) {
  removeTarget.value = { kind: 'session', id: s.id, name: s.title };
  removeConfirmName.value = '';
  showRemove.value = true;
}
const removeNeedsName = computed(() => removeTarget.value?.kind === 'project');
const removeReady = computed(() => {
  if (!removeTarget.value) return false;
  return !removeNeedsName.value || removeConfirmName.value === removeTarget.value.name;
});

async function doRemove() {
  if (!removeTarget.value || !removeReady.value) return;
  error.value = '';
  try {
    if (removeTarget.value.kind === 'project') {
      if (chat.sessionId) chat.close();
      await ws.removeProject(removeTarget.value.id, removeConfirmName.value);
    } else {
      if (chat.sessionId === removeTarget.value.id) chat.close();
      await ws.removeSession(removeTarget.value.id);
    }
    showRemove.value = false;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

// ── 对话区渲染辅助（自 ChatView 迁移）──────────────────────
const listRef = ref<HTMLElement | null>(null);
const input = ref('');
const composerEl = ref<HTMLTextAreaElement | null>(null);

// ── 输入框高度拖拽：上/下边框手柄，向上/向下拖增高，localStorage 记忆 ──
const COMPOSER_H_KEY = 'delta-composer-h';
const COMPOSER_TOUCHED_KEY = 'delta-composer-h-touched';
const COMPOSER_AUTO_MAX = 190; // 自动增高上限：约 8 行（14px × 1.5 行高 ≈ 21px/行），超限内部滚动
const composerH = ref(Number(localStorage.getItem(COMPOSER_H_KEY)) || 44);
const composerResizing = ref(false);
/** 是否手动拖拽调过高度：拖过则以手动高度为固定值，未拖过则随内容自动增高/回缩 */
const composerTouched = ref(localStorage.getItem(COMPOSER_TOUCHED_KEY) === '1');

function clampComposerH(h: number): number {
  const max = Math.round(window.innerHeight * 0.6);
  return Math.min(max, Math.max(44, Math.round(h)));
}

function startComposerResize(edge: 'top' | 'bottom', ev: PointerEvent) {
  ev.preventDefault();
  const startY = ev.clientY;
  const startH = composerH.value;
  composerResizing.value = true;
  document.body.style.userSelect = 'none';
  const onMove = (e: PointerEvent) => {
    const dy = e.clientY - startY;
    composerH.value = clampComposerH(edge === 'top' ? startH - dy : startH + dy);
  };
  const onUp = () => {
    composerResizing.value = false;
    document.body.style.userSelect = '';
    composerTouched.value = true;
    localStorage.setItem(COMPOSER_TOUCHED_KEY, '1');
    localStorage.setItem(COMPOSER_H_KEY, String(composerH.value));
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

/** 同步 composer 高度（ref 与 DOM 内联样式双写，保持与 :style 绑定一致） */
function applyComposerH(h: number) {
  composerH.value = h;
  const ta = composerEl.value;
  if (ta) ta.style.height = `${h}px`;
}

/**
 * 输入内容变化时自动增高/回缩（仅未手动拖拽过时生效）：
 * 先临时压到 44px 基准以获取真实内容高度，再夹取到 [44, 190]；
 * 超过上限时内部滚动（overflow-y: auto），清空后回落 44px
 */
function autoGrowComposer() {
  if (composerTouched.value) return;
  const ta = composerEl.value;
  if (!ta) return;
  ta.style.height = '44px';
  const h = Math.min(COMPOSER_AUTO_MAX, Math.max(44, ta.scrollHeight));
  applyComposerH(h);
  ta.style.overflowY = ta.scrollHeight > COMPOSER_AUTO_MAX + 1 ? 'auto' : 'hidden';
}
// 输入内容任何变化（键入 / 补全插入 / 发送清空 / 示例填入）→ 下一帧自动调高
watch(input, () => void nextTick(autoGrowComposer));
const pendingImages = ref<Array<MessageImage & { preview: string; name: string }>>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const MAX_IMAGES = 5;
const MAX_BYTES = 4 * 1024 * 1024;

const activeProjectName = computed(
  () => ws.projects.find((p) => p.id === ws.activeProjectId)?.name ?? '',
);

/** 回放门禁（纯 UI）：空会话（无任何消息）不跳转，仅呈现禁用视觉态 */
function onReplayClick(e: MouseEvent) {
  if (chat.messages.length === 0) e.preventDefault();
}

/**
 * 工具调用配对视图模型（UI 状态消息流，A/C 需求）：
 * - callInfoMap：callId → { name, argsJson, seq }；seq 优先取 store 本地递增序号（SSE 实时），
 *   历史消息按出现顺序补算（同一会话内按序编号，两种口径一致）
 * - resultMap：callId → 结果消息（role:'tool'），用于合并渲染与运行中判定
 */
interface ToolCallInfo {
  name: string;
  argsJson: string;
  seq: number;
}
const callInfoMap = computed(() => {
  const map = new Map<string, ToolCallInfo>();
  const seen = new Set<string>();
  let n = 0;
  for (const m of chat.messages) {
    for (const c of m.toolCalls ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      n += 1;
      map.set(c.id, { name: c.name, argsJson: c.argsJson, seq: n });
    }
  }
  // SSE 实时记录的调用（尚未落库 / 落库前结果先到的兜底）按 store 序号并入
  for (const [id, pc] of Object.entries(chat.pendingCalls)) {
    if (!map.has(id)) map.set(id, { name: pc.name, argsJson: pc.argsJson, seq: pc.seq });
  }
  return map;
});

const resultMap = computed(() => {
  const map = new Map<string, ChatMessage>();
  for (const m of chat.messages) {
    if (m.role === 'tool' && m.toolCallId) map.set(m.toolCallId, m);
  }
  return map;
});

/** ToolCallCard 的 props 集合（状态 / 结果 / 耗时 / 序号一次算好） */
interface ToolCardProps {
  callId: string;
  name: string;
  argsJson: string;
  status: 'running' | 'ok' | 'fail';
  content?: string;
  durationMs?: number;
  seq?: number;
  sandboxMeta?: ChatMessage['sandboxMeta'];
  agentName?: string | null;
  // ── F-53 大输出懒加载（AC-53-4）──
  /** 结果消息落库 seq（展开全文的数据源；SSE 实时消息无） */
  resultSeq?: number | null;
  /** 服务端摘要化标记：true = content 已截断，可点「加载完整输出」 */
  contentTruncated?: boolean;
  /** 摘要化前的完整内容长度（字符） */
  contentLength?: number;
}
function toolCardOf(id: string, name: string, argsJson: string): ToolCardProps {
  const res = resultMap.value.get(id);
  const rejected = res ? /rejected_by_user/i.test(res.content) : false;
  const status: ToolCardProps['status'] = !res ? 'running' : res.ok === false || rejected ? 'fail' : 'ok';
  return {
    callId: id,
    name,
    argsJson,
    status,
    content: res?.content,
    durationMs: res?.durationMs,
    seq: callInfoMap.value.get(id)?.seq,
    sandboxMeta: res?.sandboxMeta,
    agentName: res ? agentLabelOf(res) : null,
    resultSeq: res?.seq ?? null,
    contentTruncated: res?.contentTruncated,
    contentLength: res?.contentLength,
  };
}
/** 助手消息上的调用 → 完整工具卡（结果未到 = 运行中态） */
function cardsFor(m: ChatMessage): ToolCardProps[] {
  return (m.toolCalls ?? []).map((c) => toolCardOf(c.id, c.name, c.argsJson));
}
/** 孤儿结果卡兜底：结果消息找不到任何调用记录时，仍以结果为主体渲染一张卡 */
function orphanCard(m: ChatMessage): ToolCardProps {
  const info = m.toolCallId ? callInfoMap.value.get(m.toolCallId) : undefined;
  const ok = m.ok;
  const rejected = /rejected_by_user/i.test(m.content);
  return {
    callId: m.toolCallId ?? `orphan-${m.content.slice(0, 16)}`,
    name: info?.name ?? 'tool',
    argsJson: info?.argsJson ?? '',
    status: ok === false || rejected ? 'fail' : 'ok',
    content: m.content,
    durationMs: m.durationMs,
    seq: info?.seq ?? m.toolSeq,
    sandboxMeta: m.sandboxMeta,
    agentName: agentLabelOf(m),
    resultSeq: m.seq ?? null,
    contentTruncated: m.contentTruncated,
    contentLength: m.contentLength,
  };
}
/** F-53：工具卡「加载完整输出」→ 按 resultSeq 拉全文原位回填（AC-53-4） */
function onLoadFullResult(card: ToolCardProps) {
  if (card.resultSeq != null) void chat.expandToolContent(card.resultSeq);
}

/** 消息时间戳显示（仅 SSE 实时到达的消息有 ts，HH:mm 口径） */
function fmtTs(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${min}`;
}

/**
 * v-enhance-md：markdown 容器渲染后的 DOM 增强 —— 代码块加语言标签 + 复制按钮。
 * 安全边界：语言名与复制内容均只经 textContent 读取，DOM 全部 createElement 构建，无 HTML 注入面。
 */
function decorateCodeBlocks(root: HTMLElement) {
  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    if (pre.dataset.yzDecorated === '1') continue;
    pre.dataset.yzDecorated = '1';
    const code = pre.querySelector('code');
    const lang = /language-([\w#+-]+)/.exec(code?.className ?? '')?.[1] ?? '';
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    const head = document.createElement('div');
    head.className = 'code-head';
    const label = document.createElement('span');
    label.className = 'code-lang';
    label.textContent = lang || 'text'; // textContent 赋值，杜绝注入
    const btn = document.createElement('button');
    btn.className = 'code-copy';
    btn.type = 'button';
    btn.textContent = '复制';
    btn.addEventListener('click', () => {
      navigator.clipboard
        .writeText(code?.textContent ?? '')
        .then(() => {
          btn.textContent = '已复制 ✓';
          window.setTimeout(() => (btn.textContent = '复制'), 1500);
        })
        .catch(() => (btn.textContent = '复制失败'));
    });
    head.append(label, btn);
    pre.replaceWith(wrap);
    wrap.append(head, pre);
  }
}
const vEnhanceMd = {
  mounted: decorateCodeBlocks,
  updated: decorateCodeBlocks,
};

// ── 「回到底部」浮动按钮：距底 > 200px 时出现（D 需求） ──────
const showJump = ref(false);
function onChatScroll() {
  const el = listRef.value;
  if (!el) return;
  showJump.value = el.scrollHeight - el.scrollTop - el.clientHeight > 200;
  // F-53：侧栏式触底不适用对话区；向上滚动到顶不自动翻页（显式按钮，避免锚定抖动）
}
function jumpToBottom() {
  listRef.value?.scrollTo({ top: listRef.value.scrollHeight, behavior: 'smooth' });
}

// ── F-53（AC-53-2）：侧栏会话列表触底加载更早会话 ───────────────────────────
const sidebarScrollEl = ref<HTMLElement | null>(null);
function onSidebarScroll() {
  const el = sidebarScrollEl.value;
  if (!el) return;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) void ws.loadMoreSessions();
}

// ── F-53 窗口化渲染（AC-53-1）：消息流只渲染最近 WINDOW 条，更早的折叠为
// 「载入更早消息」入口；配合首屏只拉 50 条 + loadOlder 前缀加载，
// 5000+ 条会话的常驻 DOM 有界（上界 ≈ WINDOW + 单次展开步长），滚动/跳转不卡。
const RENDER_WINDOW = 120;
const RENDER_WINDOW_STEP = 80;
const windowExtra = ref(0);
const visibleMessages = computed(() => {
  const all = chat.messages;
  const total = RENDER_WINDOW + windowExtra.value;
  return all.length <= total ? all : all.slice(all.length - total);
});
const hiddenCount = computed(() => chat.messages.length - visibleMessages.value.length);

/** 前缀插入/窗口扩大后按 scrollHeight 差值补偿 scrollTop（保持视口停在原消息上，无跳动） */
let pendingScrollAdjust: number | null = null;
async function loadOlderMessages() {
  const el = listRef.value;
  if (hiddenCount.value > 0) {
    // 已加载未渲染：先扩大渲染窗口（纯本地，瞬时）
    const beforeHeight = el?.scrollHeight ?? 0;
    windowExtra.value += RENDER_WINDOW_STEP;
    await nextTick();
    if (el) el.scrollTop += el.scrollHeight - beforeHeight;
    return;
  }
  if (!chat.hasMoreOlder) return;
  // 服务端还有更早消息：前缀拉取；scrollTop 补偿由 messages watcher 消费 pendingScrollAdjust
  const beforeHeight = el?.scrollHeight ?? 0;
  await chat.loadOlder();
  await nextTick();
  if (el) pendingScrollAdjust = el.scrollHeight - beforeHeight;
}

/** 状态条「继续」：聚焦输入区并提示发送续跑（store.send 恢复语义，输入为空时不盲目发送） */
function resumeRun() {
  composerEl.value?.focus();
  chat.notice('已暂停中：输入内容并发送即可继续执行');
}

function md(content: string): string {
  return renderMarkdown(content);
}
function argsPretty(argsJson: string): string {
  try {
    return JSON.stringify(JSON.parse(argsJson || '{}'), null, 2);
  } catch {
    return argsJson;
  }
}
function dataUrlOf(img: MessageImage): string {
  return `data:${img.mediaType};base64,${img.base64}`;
}

// F-25：图片附件统一入口（文件选择 / 粘贴共用）——读入 base64（格式/大小前端预检，服务端仍校验）
async function addImageFiles(files: File[]) {
  for (const f of files) {
    if (pendingImages.value.length >= MAX_IMAGES) {
      chat.notice(`最多附加 ${MAX_IMAGES} 张图片`);
      break;
    }
    if (f.size > MAX_BYTES) {
      chat.notice(`✘ ${f.name || '图片'} 过大（>4MB），请压缩后再附加`);
      continue;
    }
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) {
      chat.notice(`✘ ${f.name || '图片'}：仅支持 png/jpeg/gif/webp`);
      continue;
    }
    const buf = await f.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    pendingImages.value.push({
      mediaType: f.type,
      base64: btoa(binary),
      preview: URL.createObjectURL(f),
      name: f.name || '粘贴图片',
    });
  }
}

async function onPickImages(ev: Event) {
  const target = ev.target as HTMLInputElement;
  const files = Array.from(target.files ?? []);
  target.value = '';
  await addImageFiles(files);
}

/** 输入框粘贴图片：从剪贴板提取图片文件走统一附加流程（文本粘贴不受影响） */
async function onPaste(ev: ClipboardEvent) {
  const files = Array.from(ev.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
  if (files.length === 0) return;
  ev.preventDefault();
  await addImageFiles(files);
}
function removePendingImage(i: number) {
  const [item] = pendingImages.value.splice(i, 1);
  if (item) URL.revokeObjectURL(item.preview);
}

// ── 用户消息快捷操作（复制 / 编辑 / 重发）──────────────────
const editingIdx = ref(-1); // 正在编辑的消息下标（-1 表示无编辑）
const editText = ref('');

/** 复制用户消息原文到剪贴板 */
/** 复制任意文本到剪贴板，结果以通知条反馈 */
function copyText(text: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => chat.notice('已复制到剪贴板'))
    .catch(() => chat.notice('✘ 复制失败'));
}
/** 进入编辑态：把消息原文填入输入框，保存后以新内容重发 */
function startEdit(i: number, m: { content: string }) {
  if (chat.running) return;
  editingIdx.value = i;
  editText.value = m.content;
}
function cancelEdit() {
  editingIdx.value = -1;
  editText.value = '';
}
/** 保存编辑并重发（F-46 分叉截断语义：以编辑内容在分叉新会话重跑，原会话只读不动） */
async function resendEdit() {
  const text = editText.value.trim();
  const idx = editingIdx.value;
  if (!text || chat.running || !chat.sessionId || idx < 0) return;
  cancelEdit();
  try {
    const r = await api.forkSession(chat.sessionId, idx, { content: text, run: true });
    if (ws.activeProjectId) await ws.selectProject(ws.activeProjectId);
    await openSession(r.session_id);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
/** 原样重发该消息 */
async function resend(m: { content: string }) {
  if (chat.running || !m.content.trim()) return;
  await chat.send(m.content);
}

/** F-46 从此重跑：分叉新会话（复制该消息之前的历史，标题带「· 分叉」），以该消息内容自动重跑 */
async function forkFrom(i: number) {
  if (chat.running || !chat.sessionId) return;
  try {
    const r = await api.forkSession(chat.sessionId, i, { run: true });
    if (ws.activeProjectId) await ws.selectProject(ws.activeProjectId); // 侧栏纳入分叉会话
    await openSession(r.session_id); // 订阅新会话 SSE，重跑流式可见
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function submit() {
  const text = input.value.trim();
  if ((!text && pendingImages.value.length === 0) || chat.running) return;
  ac.value = null; // 发送时收起自动补全面板
  input.value = '';
  const images = pendingImages.value.length
    ? pendingImages.value.map(({ mediaType, base64 }) => ({ mediaType, base64 }))
    : undefined;
  for (const p of pendingImages.value) URL.revokeObjectURL(p.preview);
  pendingImages.value = [];
  await chat.send(text, images);
}

// ── 轻首页「输入即派任务」（委派式工作台；F-58 worker_tasks.dispatch:true 立即派发）──
const homeInput = ref('');
/** '' = 内置引擎（executor null）；'cli:*' / 'acp:*' = 外部 agent（externalAgents.id 即 executor 值） */
const homeExecutor = ref('');
const delegating = ref(false);
/** 接手 toast：「{助手} 接手了"{title}"」+ 打开入口；超时自动消失 */
const delegateToast = ref<{ assistant: string; title: string; taskId: string } | null>(null);
let delegateToastTimer: ReturnType<typeof setTimeout> | null = null;
onUnmounted(() => {
  if (delegateToastTimer) clearTimeout(delegateToastTimer);
});

/** 首页任务分组（需要你 / 处理中 / 已完成，空组不渲染） */
const homeTaskGroups = computed(() =>
  [
    { key: 'needYou', label: '需要你', items: tasksStore.groups.needYou },
    { key: 'active', label: '处理中', items: tasksStore.groups.active },
    { key: 'finished', label: '已完成', items: tasksStore.groups.finished },
  ].filter((g) => g.items.length > 0),
);

const HOME_STATUS_LABEL: Record<string, string> = {
  draft: '草稿', queued: '排队中', preflight: '准备中', running: '处理中',
  needs_decision: '等待你', done: '已完成', failed: '失败', canceled: '已取消',
};
function taskStatusShort(status: string): string {
  return HOME_STATUS_LABEL[status] ?? status;
}

/** executor 值 → 展示名（内置引擎兜底「内置助手」） */
function assistantName(executor: string | null | undefined): string {
  if (!executor) return '内置助手';
  const a = externalAgents.value.find((x) => x.id === executor);
  return a ? a.displayName || a.label || a.id : executor;
}

/** 首页输入 → 创建并立即派发 Worker 任务；成功后 toast 接手提示（面板由用户自行打开） */
async function dispatchFromHome() {
  const goal = homeInput.value.trim();
  if (!goal || delegating.value) return;
  if (!ws.activeProjectId) {
    error.value = '先注册并选择一个项目，再委派任务';
    return;
  }
  delegating.value = true;
  try {
    const task = await tasksStore.dispatch(ws.activeProjectId, {
      goal,
      executor: homeExecutor.value || null,
    });
    homeInput.value = '';
    delegateToast.value = { assistant: assistantName(task.executor), title: task.title, taskId: task.id };
    if (delegateToastTimer) clearTimeout(delegateToastTimer);
    delegateToastTimer = setTimeout(() => (delegateToast.value = null), 8000);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    delegating.value = false;
  }
}

/** toast「打开」：打开任务详情右滑面板并收掉 toast */
function openDelegated() {
  if (delegateToast.value) tasksStore.openTaskPanel(delegateToast.value.taskId);
  delegateToast.value = null;
}

// ── Composer 自动补全（@ 文件引用 / / 技能）─────────────────
interface AcItem {
  kind: 'file' | 'skill';
  /** 插入文本（文件 = 相对路径；技能 = 名称） */
  label: string;
  detail: string;
}
interface AcState {
  kind: 'file' | 'skill';
  /** 触发符（@ 或 / 的起始下标，替换区间起点） */
  tokenStart: number;
  query: string;
  items: AcItem[];
  index: number;
}
const AC_MAX_ITEMS = 20; // 面板最多展示条数，超出依赖继续输入缩小范围
const ac = ref<AcState | null>(null);
const fileCandidates = ref<string[]>([]);
const fileCandidatesProject = ref(''); // 文件候选缓存对应的项目 id
const skillCandidates = ref<SkillCandidate[] | null>(null);

/** 拉取文件候选（按项目缓存一次；失败时面板退化为空，不阻塞输入） */
async function ensureFileCandidates(): Promise<'loaded' | 'cached' | 'failed'> {
  const pid = ws.activeProjectId;
  if (!pid) return 'failed';
  if (fileCandidatesProject.value === pid) return 'cached';
  try {
    fileCandidates.value = (await api.listProjectFiles(pid)).files;
    fileCandidatesProject.value = pid;
    return 'loaded';
  } catch {
    return 'failed';
  }
}
/** 拉取技能候选（会话内缓存一次；失败时面板退化为空） */
async function ensureSkillCandidates(): Promise<'loaded' | 'cached' | 'failed'> {
  if (skillCandidates.value) return 'cached';
  try {
    skillCandidates.value = (await api.listSkills(ws.activeProjectId ?? undefined)).skills;
    return 'loaded';
  } catch {
    return 'failed';
  }
}

function filterFiles(q: string): AcItem[] {
  const needle = q.toLowerCase();
  return fileCandidates.value
    .filter((f) => f.toLowerCase().includes(needle))
    .slice(0, AC_MAX_ITEMS)
    .map((f) => ({ kind: 'file' as const, label: f, detail: '文件' }));
}
function filterSkills(q: string): AcItem[] {
  const needle = q.toLowerCase();
  return (skillCandidates.value ?? [])
    .filter((s) => s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle))
    .slice(0, AC_MAX_ITEMS)
    .map((s) => ({ kind: 'skill' as const, label: s.name, detail: s.description || s.layer }));
}

/**
 * 根据当前输入与光标位置重算补全状态：
 * - `/` 仅在输入开头触发（slash 技能语义），`@` 需位于词首（行首或空白后）
 * - 候选数据未加载时先展示空面板，加载完成（loaded）后重算一次
 */
function recomputeAc() {
  const ta = composerEl.value;
  if (!ta) {
    ac.value = null;
    return;
  }
  const caret = ta.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const slash = /^\/([^\s]*)$/.exec(before);
  if (slash) {
    const q = slash[1]!;
    ac.value = { kind: 'skill', tokenStart: 0, query: q, items: filterSkills(q), index: 0 };
    void ensureSkillCandidates().then((r) => {
      if (r === 'loaded') recomputeAc();
    });
    return;
  }
  const at = /(^|\s)@([^\s]*)$/.exec(before);
  if (at) {
    const q = at[2]!;
    ac.value = { kind: 'file', tokenStart: caret - q.length - 1, query: q, items: filterFiles(q), index: 0 };
    void ensureFileCandidates().then((r) => {
      if (r === 'loaded') recomputeAc();
    });
    return;
  }
  ac.value = null;
}
function onComposerInput() {
  recomputeAc();
}

/** 键盘导航：↑↓ 在面板内循环移动（仅面板打开时拦截默认行为） */
function onArrow(e: KeyboardEvent, delta: number) {
  if (!ac.value || ac.value.items.length === 0) return;
  e.preventDefault();
  const n = ac.value.items.length;
  ac.value.index = (ac.value.index + delta + n) % n;
}
/** Cmd/Ctrl+Enter：无视补全面板直接发送（纯增量，Enter/Shift+Enter 行为不变） */
function onMetaEnter() {
  void submit();
}
/** Enter：面板打开时选中项，否则发送 */
function onEnterKey(e: KeyboardEvent) {
  e.preventDefault(); // 输入框内 Enter 永不换行（Shift+Enter 才换行）
  if (ac.value && ac.value.items.length > 0) {
    applyAcAt(ac.value.index);
    return;
  }
  void submit();
}
/** Tab：面板打开时选中项，否则保留默认行为 */
function onTabKey(e: KeyboardEvent) {
  if (!ac.value || ac.value.items.length === 0) return;
  e.preventDefault();
  applyAcAt(ac.value.index);
}
function onEscKey() {
  ac.value = null;
}

/** 应用选中项：替换触发 token（文件 → @路径空格；技能 → /名称 空格），光标移到插入末尾 */
function applyAcAt(i: number) {
  const st = ac.value;
  if (!st) return;
  const item = st.items[i];
  if (!item) return;
  const ta = composerEl.value;
  const caret = ta?.selectionStart ?? input.value.length;
  const inserted = item.kind === 'file' ? `@${item.label} ` : `/${item.label} `;
  input.value = input.value.slice(0, st.tokenStart) + inserted + input.value.slice(caret);
  ac.value = null;
  void nextTick(() => {
    ta?.focus();
    const pos = st.tokenStart + inserted.length;
    ta?.setSelectionRange(pos, pos);
  });
}

// ── 空态示例提示词：点击填入输入框（不自动发送，焦点 + 光标置尾）──

/** 提示 chip 点击：插入触发符并打开面板（可发现性） */
function acTrigger(kind: 'file' | 'skill') {
  const ch = kind === 'file' ? '@' : '/';
  if (!input.value.endsWith(ch) && !input.value.endsWith(' ')) input.value += ' ';
  input.value += ch;
  void nextTick(() => {
    composerEl.value?.focus();
    composerEl.value?.setSelectionRange(input.value.length, input.value.length);
    recomputeAc();
  });
}

// 消息增长 / 流式输出时滚到底部；F-53：loadOlder 前缀插入改为 scrollTop 补偿（不跳底）
watch(
  () => [chat.messages.length, chat.streamingText],
  async () => {
    await nextTick();
    const el = listRef.value;
    if (!el) return;
    if (pendingScrollAdjust != null) {
      el.scrollTop += pendingScrollAdjust;
      pendingScrollAdjust = null;
      return;
    }
    el.scrollTo({ top: el.scrollHeight });
  },
);
watch(
  () => chat.running,
  (running, prev) => {
    // 运行态变化即时同步侧栏徽标（不等 5s 轮询）
    if (running !== prev) void ws.refreshRunning();
    if (prev === true && running === false) {
      void refreshTodayUsage();
      void refreshMemoryBadge();
    }
  },
);
</script>

<template>
  <div class="app" :class="{ 'panel-open': panel.open, 'sidebar-open': sidebarOpen }">
    <!-- 项目菜单打开时的点击外部关闭层 -->
    <div v-if="projectMenuFor" class="menu-overlay" @click="projectMenuFor = ''" />
    <!-- ══════════ 最左图标栏 rail（48px；<768px 隐藏，入口下沉底部 dock） ══════════ -->
    <nav class="rail">
      <span class="rail__logo" title="Delta-Agent">Δ</span>
      <button class="rail__btn" type="button" title="会话检索（⌘K）" @click="showSearch = true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      </button>
      <router-link class="rail__btn" to="/cron" title="定时任务">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
      </router-link>
      <router-link class="rail__btn" to="/logs" title="运行日志">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h10" /></svg>
      </router-link>
      <button class="rail__btn" type="button" :class="{ 'rail__btn--on': panel.open }" title="项目文件（⌘B）" @click="panel.togglePanel()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M12 4.5v15" /></svg>
      </button>
      <button class="rail__btn" type="button" :class="{ 'rail__btn--on': showTerminal }" :disabled="!chat.sessionId" :title="chat.sessionId ? '内置终端' : '先打开会话'" @click="toggleTerminal">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="m7 9 3.5 3L7 15" /><path d="M12.5 15H17" /></svg>
      </button>
      <span class="rail__spacer" />
      <button class="rail__btn" type="button" title="回收站" @click="showTrash = true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="m6 7 .9 12.1A2 2 0 0 0 8.9 21h6.2a2 2 0 0 0 2-1.9L18 7" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
      </button>
      <router-link class="rail__btn" to="/settings" title="设置（含待确认记忆角标）">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2" /><path d="M12 2.5v3" /><path d="M12 18.5v3" /><path d="m5.3 5.3 2.1 2.1" /><path d="m16.6 16.6 2.1 2.1" /><path d="M2.5 12h3" /><path d="M18.5 12h3" /><path d="m5.3 18.7 2.1-2.1" /><path d="m16.6 7.4 2.1-2.1" /></svg>
        <span v-if="memoryPendingCount > 0" class="rail__badge">{{ memoryPendingCount > 99 ? '99+' : memoryPendingCount }}</span>
      </router-link>
    </nav>
    <!-- <1024px 侧栏抽屉遮罩（桌面宽度恒不渲染） -->
    <div v-if="sidebarOpen" class="sidebar-backdrop" @click="sidebarOpen = false" />
    <!-- ══════════ 侧边栏（顶部行 / 全局操作 / 会话列表 / 底部功能） ══════════ -->
    <aside class="sidebar">
      <!-- 顶部 40px 行：8px 绿点（本地工作区连接态）+ 名称 + 上下双箭头 -->
      <div class="brand">
        <span class="brand-dot" title="本地工作区" />
        <span class="brand-text">
          <span class="brand-name">Delta-Agent</span>
        </span>
        <svg class="brand-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m8 9 4-4 4 4" /><path d="m8 15 4 4 4-4" /></svg>
      </div>

      <!-- 全局操作区：新项目 / 新对话 / 会话搜索（定时任务 / 日志 / 设置入口已上收至 rail） -->
      <div class="side-section">
        <div class="sidebar-actions">
          <button class="btn-sm" @click="showNewProject = true">＋ 新项目</button>
          <button class="btn-sm primary" :disabled="!ws.activeProjectId" @click="newSession()">＋ 新对话</button>
        </div>
        <div class="sidebar-search">
          <input placeholder="🔍 检索会话与消息…" readonly @click="showSearch = true" />
        </div>
      </div>

      <!-- 会话列表区：小节标题 + 项目 × 会话树（F-53：触底加载更早会话） -->
      <div ref="sidebarScrollEl" class="sidebar-scroll" @scroll.passive="onSidebarScroll">
        <div class="section-title">会话</div>
        <p v-if="error" class="error">✘ {{ error }}</p>
        <div v-for="p in ws.projects" :key="p.id" class="project-group">
          <div class="project-header" :class="{ active: p.id === ws.activeProjectId && !chat.sessionId }" tabindex="0" @click="selectProject(p.id)">
            <span class="project-caret" :class="{ open: expanded.has(p.id) }">▶</span>
            <span class="project-dot" :class="{ running: ws.runningProjectIds.includes(p.id) }" :title="ws.runningProjectIds.includes(p.id) ? '项目下有会话运行中' : undefined" />
            <input
              v-if="renamingProjectId === p.id"
              v-model="renameProjectText"
              class="rename-input"
              autofocus
              @click.stop
              @keydown.enter.prevent="saveRenameProject(p)"
              @keydown.escape.prevent="renamingProjectId = ''"
              @blur="saveRenameProject(p)"
            />
            <span v-else class="project-name" :title="p.root_path">{{ p.name }}</span>
            <span class="project-count">{{ p.session_count }}</span>
            <button class="item-del" title="更多操作" @click.stop="toggleProjectMenu(p.id)">⋯</button>
            <!-- 项目更多菜单：打开文件夹 / 复制路径 / 重命名 / 移除 -->
            <div v-if="projectMenuFor === p.id" class="project-menu" @click.stop>
              <button class="menu-item" @click="revealProject(p)"><span class="mi">📂</span>打开文件夹</button>
              <button class="menu-item" @click="copyProjectPath(p)"><span class="mi">📋</span>复制路径</button>
              <button class="menu-item" @click="startRenameProject(p)"><span class="mi">✏️</span>重命名</button>
              <button class="menu-item danger" @click="askRemoveProject(p)"><span class="mi">🗑</span>从列表中移除</button>
            </div>
          </div>
          <div v-if="expanded.has(p.id) && p.id === ws.activeProjectId" class="session-list">
            <div
              v-for="s in ws.sessions"
              :key="s.id"
              class="session-item"
              :class="{ active: s.id === chat.sessionId }"
              tabindex="0"
              @click="openSession(s.id)"
            >
              <!-- 28px 渐变头像（蓝/红交替 + 白色星形，纯展示） -->
              <span class="session-avatar" :class="`session-avatar--${avatarTone(s.id)}`">
                <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2.6 14.5 9l6.7.3-5.3 4.2 1.9 6.6L12 16.3 6.2 20.1l1.9-6.6L2.8 9.3 9.5 9z" /></svg>
              </span>
              <!-- 两行条目：第一行标题 + 右侧时间，第二行模式徽标 -->
              <span class="session-main">
                <span class="session-top">
                  <span class="session-title" :title="s.title">{{ s.title }}</span>
                  <span class="session-time" :title="s.updated_at">{{ relTime(s.updated_at) }}</span>
                </span>
                <span class="session-sub">
                  <span class="mode-tag" :class="modeCls(s.mode)">{{ modeShort(s.mode) }}</span>
                </span>
              </span>
              <!-- F-37：绑定 worktree 的会话轻量标识（重开自动还原绑定） -->
              <span v-if="s.worktree_path" class="wt-badge" title="已绑定 worktree：会话重开自动还原">🌿</span>
              <span v-if="isSessionRunning(s.id)" class="mode-tag running" title="执行中">运行中</span>
              <span v-else-if="s.status === 'paused'" class="mode-tag paused" title="已暂停，打开会话发送消息即恢复">已暂停</span>
              <!-- PASI-9：执行中显示暂停入口，非执行中才允许删除 -->
              <button v-if="isSessionRunning(s.id)" class="item-del" title="暂停执行（发送消息可恢复）" @click.stop="pauseSession(s.id)">⏸</button>
              <button v-else class="item-del" title="删除会话（软删除）" @click.stop="askRemoveSession(s)">✕</button>
            </div>
            <div v-if="ws.sessions.length === 0" class="session-empty">（暂无会话，点「＋ 新对话」开始）</div>
            <!-- F-53：会话分页加载状态 -->
            <div v-if="ws.sessionsHasMore || ws.loadingMoreSessions" class="session-empty">
              {{ ws.loadingMoreSessions ? '加载中…' : '↓ 滚动加载更早会话' }}
            </div>
          </div>
        </div>
        <p v-if="ws.projects.length === 0" class="session-empty" style="padding: 10px 8px">
          还没有项目，点「＋ 新项目」注册本地仓库根目录。
        </p>
      </div>

      <!-- F-58 任务台：当前项目的 Worker 任务列表（轮询在 store；interrupt 未送达计红点） -->
      <TaskBoard />

      <!-- 底部功能区：Token 进度条；回收站 / 平台降为次级灰字（设置入口在 rail，角标同步） -->
      <div class="side-section bottom-group">
        <div class="sidebar-footer">
          <div class="footer-row" :title="`今日 token ${todayLabel} / ${DAILY_TOKEN_BUDGET / 10000}k（展示口径）`">
            <span class="footer-label">Token（今日）</span>
            <span class="footer-val">{{ todayLabel }} / 2M</span>
          </div>
          <div class="budget-bar">
            <span class="budget-fill" :class="{ warn: todayPct >= 80 }" :style="{ width: `${Math.max(2, todayPct)}%` }" />
          </div>
          <div class="footer-secondary">
            <span class="footer-val link" tabindex="0" title="回收站" @click="showTrash = true">🗑 回收站 · {{ ws.trash.length }} 项</span>
            <span class="footer-sep">·</span>
            <span :title="'平台信息：' + platform">{{ platform }}</span>
            <!-- F-41 运行日志：角落图标入口（/logs 子路由；serve 内存环形缓冲 + SSE 实时） -->
            <router-link class="footer-icon" to="/logs" title="运行日志">📜</router-link>
          </div>
        </div>
      </div>
    </aside>

    <!-- ══════════ 主区域 ══════════ -->
    <main class="main">
      <!-- ══════════ 标签栏 tabbar（40px；chrome 底色，子路由页共用） ══════════ -->
      <div class="tabbar">
        <!-- <1024px 侧栏抽屉开合（桌面宽度隐藏） -->
        <button class="tabbar__menu" type="button" title="开合侧栏" @click="sidebarOpen = !sidebarOpen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></svg>
        </button>
        <!-- 会话 tab：20px 头像 + 标题；有会话时 hover 显示关闭（仅关视图，不动会话数据） -->
        <div class="tabbar__tab tabbar__tab--active">
          <span class="tabbar__avatar" :class="chat.sessionId ? `tabbar__avatar--${avatarTone(chat.sessionId)}` : ''">
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2.6 14.5 9l6.7.3-5.3 4.2 1.9 6.6L12 16.3 6.2 20.1l1.9-6.6L2.8 9.3 9.5 9z" /></svg>
          </span>
          <span class="tabbar__title" :title="tabTitle">{{ tabTitle }}</span>
          <button v-if="chat.sessionId" class="tabbar__close" type="button" title="关闭会话视图" @click.stop="chat.close(); sidebarOpen = false">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12" /><path d="M18 6 6 18" /></svg>
          </button>
        </div>
        <button class="tabbar__add" type="button" title="新对话" :disabled="!ws.activeProjectId" @click="newSession()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
        </button>
        <span class="tabbar__spacer" />
        <!-- 模型选择器胶囊：自 composer 操作行上收至标签栏（逻辑不变，仅移位） -->
        <select v-if="chat.sessionId" class="composer-model tabbar__model" :value="selectedModel" title="模型偏好（对新建对话生效）" @change="onModelChange">
          <option v-if="modelOptions.length === 0" value="">{{ chat.sessionMeta?.model || '默认模型' }}</option>
          <option v-for="o in modelOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <!-- F-38 面板开关：分屏图标按钮，激活态 --accent（PRD F-38-1） -->
        <button
          class="cfg-op panel-toggle"
          :class="{ active: panel.open }"
          type="button"
          :title="panel.open ? '收起项目文件面板（⌘B）' : '项目文件（⌘B）'"
          :aria-pressed="panel.open"
          @click="panel.togglePanel()"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M12 4.5v15" /></svg>
        </button>
        <router-link
          v-if="chat.sessionId"
          class="cfg-op replay"
          :class="{ disabled: chat.messages.length === 0 }"
          :to="`/replay/${chat.sessionId}`"
          :title="chat.messages.length === 0 ? '暂无可回放的会话内容' : '会话回放'"
          @click="onReplayClick"
        >回放</router-link>
      </div>
      <!-- 工作台子路由（/cron 定时任务、/logs 运行日志）：主区整块交给子路由视图（侧栏常驻），对话流 / 输入区不渲染 -->
      <router-view v-if="isSubRoute" />
      <template v-else>
        <!-- 轻首页（委派式工作台）：居中 slogan + 输入即派任务 + 状态分组任务列表 -->
        <div v-if="!chat.sessionId || !chat.sessionMeta" class="hero hero-home">
          <h1 class="home-slogan">
            把工作交出去。<br />
            回来就能看到<span class="home-slogan-accent">答案</span>。
          </h1>
          <p class="home-sub">你的助手会接管并处理任务，每个答案都会在这里等你。</p>

          <!-- 输入即派任务：助手选择器（内置引擎 / 外部 Agent）+ 发送 -->
          <div class="home-composer">
            <textarea
              v-model="homeInput"
              class="home-input"
              rows="3"
              placeholder="你想让助手做什么？"
              @keydown.enter.exact.prevent="dispatchFromHome"
            />
            <div class="home-ops">
              <select v-model="homeExecutor" class="home-executor" title="选择执行助手：内置引擎或外部 Agent">
                <option value="">Δ 内置助手</option>
                <option v-for="a in externalAgents" :key="a.id" :value="a.id">
                  {{ assistantName(a.id) }}{{ a.loginState ? '' : '（未登录）' }}
                </option>
              </select>
              <span class="home-ops-spacer" />
              <button
                class="home-send"
                type="button"
                :disabled="delegating || !homeInput.trim()"
                :title="delegating ? '派发中…' : '委派任务（Enter）'"
                @click="dispatchFromHome"
              >↑</button>
            </div>
          </div>

          <!-- 状态分组任务列表（需要你 / 处理中 / 已完成；点击打开详情面板） -->
          <template v-if="ws.activeProjectId">
            <div v-for="g in homeTaskGroups" :key="g.key" class="home-group">
              <div class="home-group-label">{{ g.label }} <span class="home-group-count">{{ g.items.length }}</span></div>
              <button
                v-for="t in g.items"
                :key="t.id"
                class="home-task"
                type="button"
                :title="t.goal"
                @click="tasksStore.openTaskPanel(t.id)"
              >
                <span class="home-task-dot" :class="`home-task-dot--${t.status}`" />
                <span class="home-task-title">{{ t.title }}</span>
                <span v-if="t.status === 'running'" class="home-task-live">正在处理…</span>
                <span v-else class="home-task-status">{{ taskStatusShort(t.status) }}</span>
              </button>
            </div>
          </template>
          <p v-else class="home-sub">先在左侧注册一个项目，就可以委派任务了。</p>
        </div>

      <template v-else>
        <!-- 运行状态条（tabbar 下、消息流上）：运行中/已暂停/已停止三态 + 暂停/停止/继续控制 -->
        <RunStatusBar @resume="resumeRun" />

        <!-- 消息流（含「回到底部」浮动按钮） -->
        <div class="chat-area">
          <div ref="listRef" class="chat-scroll" @scroll.passive="onChatScroll">
          <div class="chat-inner">
            <!-- 深色极简空态：会话内无任何消息时的居中提示（13px faint） -->
            <div v-if="visibleMessages.length === 0 && !chat.streamingText && chat.notices.length === 0" class="chat-empty">
              描述你的第一个任务，Agent 会在项目目录内推理并执行
            </div>
            <!-- F-53 载入更早消息（窗口折叠 + 前缀分页，AC-53-1/3） -->
            <div v-if="hiddenCount > 0 || chat.hasMoreOlder" class="load-older-row">
              <button class="btn-sm" :disabled="chat.loadingOlder" @click="loadOlderMessages">
                {{ chat.loadingOlder ? '加载中…' : hiddenCount > 0 ? `载入更早消息（已折叠 ${hiddenCount} 条）` : '载入更早消息' }}
              </button>
            </div>
            <!-- F-53：渲染窗口内消息；绝对下标 = i + hiddenCount（编辑/分叉按 chat.messages 定位） -->
            <div v-for="(m, i) in visibleMessages" :key="m.seq ?? `local-${i}`">
              <div v-if="m.role === 'user'" class="msg msg-user">
                <span class="avatar user">👤</span>
                <div class="ai-col">
                  <!-- 元信息行：角色徽章 + 时间戳（仅实时到达消息有 ts） -->
                  <div class="msg-meta">
                    <span class="role-tag user">👤 USER</span>
                    <span v-if="m.ts" class="meta-ts">{{ fmtTs(m.ts) }}</span>
                  </div>
                  <!-- 编辑态：原文填入文本框，可改后重发 -->
                  <div v-if="editingIdx === i + hiddenCount" class="bubble edit-box">
                    <textarea
                      v-model="editText"
                      class="edit-input"
                      rows="3"
                      placeholder="编辑消息内容（Enter 保存并重发，Esc 取消）"
                      @keydown.enter.exact.prevent="resendEdit"
                      @keydown.esc="cancelEdit"
                    />
                    <div class="edit-ops">
                      <button class="uop primary" :disabled="chat.running || !editText.trim()" @click="resendEdit">保存并重发</button>
                      <button class="uop" @click="cancelEdit">取消</button>
                    </div>
                  </div>
                  <div v-else class="bubble">
                    <div v-if="m.images?.length" class="imgs">
                      <img v-for="(img, ii) in m.images" :key="ii" :src="dataUrlOf(img)" alt="附件" />
                    </div>
                    <div class="msg-text">{{ m.content }}</div>
                    <div class="msg-ops">
                      <button class="uop ico" title="复制原文" @click="copyText(m.content)">📋</button>
                      <button class="uop ico" title="编辑后重发" :disabled="chat.running" @click="startEdit(i + hiddenCount, m)">✏️</button>
                      <button class="uop ico" title="原样重发" :disabled="chat.running" @click="resend(m)">🔁</button>
                      <button class="uop ico" title="从此重跑（分叉新会话，原会话不动）" :disabled="chat.running" @click="forkFrom(i + hiddenCount)">🔀</button>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 助手消息 -->
              <div v-else-if="m.role === 'assistant'" class="msg msg-ai">
                <span class="avatar ai">Δ</span>
                <div class="ai-col">
                  <div class="msg-meta">
                    <span class="role-tag assistant">◆ ASSISTANT</span>
                    <span class="meta-model">{{ chat.sessionMeta.model || '默认模型' }}</span>
                    <span v-if="m.ts" class="meta-ts">{{ fmtTs(m.ts) }}</span>
                  </div>
                  <!-- 思考过程（thinking_delta 累积；后端不下发则恒不出现）：默认折叠、弱化样式 -->
                  <details v-if="m.thinking" class="think-box">
                    <summary>💭 思考过程</summary>
                    <div class="think-body">{{ m.thinking }}</div>
                  </details>
                  <div v-if="m.content" class="bubble msg-text md" v-enhance-md v-html="md(m.content)" />
                  <!-- 快捷操作：悬停显示，与用户消息一致 -->
                  <div v-if="m.content" class="msg-ops">
                    <button class="uop ico" title="复制回复" @click="copyText(m.content)">📋</button>
                  </div>
                  <!-- 工具调用卡（调用 + 结果按 callId 合并；结果未到 = 运行中态；F-53 大输出懒加载） -->
                  <template v-for="c in cardsFor(m)" :key="c.callId">
                    <ToolCallCard v-bind="c" @load-full="onLoadFullResult(c)" />
                  </template>
                </div>
              </div>

              <!-- 工具结果（已合并进上方调用卡则整条不渲染，避免空 .msg 产生累积空白）；仅孤儿结果在此兜底渲染 -->
              <div v-else-if="m.role === 'tool' && !(m.toolCallId && callInfoMap.has(m.toolCallId))" class="msg tool-msg">
                <div class="msg-meta">
                  <span class="role-tag tool">⚙ TOOL</span>
                  <span v-if="m.ts" class="meta-ts">{{ fmtTs(m.ts) }}</span>
                </div>
                <ToolCallCard v-bind="orphanCard(m)" @load-full="onLoadFullResult(orphanCard(m))" />
              </div>
            </div>

            <!-- F-39：专家团成员卡（实时委派；不落库，本轮运行结束随会话切换清空） -->
            <div v-if="chat.delegations.length" class="expert-delegations">
              <ExpertMemberCard v-for="d in chat.delegations" :key="`${d.memberId}-${d.startedAt}`" :card="d" />
            </div>

            <!-- 流式中的助手输出：打字机光标 ▍（CSS blink） -->
            <div v-if="chat.streamingText" class="msg msg-ai">
              <span class="avatar ai">Δ</span>
              <div class="ai-col">
                <div class="msg-meta">
                  <span class="role-tag assistant">◆ ASSISTANT</span>
                  <span class="meta-model">{{ chat.sessionMeta.model || '默认模型' }}</span>
                  <span class="meta-ts streaming-hint">生成中…</span>
                </div>
                <div class="bubble msg-text md streaming" v-enhance-md v-html="md(chat.streamingText)" />
              </div>
            </div>

            <!-- 事件通知（压缩/预算/计划/子任务…） -->
            <div v-for="n in chat.notices" :key="n.id" class="event-card">
              <span class="event-ico">ℹ</span>
              <span class="event-text">
                {{ n.text }}
                <a v-if="n.url" :href="n.url" target="_blank" rel="noopener noreferrer" class="auth-link">打开登录页 ↗</a>
              </span>
            </div>
          </div>
          </div>
          <!-- 回到底部：距底 > 200px 时出现 -->
          <button v-if="showJump" class="jump-btn" type="button" @click="jumpToBottom">↓ 回到底部</button>
        </div>

        <!-- 审批卡片区 -->
        <div class="composer-wrap cards-zone">
          <div class="cards-inner">
            <!-- 工具确认（一次只弹一张：决定后队列自动弹出下一张，后到不覆盖先到） -->
            <div v-for="req in chat.pendingConfirms.slice(0, 1)" :key="req.id" class="approve-card confirm">
              <div class="ac-head"><span class="tool-status confirm">!</span> 需要确认：{{ toolLabel(req.tool) }}</div>
              <div class="ac-reason">{{ toolLabel(req.tool) }}（{{ req.tool }}）属高危操作，需要确认</div>
              <div v-if="chat.pendingConfirms.length > 1" class="ac-reason">（还有 {{ chat.pendingConfirms.length - 1 }} 个确认请求在排队，逐个处理）</div>
              <pre>{{ argsPretty(JSON.stringify(req.args)) }}</pre>
              <div class="ac-actions">
                <button class="btn primary" @click="chat.decideConfirm(req.id, { kind: 'allow' })">允许</button>
                <button class="btn" @click="chat.decideConfirm(req.id, { kind: 'reject' })">拒绝</button>
              </div>
            </div>

            <!-- 计划审批（可编辑节点） -->
            <div v-for="p in chat.pendingPlans" :key="p.requestId" class="approve-card plan">
              <div class="ac-head">📋 计划审批（rev {{ p.plan.revision }} · {{ p.plan.nodes.length }} 节点）</div>
              <div class="ac-reason">总目标：{{ p.plan.goal }}</div>
              <div v-for="(n, i) in p.plan.nodes" :key="n.id" class="plan-node">
                <code class="nid">{{ n.id }}</code>
                <input class="goal" v-model="n.goal" placeholder="子任务目标" />
                <input
                  class="deps"
                  :value="n.deps.join(',')"
                  placeholder="依赖（逗号分隔）"
                  @change="n.deps = ($event.target as HTMLInputElement).value.split(',').map(s => s.trim()).filter(Boolean)"
                />
                <label class="crit"><input v-model="n.critical" type="checkbox" />critical</label>
                <button class="btn danger sm" @click="p.plan.nodes.splice(i, 1)">删除</button>
              </div>
              <div class="ac-actions">
                <button class="btn primary" @click="chat.decidePlan(p.requestId, { kind: 'edit' })">按此计划执行</button>
                <button class="btn" @click="chat.decidePlan(p.requestId, { kind: 'reject' })">跳过计划（直接执行）</button>
              </div>
            </div>

            <!-- Agent 提问 -->
            <div v-for="a in chat.pendingAsks" :key="a.requestId" class="approve-card ask">
              <div class="ac-head">❓ {{ a.question }}</div>
              <!-- 反馈：选项一行一个（长选项换行挤压可读性差），不用 flex-wrap 横排 -->
              <div v-if="a.options?.length" class="ask-options">
                <button v-for="o in a.options" :key="o" class="ask-option" @click="chat.answerAsk(a.requestId, o)">{{ o }}</button>
              </div>
              <input
                class="ask-input"
                placeholder="输入回答后回车"
                @keyup.enter="chat.answerAsk(a.requestId, ($event.target as HTMLInputElement).value); ($event.target as HTMLInputElement).value = ''"
              />
            </div>
          </div>
        </div>

        <!-- 输入区（运行中整体轻量降级：opacity 0.75 + 顶部细提示行，不做遮挡，保留紧急停止入口） -->
        <!-- F-54 后台任务条：有运行中任务时显示，展开可停止/删除 -->
        <BackgroundTasksBar />
        <div class="composer-wrap">
          <!-- F-55 外部会话降级提示条：常驻不自动消失，可关闭（关闭态存 localStorage） -->
          <!-- 排版：标题 + 模型 pill + 能力标签，扫读优于把四条约束塞进一句话；细节放 title -->
          <div
            v-if="showExternalBar"
            class="external-bar"
            :title="`外部 Agent（${externalModel}）由外部 CLI/ACP 子进程执行：delta 的沙箱、内置工具、上下文压缩与记忆蒸馏均不生效；用量计入对方订阅，不计入 delta 成本`"
          >
            <span class="eb-ico" aria-hidden="true">ⓘ</span>
            <div class="eb-main">
              <span class="eb-title">外部 Agent 会话</span>
              <code class="eb-model">{{ externalModel }}</code>
              <span class="eb-tags">
                <span class="eb-tag">不走 delta 沙箱</span>
                <span class="eb-tag">内置工具不可用</span>
                <span class="eb-tag">无压缩 / 记忆蒸馏</span>
                <span class="eb-tag">订阅内不计费</span>
              </span>
            </div>
            <button class="eb-close" type="button" title="关闭提示" @click="dismissExternalBar">×</button>
          </div>
          <div class="composer" :class="{ resizing: composerResizing, degraded: chat.running }">
            <!-- 运行中顶部细提示行 -->
            <div v-if="chat.running" class="composer-hint">Agent 运行中，输入与工具栏暂不可用 · 停止后可继续</div>
            <!-- 高度拖拽手柄：贴上/下边框，hover 显示 grip 条 -->
            <div class="rsz top" title="拖动调整输入框高度" @pointerdown="startComposerResize('top', $event)"></div>
            <!-- 工具栏（位于输入框上方）：左组附件/引用 ｜ 右组模式/权限 -->
            <div class="composer-tools">
              <div class="tool-group">
                <button class="tool-chip" type="button" :disabled="chat.running" title="附加图片（也可直接粘贴到输入框）" @click="fileInput?.click()">🖼 图片</button>
                <button class="tool-chip" type="button" :disabled="chat.running" title="插入 @ 后自动补全项目文件" @click="acTrigger('file')">@文件引用</button>
                <button class="tool-chip" type="button" :disabled="chat.running" title="插入 / 后自动补全可用技能" @click="acTrigger('skill')">/skill 技能</button>
                <span class="tool-chip static" title="查看已配置的 MCP 扩展工具提示词">/mcp 扩展工具</span>
                <!-- F-47：内置终端（停靠右侧栏底部；会话工作根绑定；运行中不禁用——终端独立于 Agent 执行） -->
                <button
                  class="tool-chip"
                  type="button"
                  :disabled="!chat.sessionId"
                  :title="chat.sessionId ? '打开内置终端（停靠右侧栏底部，绑定当前会话工作根）' : '先打开会话'"
                  @click="toggleTerminal"
                >🖥 终端</button>
                <!-- F-39：召唤专家（切换 = 新建对话；运行中置灰） -->
                <button
                  ref="expertChipRef"
                  class="tool-chip"
                  type="button"
                  :disabled="chat.running"
                  title="召唤专家（切换专家将新建对话）"
                  @click="toggleExpertPanel(!showExpertPanel)"
                >🧑‍💼 专家</button>
              </div>
              <span class="tool-divider" aria-hidden="true" />
              <div class="tool-group">
                <!-- 当前会话模式下拉：模式在会话创建时确定，切换 = 以该模式新建对话 -->
                <select
                  class="mode-select"
                  :value="chat.sessionMeta.mode"
                  :disabled="chat.running || teamModeForced"
                  :title="teamModeForced ? '专家团由主理人调度，固定使用 ReAct' : '当前执行模式（Agent 运行中不可切换，停止后可继续）'"
                  @change="onModeSwitch(($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="m in MODES" :key="m.value" :value="m.value">{{ m.ico }} {{ m.label }}</option>
                </select>
                <!-- 会话级权限：控制写/执行类工具是否需要逐次确认 -->
                <select
                  class="mode-select perm-select"
                  :class="{ yolo: chat.permissionMode === 'yolo' }"
                  :value="chat.permissionMode"
                  :disabled="chat.running"
                  title="会话权限：只读 / 询问确认 / 全部放行（Agent 运行中不可切换）"
                  @change="onPermissionChange(($event.target as HTMLSelectElement).value as 'plan' | 'default' | 'yolo')"
                >
                  <option value="default">🖐 询问确认</option>
                  <option value="plan">📖 只读</option>
                  <option value="yolo">⚡ 全部放行</option>
                </select>
              </div>
            </div>
            <div v-if="pendingImages.length" class="pending-imgs">
              <span v-for="(p, i) in pendingImages" :key="p.preview" class="thumb">
                <img :src="p.preview" :alt="p.name" />
                <button class="rm" @click="removePendingImage(i)">×</button>
              </span>
            </div>
            <!-- F-39：已绑定专家胶囊（数据源 = chat.sessionMeta.expert，会话字段唯一真相） -->
            <div v-if="expertCapsule" class="composer-caps">
              <ExpertComposerBadge
                :display-name="expertCapsule.displayName"
                :type="expertCapsule.type"
                :missing="chat.expertMissing"
                :disabled="chat.running"
                @remove="onExpertRemove"
              />
            </div>
            <!-- F-39：召唤面板（绝对定位在 composer 上方，与 .ac-panel 同位） -->
            <ExpertPanel
              v-if="showExpertPanel"
              :anchor="expertChipRef"
              :selected="chat.sessionMeta?.expert ?? null"
              :list="summonList"
              :loading="expertsStore.loading"
              :error="expertsStore.error"
              :errors="expertsStore.errors"
              @select="onExpertSelect"
              @close="showExpertPanel = false"
              @more="onExpertMore"
              @detail="onExpertDetail"
            />
            <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden @change="onPickImages" />
            <textarea
              ref="composerEl"
              v-model="input"
              :disabled="chat.running"
              :style="{ height: composerH + 'px' }"
              :placeholder="chat.running ? 'Agent 运行中…' : chat.paused ? '已暂停——发送消息将继续执行' : '描述你的任务，或输入 / 查看技能…'"
              @input="onComposerInput"
              @blur="ac = null"
              @keydown.enter.exact="onEnterKey"
              @keydown.enter.meta.prevent="onMetaEnter"
              @keydown.enter.ctrl.prevent="onMetaEnter"
              @keydown.tab="onTabKey"
              @keydown.esc="onEscKey"
              @keydown.up="onArrow($event, -1)"
              @keydown.down="onArrow($event, 1)"
              @paste="onPaste"
            />
            <!-- 自动补全面板：@ 文件引用 / / 技能（键盘 ↑↓ Enter/Tab Esc，鼠标 mousedown 选中避免失焦关闭） -->
            <div v-if="ac && ac.items.length" class="ac-panel">
              <button
                v-for="(it, ai) in ac.items"
                :key="it.kind + it.label"
                class="ac-item"
                :class="{ active: ai === ac.index }"
                :title="it.detail"
                @mousedown.prevent="applyAcAt(ai)"
              >
                <span class="ac-ico">{{ it.kind === 'file' ? '📄' : '⚡' }}</span>
                <span class="ac-label">{{ it.kind === 'file' ? it.label : `/${it.label}` }}</span>
                <span class="ac-detail">{{ it.detail }}</span>
              </button>
              <div class="ac-tip">↑↓ 选择 · Enter / Tab 确认 · Esc 关闭</div>
            </div>
            <!-- 能力说明行：左=输入能力，右=发送快捷键（composer 聚焦时高亮） -->
            <div class="composer-cap">
              <span class="cap-left">支持 Markdown · @ 引用文件 · / 调用 Skill · 可粘贴图片</span>
              <span class="cap-right"><span class="kbd">Enter</span> 发送 · <span class="kbd">Shift+Enter</span> 换行</span>
            </div>
            <!-- 底部操作区：左=会话 git 状态（项目 ｜ 分支 ｜ Worktree），右=暂停/停止/发送（模型选择胶囊在标签栏） -->
            <div class="composer-actions">
              <!-- F-37 会话 git 状态：并入操作行左侧（原先独占一行页脚，竖向太占位） -->
              <GitStatusBar v-if="chat.sessionId" />
              <button v-if="chat.running" class="stop-btn pause" title="暂停执行（发送消息可恢复）" @click="chat.pause()">⏸</button>
              <button v-if="chat.running" class="stop-btn" title="停止执行" @click="chat.abort()">■</button>
              <button v-else class="send-btn" :disabled="!input.trim() && pendingImages.length === 0" title="发送（Enter）" @click="submit">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
              </button>
            </div>
            <div class="rsz bottom" title="拖动调整输入框高度" @pointerdown="startComposerResize('bottom', $event)"></div>
          </div>
        </div>
      </template>
      </template>
    </main>

    <!-- ══════════ F-38 右侧栏（第三栏）：文件面板在上，F-47 内置终端停靠其下 ══════════
         终端开启但面板收起时列容器仍渲染（只显示终端）；随会话切换重建——key 携带 sessionId -->
    <div v-if="panel.open || showTerminal" class="right-col">
      <FilePanel v-if="panel.open" @open-terminal="openTerminal" />
      <TerminalPane
        v-if="showTerminal && chat.sessionId"
        :key="chat.sessionId"
        :session-id="chat.sessionId"
        @close="showTerminal = false"
      />
    </div>

    <!-- ══════════ <768px 底部 dock（rail 隐藏后入口下沉；桌面宽度恒隐藏） ══════════ -->
    <nav class="dock">
      <button class="dock__btn" type="button" title="会话检索（⌘K）" @click="showSearch = true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      </button>
      <router-link class="dock__btn" to="/cron" title="定时任务">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
      </router-link>
      <router-link class="dock__btn" to="/logs" title="运行日志">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h10" /></svg>
      </router-link>
      <router-link class="dock__btn" to="/settings" title="设置">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2" /><path d="M12 2.5v3" /><path d="M12 18.5v3" /><path d="m5.3 5.3 2.1 2.1" /><path d="m16.6 16.6 2.1 2.1" /><path d="M2.5 12h3" /><path d="M18.5 12h3" /><path d="m5.3 18.7 2.1-2.1" /><path d="m16.6 7.4 2.1-2.1" /></svg>
      </router-link>
    </nav>

    <!-- ══════════ 任务详情右滑面板（tasks.openTaskId 驱动；轻首页/任务台共用） ══════════ -->
    <TaskDetailPanel />

    <!-- ══════════ 委派接手 toast（底部居中，超时自动消失） ══════════ -->
    <div v-if="delegateToast" class="delegate-toast">
      <span class="dt-avatar">Δ</span>
      <span class="dt-text"><b>{{ delegateToast.assistant }}</b> 接手了“{{ delegateToast.title }}”</span>
      <button class="dt-open" type="button" @click="openDelegated">打开</button>
      <button class="dt-close" type="button" title="关闭提示" @click="delegateToast = null">×</button>
    </div>

    <!-- ══════════ 弹窗 ══════════ -->
    <ModalShell v-if="showNewProject" title="注册项目" icon="📁" @close="showNewProject = false">
      <!-- 桌面壳：桥接可用时只走系统目录选择器（输入框只读展示结果），不再要求手打绝对路径 -->
      <p v-if="canPickDirectory" class="modal-tip">
        点击<b>选择文件夹…</b>挑选项目根目录，Agent 会在该目录内读写代码。
      </p>
      <p v-else class="modal-tip">
        输入项目根目录的<b>绝对路径</b>，Agent 会在该目录内读写代码。<br />
        <span class="modal-tip-sub">提示：桌面版可直接选择文件夹；浏览器形态受安全模型限制只能手输。</span>
      </p>
      <div class="path-row">
        <input
          v-model="newRoot"
          class="full"
          :readonly="canPickDirectory"
          :placeholder="canPickDirectory ? '尚未选择目录' : '/path/to/your/project'"
          :title="canPickDirectory ? '桌面版请用「选择文件夹…」' : ''"
          @keyup.enter="addProject"
        />
        <button v-if="canPickDirectory" class="btn primary" @click="browseProjectRoot">选择文件夹…</button>
      </div>
      <p v-if="addError" class="error">✘ {{ addError }}</p>
      <div class="modal-btns">
        <button class="btn" @click="showNewProject = false">取消</button>
        <button class="btn primary" :disabled="!newRoot.trim()" @click="addProject">注册</button>
      </div>
    </ModalShell>

    <ModalShell v-if="showRemove" title="确认移除" icon="⚠" @close="showRemove = false">
      <template v-if="removeTarget">
        <p class="modal-tip">
          移除<template v-if="removeTarget.kind === 'project'">项目将<b>级联删除其下会话</b></template><template v-else>该会话</template>（软删除，进回收站 30 天）。
          <template v-if="removeNeedsName">请输入项目名 <b>{{ removeTarget.name }}</b> 确认。</template>
        </p>
        <input v-if="removeNeedsName" v-model="removeConfirmName" class="full" :placeholder="removeTarget.name" />
        <div class="modal-btns">
          <button class="btn" @click="showRemove = false">取消</button>
          <button class="btn danger-btn" :disabled="!removeReady" @click="doRemove">移除（软删除）</button>
        </div>
      </template>
    </ModalShell>

    <TrashModal v-if="showTrash" @close="showTrash = false" />
    <SearchModal v-if="showSearch" @close="showSearch = false" @open-session="openSession" />
    <!-- F-39：专家详情弹层（ModalShell 520px；召唤走与面板相同的 onExpertSelect 流程） -->
    <ExpertDetail
      v-if="expertDetailName"
      :name="expertDetailName"
      @close="expertDetailName = null"
      @summon="onDetailSummon"
    />
    <!-- F-39 P1：首次召唤信任确认（取消 = 不建会话，侧栏无新条目） -->
    <ExpertTrustDialog
      v-if="expertTrustPending"
      :name="expertTrustPending.name"
      @close="expertTrustPending = null"
      @confirmed="onTrustConfirmed"
    />
  </div>
</template>

<style scoped>
.app { display: flex; height: 100vh; position: relative; }
/* ══════════ 最左图标栏 rail（48px，chrome 底色） ══════════ */
.rail {
  width: 48px; min-width: 48px;
  background: var(--bg-chrome);
  display: flex; flex-direction: column; align-items: center;
  padding: 8px 0; gap: 4px;
}
.rail__logo {
  width: 30px; height: 30px; border-radius: var(--radius-md); flex-shrink: 0;
  background: var(--logo-purple);
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 13px; color: #fff; font-family: var(--mono);
  margin-bottom: 8px;
}
.rail__btn {
  position: relative;
  width: 36px; height: 36px; border: none; border-radius: var(--radius-md);
  background: transparent; color: #8a8a8a; cursor: pointer; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  text-decoration: none;
  transition: background 0.12s ease-out, color 0.12s ease-out;
}
.rail__btn svg { width: 22px; height: 22px; }
.rail__btn:hover:not(:disabled) { background: #1f1f1f; color: var(--text); }
.rail__btn:active:not(:disabled) { color: var(--text); }
.rail__btn:disabled { opacity: 0.4; cursor: not-allowed; }
/* 激活项：图标提亮 + 左侧 2px 蓝色竖条（不填充背景） */
.rail__btn--on, .rail__btn.router-link-active { color: var(--text); }
.rail__btn--on::before, .rail__btn.router-link-active::before {
  content: ''; position: absolute; left: -6px; top: 8px; bottom: 8px;
  width: 2px; border-radius: 1px; background: var(--accent);
}
.rail__spacer { flex: 1; }
.rail__badge {
  position: absolute; top: 3px; right: 3px; min-width: 14px; height: 14px;
  border-radius: var(--radius-pill); background: var(--orange); color: #fff;
  font-size: 9px; font-weight: 700; line-height: 14px; text-align: center; padding: 0 3px;
}
/* <1024px 侧栏抽屉遮罩（桌面宽度恒隐藏） */
.sidebar-backdrop { display: none; }
/* F-47 右侧栏列容器：文件面板占满剩余高度，内置终端 300px 停靠其下。
   宽度跟随文件面板的行内 width；仅终端（面板收起）时兜底最小宽度 */
.right-col { display: flex; flex-direction: column; height: 100%; flex: 0 0 auto; min-width: 360px; }
.right-col:has(.file-panel) { min-width: 0; }
.right-col .file-panel { flex: 1 1 0; height: auto; min-height: 0; }
/* F-38：面板展开时主区最小宽度 480px（PRD F-38-1）；窄屏覆盖式面板不挤压主区 */
.app.panel-open .main { min-width: 480px; }

/* ══════════ 侧边栏（顶部行 / 全局操作 / 会话列表 / 底部功能） ══════════ */
.sidebar {
  width: 260px; min-width: 260px;
  background: var(--bg-panel); border-right: 1px solid var(--border);
  display: flex; flex-direction: column;
}
/* 顶部 40px 行：8px 绿点 + 名称 + 上下双箭头 */
.brand { display: flex; align-items: center; gap: 10px; padding: 4px 12px; min-height: 40px; }
.brand-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); flex-shrink: 0; }
.brand-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.brand-name { font-weight: 600; font-size: 13px; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.brand-caret { width: 14px; height: 14px; color: var(--text-faint); flex-shrink: 0; }

/* 段落容器：12px 间距 + 1px 细分隔线区分各段 */
.side-section { padding: 12px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
.side-section.bottom-group { border-bottom: none; border-top: 1px solid var(--border); }

/* 全局操作按钮：主按钮实心强调色 / 次按钮描边中性（三档统一） */
.sidebar-actions { display: flex; gap: 8px; }
.btn-sm {
  flex: 1; padding: 7px 0; border-radius: 7px;
  border: 1px solid var(--border); background: var(--bg-elevated);
  color: var(--text); font-size: 12.5px; cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.btn-sm:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
.btn-sm:active:not(:disabled) { background: var(--bg-active); }
.btn-sm.primary { background: var(--accent); border-color: transparent; color: #fff; font-weight: 600; }
.btn-sm.primary:hover:not(:disabled) { background: var(--accent-strong); }
.btn-sm.primary:active:not(:disabled) { background: var(--accent-press); }
.btn-sm:disabled { opacity: 0.4; cursor: not-allowed; }

/* 搜索框：高 32、bg-elevated、圆角 8、无边框（点击打开检索弹窗） */
.sidebar-search { padding: 0; }
.sidebar-search input {
  width: 100%; height: 32px; padding: 0 10px; font-size: 12px; cursor: pointer;
  color: var(--text-dim); background: var(--bg-elevated);
  border: none; border-radius: var(--radius-md);
}

/* 会话列表区：小节标题（10px 大写风格、faint 色、字距加宽） */
.sidebar-scroll { flex: 1; overflow-y: auto; padding: 12px 8px; }
.section-title {
  font-size: 10px; font-weight: 600; color: var(--text-faint);
  letter-spacing: 0.14em; text-transform: uppercase;
  padding: 0 8px 8px;
}
.project-group { margin-top: 8px; }
.project-header {
  position: relative;
  display: flex; align-items: center; gap: 8px;
  padding: 7px 8px; border-radius: 7px; cursor: pointer; transition: background 0.15s;
}
.project-header:hover { background: var(--bg-hover); }
.project-header:active { background: var(--bg-active); }
.project-header.active { background: var(--bg-active); box-shadow: inset 2px 0 0 var(--accent); }
.project-caret { font-size: 10px; color: var(--text-faint); transition: transform 0.15s; width: 10px; }
.project-caret.open { transform: rotate(90deg); }
.project-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); flex-shrink: 0; }
/* 项目点运行中动效：仅 opacity 呼吸（禁止阴影涟漪 / 缩放） */
.project-dot.running { animation: dot-breathe 1.6s ease-in-out infinite; }
@keyframes dot-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.project-name { font-weight: 600; font-size: 13px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 会话计数徽章：浅色中性（bg-elevated + text-dim） */
.project-count {
  font-size: 11px; color: var(--text-dim); background: var(--bg-elevated);
  border: 1px solid var(--border); padding: 1px 7px; border-radius: 8px;
}

/* 项目行重命名输入框 */
.rename-input {
  flex: 1; min-width: 0; font-size: 13px; font-weight: 600;
  background: var(--bg-elevated); color: var(--text);
  border: 1px solid var(--accent); border-radius: 5px; padding: 2px 6px; outline: none;
}
/* 菜单打开时的全屏透明遮罩（点击外部关闭） */
.menu-overlay { position: fixed; inset: 0; z-index: 40; }
/* 项目行更多菜单（对齐空间侧栏交互） */
.project-menu {
  position: absolute; top: calc(100% + 4px); right: 6px; z-index: 41;
  min-width: 168px; padding: 5px;
  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  display: flex; flex-direction: column;
}
.project-menu .menu-item {
  display: flex; align-items: center; gap: 8px;
  border: none; background: transparent; color: var(--text-dim);
  font-size: 12.5px; text-align: left; padding: 7px 9px; border-radius: 6px; cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.project-menu .menu-item:hover { background: var(--bg-hover); color: var(--text); }
.project-menu .menu-item:active { background: var(--bg-active); }
.project-menu .menu-item .mi { width: 16px; text-align: center; flex: none; }
.project-menu .menu-item.danger:hover { background: var(--red-soft); color: var(--red); }

.session-list { margin: 2px 0 4px 10px; border-left: 1px solid var(--border); padding-left: 6px; }
/* 列表项：高 52、padding 10、圆角 8；hover #202020、选中 #262626 + 左 2px 蓝条 */
.session-item {
  position: relative;
  display: flex; align-items: center; gap: 10px;
  height: 52px; padding: 6px 10px; border-radius: var(--radius-md); cursor: pointer;
  color: var(--text-dim); font-size: 12.5px;
  transition: background 0.12s ease-out, color 0.12s ease-out; margin: 1px 0;
}
.session-item:hover { background: var(--bg-hover); color: var(--text); }
.session-item:active { background: var(--bg-active); }
.session-item.active { background: var(--bg-active); color: var(--text); box-shadow: inset 2px 0 0 var(--accent); }
/* 28×28 渐变头像 + 白色星形 */
.session-avatar {
  width: 28px; height: 28px; border-radius: var(--radius-md); flex-shrink: 0;
  display: flex; align-items: center; justify-content: center; color: #fff;
}
.session-avatar svg { width: 14px; height: 14px; }
.session-avatar--blue { background: var(--avatar-blue); }
.session-avatar--red { background: var(--avatar-red); }
/* 两行条目主体：上行标题 + 右侧时间，下行模式徽标 */
.session-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.session-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.session-title { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.session-sub { display: flex; align-items: center; gap: 6px; min-width: 0; }
.session-time { font-size: 11px; color: var(--text-faint); white-space: nowrap; flex: none; }
.session-empty { color: var(--text-faint); font-size: 11.5px; padding: 4px 8px; }
.item-del {
  opacity: 0; width: 20px; height: 20px; border-radius: 5px; flex-shrink: 0;
  border: none; background: transparent; color: var(--text-faint);
  cursor: pointer; font-size: 11px; line-height: 1;
  display: flex; align-items: center; justify-content: center; transition: all 0.15s;
}
.session-item:hover .item-del, .project-header:hover .item-del { opacity: 1; }
.item-del:hover { background: var(--red-soft); color: var(--red); }

/* 会话行徽标：模式 / 运行中 / 已暂停 */
.mode-tag {
  flex: none; font-size: 10.5px; line-height: 1; padding: 3px 6px;
  border-radius: 4px; background: var(--bg-elevated); color: var(--text-faint);
}
.mode-tag.running {
  color: var(--green); background: var(--green-soft); font-weight: 600;
  display: inline-flex; align-items: center; gap: 4px;
  /* 运行中动效：徽标底色随呼吸点同步明暗（比静态绿底更醒目） */
  animation: tag-breathe 2.4s ease-in-out infinite;
}
.mode-tag.running::before {
  content: ''; width: 6px; height: 6px; border-radius: 50%;
  background: var(--green); animation: dot-breathe 1.2s ease-in-out infinite;
}
@keyframes tag-breathe { 0%, 100% { background: var(--green-soft); } 50% { background: var(--bg-hover); } }
.mode-tag.paused { color: var(--orange); background: var(--orange-soft); }
/* F-37：会话行 worktree 绑定标识 */
.wt-badge { flex: none; font-size: 11px; line-height: 1; }

/* ══════════ 底部功能区 ══════════ */
.sidebar-footer { display: flex; flex-direction: column; gap: 8px; padding: 0; font-size: 11.5px; color: var(--text-faint); }
.footer-row { display: flex; justify-content: space-between; align-items: center; }
.footer-label { color: var(--text-dim); }
.footer-val { font-family: var(--mono); color: var(--text-dim); }
.footer-val.link { cursor: pointer; transition: color 0.12s; }
.footer-val.link:hover { color: var(--text); }
/* Token 用量：4px 细进度条（强调色填充，≥80% 警示色） */
.budget-bar { width: 100%; height: 4px; background: var(--bg-hover); border-radius: 2px; overflow: hidden; }
.budget-fill { display: block; height: 100%; background: var(--accent); border-radius: 2px; transition: width 0.4s; }
.budget-fill.warn { background: var(--orange); }
/* 次级入口：回收站 / 平台信息，最低视觉权重 */
.footer-secondary { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-faint); flex-wrap: wrap; }
.footer-secondary .footer-val { color: var(--text-faint); font-family: inherit; }
.footer-secondary .footer-sep { opacity: 0.5; }
/* 运行日志：状态栏右角小图标入口（hover 提亮，激活态强调色） */
.footer-secondary .footer-icon { margin-left: auto; font-size: 13px; line-height: 1; text-decoration: none; opacity: 0.75; transition: opacity 0.12s; }
.footer-secondary .footer-icon:hover { opacity: 1; }
.footer-secondary .footer-icon.router-link-active { opacity: 1; }

/* ══════════ 主区域 ══════════ */
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

/* 轻首页（委派式工作台）：居中 slogan + 输入即派任务 + 状态分组任务列表 */
.hero {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; padding: 24px; overflow-y: auto;
}
.hero-home { gap: 10px; max-width: 560px; margin: 0 auto; width: 100%; }
.home-slogan {
  font-size: 26px; font-weight: 700; letter-spacing: 0.01em; line-height: 1.5;
  text-align: center; color: var(--text);
}
.home-slogan-accent { color: var(--accent); }
.home-sub { color: var(--text-faint); font-size: 12.5px; text-align: center; }
.home-composer {
  width: 100%;
  background: var(--bg-elevated);
  border: 1px solid var(--border); border-radius: 14px;
  padding: 12px; margin-top: 10px;
  display: flex; flex-direction: column; gap: 8px;
}
.home-composer:focus-within { border-color: var(--border-strong); }
.home-input {
  width: 100%; border: none; background: transparent; resize: none; outline: none;
  color: var(--text); font-size: 13.5px; line-height: 1.6;
  font-family: inherit;
}
.home-input::placeholder { color: var(--text-faint); }
.home-ops { display: flex; align-items: center; gap: 8px; }
.home-ops-spacer { flex: 1; }
.home-executor {
  height: 28px; max-width: 220px;
  border: 1px solid var(--border); border-radius: var(--radius-pill, 999px);
  background: var(--bg-hover); color: var(--text); font-size: 11.5px;
  padding: 0 8px; outline: none; cursor: pointer;
}
.home-send {
  width: 30px; height: 30px; border: none; border-radius: 50%;
  background: var(--accent); color: #fff; font-size: 14px; cursor: pointer;
}
.home-send:hover:not(:disabled) { background: var(--accent-strong); }
.home-send:disabled { opacity: 0.4; cursor: not-allowed; }
/* 状态分组任务列表（需要你 / 处理中 / 已完成） */
.home-group { width: 100%; margin-top: 8px; }
.home-group-label { font-size: 11.5px; color: var(--text-faint); padding: 0 2px 4px; }
.home-group-count { opacity: 0.8; }
.home-task {
  width: 100%; display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: 8px;
  border: none; background: transparent; cursor: pointer; text-align: left;
}
.home-task:hover { background: var(--bg-hover); }
.home-task-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--text-faint); }
.home-task-dot--running { background: var(--green); animation: home-breathe 1.4s ease-in-out infinite; }
.home-task-dot--preflight, .home-task-dot--queued { background: var(--accent); }
.home-task-dot--needs_decision { background: var(--orange); }
.home-task-dot--done { background: var(--green); }
.home-task-dot--failed, .home-task-dot--canceled { background: var(--red); }
@keyframes home-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.home-task-title {
  flex: 1; min-width: 0; font-size: 12.5px; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.home-task-status { flex: none; font-size: 11px; color: var(--text-faint); }
.home-task-live { flex: none; font-size: 11px; color: var(--accent); }
/* 委派接手 toast：底部居中，非模态，超时自动消失 */
.delegate-toast {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
  z-index: 70;
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; border-radius: 10px;
  background: var(--bg-elevated); border: 1px solid var(--border-strong);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  animation: delegate-toast-in 0.18s ease-out;
}
@keyframes delegate-toast-in { from { transform: translateX(-50%) translateY(8px); opacity: 0; } to { transform: translateX(-50%) translateY(0); opacity: 1; } }
.dt-avatar {
  width: 22px; height: 22px; border-radius: 6px; flex: none;
  background: var(--logo-purple); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; font-family: var(--mono);
}
.dt-text { font-size: 12.5px; color: var(--text-dim); }
.dt-text b { color: var(--text); font-weight: 600; }
.dt-open {
  flex: none; height: 24px; padding: 0 10px; border-radius: 6px;
  border: none; background: var(--accent); color: #fff;
  font-size: 11.5px; cursor: pointer;
}
.dt-open:hover { background: var(--accent-strong); }
.dt-close {
  flex: none; width: 20px; height: 20px;
  border: none; background: transparent; color: var(--text-faint);
  font-size: 14px; cursor: pointer;
}
.dt-close:hover { color: var(--text); }

/* ══════════ 标签栏 tabbar（40px，chrome 底色） ══════════ */
.tabbar {
  height: 40px; min-height: 40px;
  background: var(--bg-chrome); border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: 6px;
  padding: 0 12px 0 8px;
}
.tabbar__menu { display: none; }
.tabbar__tab {
  display: flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 6px 0 4px; border-radius: var(--radius-sm);
  max-width: 280px; min-width: 0;
}
.tabbar__tab--active { background: var(--bg-active); }
.tabbar__avatar {
  width: 20px; height: 20px; border-radius: 5px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center; color: #fff;
  background: var(--bg-elevated-2);
}
.tabbar__avatar svg { width: 10px; height: 10px; }
.tabbar__avatar--blue { background: var(--avatar-blue); }
.tabbar__avatar--red { background: var(--avatar-red); }
.tabbar__title { font-size: 12px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.tabbar__close {
  display: none; width: 16px; height: 16px; flex-shrink: 0;
  border: none; border-radius: 4px; background: transparent; color: var(--text-faint);
  cursor: pointer; padding: 0;
  align-items: center; justify-content: center;
  transition: background 0.12s ease-out, color 0.12s ease-out;
}
.tabbar__close svg { width: 10px; height: 10px; }
.tabbar__tab:hover .tabbar__close { display: inline-flex; }
.tabbar__close:hover { background: var(--bg-elevated-2); color: var(--text); }
.tabbar__add {
  width: 24px; height: 24px; flex-shrink: 0;
  border: none; border-radius: var(--radius-sm); background: transparent;
  color: var(--text-faint); cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  transition: background 0.12s ease-out, color 0.12s ease-out;
}
.tabbar__add svg { width: 14px; height: 14px; }
.tabbar__add:hover:not(:disabled) { background: var(--bg-elevated-2); color: var(--text); }
.tabbar__add:disabled { opacity: 0.4; cursor: not-allowed; }
.tabbar__spacer { flex: 1; }
/* 标签栏模型胶囊：复用 .composer-model 规格高 28 */
.tabbar__model { margin-right: 4px; }
/* 标签栏右侧操作钮：图标化（分屏 / 回放） */
.cfg-op {
  height: 28px; padding: 0 10px; border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-elevated); color: var(--text-dim); font-size: 12px; cursor: pointer;
  transition: all 0.12s ease-out; text-decoration: none; white-space: nowrap;
  display: inline-flex; align-items: center; gap: 6px;
}
.cfg-op svg { width: 14px; height: 14px; }
.cfg-op:hover { background: var(--bg-elevated-2); color: var(--text); border-color: var(--border-strong); }
.cfg-op:active { background: var(--bg-active); }
/* 回放固定在标签栏最右；空会话禁用态（faint 色 + not-allowed） */
.cfg-op.replay { flex: none; }
.cfg-op.replay.disabled,
.cfg-op.replay.disabled:hover { color: var(--text-faint); cursor: not-allowed; background: var(--bg-elevated); border-color: var(--border); }
/* F-38 面板开关：28×28 图标按钮；激活态 --accent（PRD §5.6 顶栏开关） */
.cfg-op.panel-toggle {
  width: 28px; height: 28px; min-width: 28px;
  justify-content: center; padding: 0;
}
.cfg-op.panel-toggle.active {
  color: var(--accent);
  border-color: var(--accent-border);
  background: var(--accent-soft);
}

/* 消息流容器（含回到底部按钮的定位上下文） */
.chat-area { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
.chat-scroll { flex: 1; overflow-y: auto; padding: 22px 0; }
/* 消息流与 .composer 同宽：内容列最大 760 居中，左右 padding 24 */
.chat-inner { max-width: 808px; margin: 0 auto; padding: 0 24px; }
/* 会话内空态：居中一行弱化提示 */
.chat-empty { text-align: center; color: var(--text-faint); font-size: 13px; padding: 48px 0 16px; }
/* F-53 载入更早消息入口：居中弱化按钮，不与消息流抢视觉 */
.load-older-row { display: flex; justify-content: center; padding: 6px 0 10px; }
.jump-btn {
  position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 5;
  padding: 7px 16px; border-radius: var(--radius-pill); border: 1px solid var(--border-strong);
  background: var(--bg-elevated); color: var(--text-dim); font-size: 12px; cursor: pointer;
  box-shadow: var(--shadow-pop);
  transition: background 0.15s, color 0.15s, border-color 0.15s;
  animation: fadeIn 0.15s ease-out;
}
.jump-btn:hover { background: var(--bg-hover); color: var(--text); border-color: var(--accent-border); }
.msg { margin-bottom: 18px; animation: fadeIn 0.15s ease-out; }
/* 用户消息：右对齐，bg-elevated 气泡（圆角 10，无尾巴无阴影） */
.msg-user { display: flex; gap: 12px; justify-content: flex-end; }
.msg-ai { display: flex; gap: 12px; }
.ai-col { flex: 1; min-width: 0; }
/* 深色极简改版：头像不再展示（DOM 保留供结构兼容） */
.avatar { display: none; }
/* 用户气泡：右对齐、最大宽 70% */
.msg-user .ai-col { flex: 0 1 auto; max-width: 70%; display: flex; flex-direction: column; align-items: flex-end; }
.msg-user .msg-meta { flex-direction: row-reverse; }
.msg-user .bubble { background: var(--bg-elevated); border: none; border-radius: var(--radius-lg); padding: 8px 12px; min-width: 0; }
/* 助手消息：左对齐、无气泡、纯文本 */
.msg-ai .bubble { background: transparent; border: none; border-radius: 0; padding: 0; }
.bubble { background: var(--bg-panel); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 12px 16px; line-height: 1.6; }
.msg-text { line-height: 1.7; color: var(--text); white-space: pre-wrap; }
.md :deep(p) { margin: 6px 0; }
.md :deep(pre) {
  background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
  padding: 10px 12px; overflow-x: auto; margin: 8px 0; font-family: var(--mono); font-size: 12.5px; line-height: 1.6;
}
.md :deep(code) { font-family: var(--mono); font-size: 12.5px; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; color: var(--accent); }
.md :deep(pre code) { border: none; background: none; padding: 0; color: inherit; }
/* 代码块增强容器（v-enhance-md 构建）：语言标签 + 复制按钮的头部 + 内部滚动 */
.md :deep(.code-block) {
  margin: 8px 0; border: 1px solid var(--border); border-radius: 8px;
  overflow: hidden; background: var(--bg); min-width: 0;
}
.md :deep(.code-block pre) { margin: 0; border: none; border-radius: 0; max-height: 360px; overflow: auto; min-width: 0; }
.md :deep(.code-head) {
  display: flex; align-items: center; justify-content: space-between;
  padding: 4px 10px; background: var(--bg-elevated); border-bottom: 1px solid var(--border);
}
.md :deep(.code-lang) { font-family: var(--mono); font-size: 10.5px; color: var(--text-dim); text-transform: lowercase; }
.md :deep(.code-copy) {
  border: none; background: transparent; color: var(--text-dim);
  font-size: 10.5px; cursor: pointer; padding: 1px 7px; border-radius: 4px;
  transition: background 0.12s, color 0.12s;
}
.md :deep(.code-copy:hover) { background: var(--bg-hover); color: var(--text); }
.md :deep(ul), .md :deep(ol) { padding-left: 20px; margin: 6px 0; }
.md :deep(blockquote) { border-left: 3px solid var(--accent); padding: 2px 0 2px 10px; color: var(--text-dim); margin: 6px 0; }
.md :deep(table) { border-collapse: collapse; }
.md :deep(th), .md :deep(td) { border: 1px solid var(--border); padding: 4px 8px; }
.msg-user .msg-text { white-space: pre-wrap; }
/* 消息快捷操作条：默认隐藏，悬停气泡时浮现（用户 / 助手通用） */
.msg-ops { display: flex; gap: 4px; margin-top: 7px; opacity: 0; transition: opacity 0.15s; }
.msg-user:hover .msg-ops, .msg-ai:hover .msg-ops { opacity: 1; }
.uop {
  padding: 2px 9px; border-radius: 6px; border: 1px solid var(--border);
  background: var(--bg-elevated); color: var(--text-faint); font-size: 11px; cursor: pointer;
  transition: all 0.12s;
}
.uop:hover { color: var(--accent); border-color: var(--accent-border); background: var(--accent-soft); }
.uop:active:not(:disabled) { background: var(--bg-active); }
.uop:disabled { opacity: 0.4; cursor: not-allowed; }
/* 图标形态的消息操作（📋 ✏️ 🔁）：无文字，稍大字号 + 紧凑内边距 */
.uop.ico { font-size: 13px; padding: 2px 8px; line-height: 1.2; }
.uop.primary { color: var(--accent); border-color: var(--accent-border); }
.edit-box { min-width: 420px; }
.edit-input {
  width: 100%; background: var(--bg); border: 1px solid var(--border);
  border-radius: 8px; color: var(--text); font-size: 13px; line-height: 1.6;
  padding: 8px 10px; resize: vertical; margin-bottom: 8px;
}
.edit-input:focus { outline: none; border-color: var(--accent-border); }
.edit-ops { display: flex; gap: 6px; justify-content: flex-end; }
.msg-meta { font-size: 11px; color: var(--text-faint); margin-bottom: 5px; display: flex; gap: 8px; align-items: center; }
/* 角色徽章：ASSISTANT 强调色 / USER 中性 / TOOL 次级色（9.5px mono 小 tag） */
.role-tag {
  font-family: var(--mono); font-size: 9.5px; font-weight: 600; letter-spacing: 0.05em;
  padding: 1px 6px; border-radius: 4px; white-space: nowrap;
}
.role-tag.assistant { background: var(--accent-soft); color: var(--accent); }
.role-tag.user { background: var(--bg-hover); color: var(--text-dim); }
.role-tag.tool { background: var(--bg-elevated); color: var(--text-dim); border: 1px solid var(--border); }
.meta-model { font-family: var(--mono); font-size: 10.5px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta-ts { font-family: var(--mono); font-size: 10px; color: var(--text-dim); white-space: nowrap; }
.meta-ts.streaming-hint { animation: meta-breathe 1.4s ease-in-out infinite; }
@keyframes meta-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

/* 思考过程折叠块：默认收起、弱化样式（斜体 + dim 色） */
.think-box { margin: 2px 0 8px; }
.think-box summary {
  font-size: 11.5px; color: var(--text-faint); cursor: pointer; user-select: none;
  font-style: italic; padding: 2px 0; list-style: none;
}
.think-box summary::-webkit-details-marker { display: none; }
.think-box summary:hover { color: var(--text-dim); }
.think-box summary::before { content: '▸ '; font-style: normal; }
.think-box[open] summary::before { content: '▾ '; font-style: normal; }
.think-body {
  margin-top: 4px; padding: 8px 12px; border-left: 2px solid var(--border-strong);
  font-size: 12px; font-style: italic; color: var(--text-dim); line-height: 1.7;
  white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow-y: auto;
}

/* 流式生成中：打字机光标（CSS blink，替代旧三点动画） */
.bubble.streaming::after {
  content: '▍'; color: var(--accent); font-weight: 600;
  animation: cursor-blink 1s steps(2, start) infinite;
}
@keyframes cursor-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

.imgs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
.imgs img { max-width: 200px; max-height: 150px; border-radius: 8px; display: block; }

/* 工具结果兜底容器（孤儿结果；常规工具卡已合并进 ToolCallCard 组件） */
.tool-msg { padding-left: 42px; }
/* 审批卡头部感叹徽标（ToolCallCard 外唯一保留的 tool-status 用法） */
.tool-status {
  width: 18px; height: 18px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center; font-size: 10px;
}
.tool-status.confirm { background: var(--red-soft); color: var(--red); }

/* 事件卡 */
.event-card {
  display: flex; align-items: flex-start; gap: 10px;
  margin: 12px 0 12px 42px; padding: 9px 14px;
  border-radius: 10px; font-size: 12.5px; color: var(--text-dim);
  border: 1px dashed var(--border); animation: fadeIn 0.15s ease-out;
  white-space: pre-wrap; word-break: break-word;
}
.event-ico { font-size: 13px; }
/* ACP 认证流：通知卡内的可点击登录链接（external_auth_required 分支） */
.auth-link { color: var(--accent); font-weight: 600; text-decoration: underline; margin-left: 4px; }

/* ══════════ 审批卡片 ══════════ */
.cards-zone { padding-top: 0; }
.cards-inner { max-width: 760px; margin: 0 auto; }
.approve-card {
  border: 1px solid var(--border); border-radius: 12px;
  padding: 12px 16px; margin-bottom: 10px; animation: fadeIn 0.15s ease-out;
}
.approve-card.confirm { border-color: rgba(248, 81, 73, 0.45); background: var(--red-soft); }
.approve-card.plan { border-color: rgba(210, 153, 34, 0.35); background: var(--orange-soft); }
.approve-card.ask { border-color: var(--accent-border); background: var(--accent-soft); }
.ac-head { font-weight: 600; font-size: 13px; display: flex; align-items: center; gap: 8px; }
.ac-reason { font-size: 12.5px; color: var(--text-dim); margin: 6px 0; }
.approve-card pre {
  font-family: var(--mono); font-size: 12px; background: var(--bg);
  border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;
  max-height: 160px; overflow: auto; margin: 6px 0; white-space: pre-wrap; word-break: break-word;
}
.ac-actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
/* ask_user 选项：一行一个（左对齐整行可点，长文本不换列挤压） */
.ask-options { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.ask-option {
  text-align: left; padding: 8px 12px; border-radius: 8px;
  border: 1px solid var(--accent-border); background: var(--bg-elevated);
  color: var(--text); font-size: 12.5px; line-height: 1.5; cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.ask-option:hover { background: var(--bg-hover); border-color: var(--accent); }
.ask-option:active { background: var(--bg-active); }
.plan-node { display: flex; align-items: center; gap: 8px; margin: 6px 0; flex-wrap: wrap; }
.plan-node .nid { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 4px; padding: 2px 6px; font-size: 11px; font-family: var(--mono); min-width: 30px; text-align: center; }
.plan-node .goal { flex: 1; min-width: 200px; padding: 5px 9px; font-size: 12.5px; }
.plan-node .deps { width: 150px; padding: 5px 9px; font-size: 12px; }
.plan-node .crit { font-size: 11.5px; color: var(--text-dim); display: flex; align-items: center; gap: 3px; }
.btn.danger-btn { background: var(--red); border-color: var(--red); color: #fff; font-weight: 600; }
.btn.danger-btn:disabled { opacity: 0.4; }
.ask-input { width: 100%; margin-top: 8px; padding: 8px 11px; }

/* ══════════ 输入区 ══════════ */
.composer-wrap { padding: 0 24px 10px; }
/* F-55 外部会话降级提示条（info 条视觉：accent 软底 + 常驻，可关闭）
   宽度与 .composer 对齐（max-width 760 居中），避免比输入框更宽显得游离在外 */
.external-bar {
  display: flex; align-items: flex-start; gap: 8px;
  max-width: 760px; margin: 0 auto 8px;
  padding: 7px 8px 7px 10px;
  border: 1px solid var(--accent-border); border-radius: 8px;
  background: var(--accent-soft); font-size: 12px; color: var(--text-dim);
}
.eb-ico { flex: none; color: var(--accent); font-size: 12.5px; line-height: 18px; }
.eb-main {
  flex: 1; min-width: 0;
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  line-height: 18px;
}
.eb-title { color: var(--text); font-weight: 600; white-space: nowrap; }
.eb-model {
  font-family: var(--mono); font-size: 11px; color: var(--accent);
  background: var(--bg); border: 1px solid var(--accent-border);
  border-radius: 4px; padding: 0 5px; line-height: 16px;
}
.eb-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.eb-tag {
  border: 1px solid var(--border); border-radius: 999px;
  padding: 0 7px; font-size: 11px; line-height: 16px;
  color: var(--text-dim); white-space: nowrap;
}
.eb-close {
  flex: none; width: 18px; height: 18px; line-height: 1;
  border: none; border-radius: 5px; background: transparent;
  color: var(--text-faint); font-size: 14px; cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.eb-close:hover { background: var(--bg-hover); color: var(--text); }
.composer {
  max-width: 760px; margin: 0 auto; position: relative;
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: var(--radius-lg); padding: 12px 14px 10px;
  transition: border-color 0.12s ease-out;
}
/* 聚焦：只把边框提到 border-strong，不加外发光 */
.composer:focus-within {
  border-color: var(--border-strong);
}
.ac-panel {
  position: absolute; left: 10px; right: 10px; bottom: calc(100% + 6px);
  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 10px;
  box-shadow: var(--shadow-pop); overflow: hidden; z-index: 30;
  max-height: 300px; overflow-y: auto;
}
.ac-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 6px 10px; border: none; background: none; color: var(--text);
  font-size: 12.5px; cursor: pointer; text-align: left;
}
.ac-item:hover, .ac-item.active { background: var(--accent-soft); }
.ac-ico { flex-shrink: 0; }
.ac-label { font-family: var(--mono); color: var(--accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 60%; }
.ac-detail { color: var(--text-faint); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-left: auto; }
.ac-tip { padding: 4px 10px; border-top: 1px solid var(--border); color: var(--text-faint); font-size: 10.5px; }
.composer textarea {
  width: 100%; background: transparent; border: none; outline: none;
  color: var(--text); font-size: 13px; resize: none; height: 44px; line-height: 1.5;
  padding: 0; border-radius: 0;
  transition: height 0.12s;
}
/* 拖拽调高过程中关闭过渡，跟手 */
.composer.resizing textarea { transition: none; }
/* 高度拖拽手柄：贴上/下边框整行热区，hover 显示居中 grip 条 */
.composer .rsz { position: absolute; left: 0; right: 0; height: 9px; cursor: ns-resize; z-index: 6; }
.composer .rsz.top { top: -2px; }
.composer .rsz.bottom { bottom: -2px; }
.composer .rsz::after {
  content: ''; position: absolute; left: 50%; transform: translateX(-50%);
  width: 42px; height: 3px; border-radius: 2px; background: transparent; transition: background 0.15s;
}
.composer .rsz.top::after { top: 3px; }
.composer .rsz.bottom::after { bottom: 3px; }
.composer .rsz:hover::after { background: var(--text-faint); }
.composer textarea:focus { border: none; }
/* composer 自带 focus-within 高亮，屏蔽全局 focus-visible outline 避免双重视觉态 */
.composer textarea:focus-visible { outline: none; }
.composer textarea:disabled { opacity: 0.6; }
/* 工具栏：左组附件/引用 ｜ 竖分隔线 ｜ 右组模式/权限；单行收敛，窄屏允许 wrap */
.composer-tools {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding-bottom: 8px; margin-bottom: 9px; border-bottom: 1px solid var(--border);
}
.tool-group { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tool-divider { width: 1px; height: 16px; background: var(--border); flex: none; }
/* 附件/引用 chip：图标 + 短文案，24px 高；hover 背景提升，active 加深一档 */
.tool-chip {
  display: inline-flex; align-items: center; gap: 4px;
  height: 24px; padding: 0 9px; border: none; border-radius: 7px;
  background: transparent; color: var(--text-faint);
  font-size: 11.5px; white-space: nowrap; cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.tool-chip:hover { background: var(--bg-hover); color: var(--text-dim); }
.tool-chip:active { background: var(--bg-active); color: var(--text); }
/* 运行中轻量降级：整体 opacity（按钮仍可点，保留紧急停止入口）+ 顶部细提示行 */
.composer.degraded { opacity: 0.75; }
/* 运行中提示行动效：呼吸圆点（仅 opacity，禁止流光 / 缩放） */
.composer-hint {
  font-size: 11px; color: var(--orange); background: var(--orange-soft);
  border-radius: var(--radius-sm); padding: 4px 9px; margin-bottom: 8px;
  display: flex; align-items: center; gap: 6px;
}
.composer-hint::before {
  content: ''; flex: none; width: 6px; height: 6px; border-radius: 50%;
  background: var(--orange); animation: dot-breathe 1.2s ease-in-out infinite;
}
/* 工具栏 chip 禁用态（运行中置灰，title 已提示「停止后可继续」） */
.tool-chip:disabled { opacity: 0.45; cursor: not-allowed; }
.tool-chip:disabled:hover { background: transparent; color: var(--text-faint); }
/* /mcp 无点击行为：仅 tooltip 说明，不可激活 */
.tool-chip.static { cursor: default; }
.tool-chip.static:active { background: var(--bg-hover); color: var(--text-dim); }
/* 模式/权限 select：紧凑 pill（27px 高、自定义 ▾ caret、bg-elevated + border） */
.mode-select {
  appearance: none; -webkit-appearance: none;
  height: 27px; padding: 0 24px 0 10px;
  font-size: 11.5px; color: var(--text-dim); font-family: inherit;
  background: var(--bg-elevated)
    url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5' viewBox='0 0 8 5'%3E%3Cpath d='M0 0l4 5 4-5z' fill='%236b7280'/%3E%3C/svg%3E")
    no-repeat right 8px center;
  border: 1px solid var(--border); border-radius: 8px; cursor: pointer;
  transition: border-color 0.12s, color 0.12s, background-color 0.12s;
}
.mode-select:hover:not(:disabled) { background-color: var(--bg-hover); border-color: var(--border-strong); color: var(--text); }
.mode-select:focus-visible { outline: none; border-color: var(--accent-border); }
.mode-select:disabled { opacity: 0.5; cursor: not-allowed; }
.mode-select option { background: var(--bg-elevated); color: var(--text); }
/* 权限选择器：yolo 高亮警示（全部放行状态一眼可辨） */
.perm-select.yolo { color: var(--orange); border-color: var(--orange); background-color: var(--orange-soft); font-weight: 600; }
/* 能力说明行：textarea 与操作区之间的 11px 小字 */
.composer-cap {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin-top: 6px; font-size: 11px; color: var(--text-faint);
}
.cap-left { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cap-right { display: inline-flex; align-items: center; gap: 5px; flex: none; white-space: nowrap; transition: color 0.15s; }
.composer-cap .kbd { font-size: 10px; }
/* composer 聚焦时快捷键提示提亮一档 */
.composer:focus-within .cap-right { color: var(--text-dim); }
.composer:focus-within .cap-right .kbd { color: var(--text-dim); border-color: var(--border-strong); }
/* 底部操作区：左=git 状态（项目/分支/Worktree，可收缩省略），右=模型选择 + 暂停/停止/发送 */
.composer-actions { display: flex; align-items: center; gap: 12px; margin-top: 8px; justify-content: flex-end; min-width: 0; }
/* 窄屏降级：git 状态整行让出（100% 基础宽度），避免与模型选择挤在同一行被压成省略号 */
@media (max-width: 1023px) {
  .composer-actions { flex-wrap: wrap; row-gap: 8px; }
  .composer-actions :deep(.git-bar) { flex: 1 0 100%; }
}
/* 发送：28px 圆形按钮；有内容时 bg #e8e8e8 + 黑色图标，无内容时 elevated-2 + 灰图标 */
.send-btn {
  width: 28px; height: 28px; padding: 0; border: none; border-radius: var(--radius-pill);
  background: var(--bg-elevated-2); flex: none;
  color: var(--text-faint); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.12s ease-out, color 0.12s ease-out;
}
.send-btn svg { width: 14px; height: 14px; }
.send-btn:hover:not(:disabled) { background: var(--bg-active); color: var(--text-dim); }
.send-btn:disabled { cursor: not-allowed; }
/* 有内容（启用）态：亮底黑图标 */
.send-btn:not(:disabled) { background: #e8e8e8; color: #111; }
/* 模型选择器胶囊：28px 高、左侧小方块图标、文字可截断、右 ▾ caret、bg-elevated + border-subtle */
.composer-model {
  appearance: none; -webkit-appearance: none;
  flex: none; max-width: 220px; height: 28px;
  padding: 0 24px 0 26px;
  color: var(--text-dim); font-size: 12px; font-family: var(--mono);
  text-overflow: ellipsis;
  background-color: var(--bg-elevated);
  background-image:
    url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5' viewBox='0 0 8 5'%3E%3Cpath d='M0 0l4 5 4-5z' fill='%236b6b6b'/%3E%3C/svg%3E"),
    linear-gradient(#e8e8e8, #e8e8e8);
  background-repeat: no-repeat, no-repeat;
  background-position: right 8px center, left 10px center;
  background-size: 8px 5px, 8px 8px;
  border: 1px solid var(--border); border-radius: var(--radius-md); cursor: pointer;
  transition: border-color 0.12s ease-out, color 0.12s ease-out, background-color 0.12s ease-out;
}
.composer-model:hover { background-color: var(--bg-elevated-2); border-color: var(--border-strong); color: var(--text); }
.composer-model:focus-visible { outline: none; border-color: var(--accent-border); }
.composer-model option { background: var(--bg-elevated); color: var(--text); }
/* 停止 / 暂停：28px 圆形小钮（停止实心危险红；暂停中性描边圆钮） */
.stop-btn {
  width: 28px; height: 28px; padding: 0; border: 1px solid var(--red); flex: none;
  border-radius: var(--radius-pill); background: var(--red); color: #fff;
  font-size: 10px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.12s ease-out, border-color 0.12s ease-out, color 0.12s ease-out;
}
.stop-btn:hover { background: rgba(232, 69, 60, 0.85); }
.stop-btn:active { background: rgba(232, 69, 60, 0.7); }
.stop-btn.pause { border-color: var(--border-strong); background: var(--bg-elevated); color: var(--text-dim); }
.stop-btn.pause:hover { background: var(--bg-elevated-2); color: var(--text); border-color: var(--text-faint); }
.stop-btn.pause:active { background: var(--bg-active); }
.kbd { font-family: var(--mono); font-size: 10.5px; border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; color: var(--text-faint); }
/* 发送按钮内的快捷键块：蓝底上用纯白，避免暗色块看起来像渲染异常 */
.send-btn .kbd { color: #fff; border-color: rgba(255, 255, 255, 0.6); font-size: 10px; }
.pending-imgs { display: flex; gap: 8px; margin-bottom: 8px; }
/* F-39：专家胶囊行（与 .pending-imgs 同一 flex 基类语义；容器分离，互不清空） */
.composer-caps { display: flex; gap: 8px; margin-bottom: 8px; }
/* F-39：专家团成员卡列表（消息流尾部，实时态） */
.expert-delegations { display: flex; flex-direction: column; gap: 4px; margin: 8px 0; }
.thumb { position: relative; display: inline-block; }
.thumb img { width: 52px; height: 52px; object-fit: cover; border-radius: 7px; border: 1px solid var(--border); display: block; }
.thumb .rm {
  position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 50%;
  border: none; background: var(--red); color: #fff; font-size: 12px; line-height: 18px; padding: 0; cursor: pointer;
}

/* 弹窗内共用 */
.modal-tip { font-size: 13px; color: var(--text-dim); line-height: 1.7; margin-bottom: 12px; }
.modal-tip b { color: var(--text); }
.modal-tip-sub { font-size: 12px; color: var(--text-faint); }
.full { width: 100%; margin-bottom: 12px; }
/* 注册项目：路径输入 + 「选择文件夹…」（桌面壳桥接可用时展示）同行排布（.full 自带 12px 下边距，行内归零） */
.path-row { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
.path-row .full, .path-row .btn { margin-bottom: 0; }
/* 桌面形态下路径框只读：视觉上区分「可编辑 / 只能选择」 */
.path-row input[readonly] { color: var(--text-dim); background: var(--bg-elevated); cursor: default; }
.path-row .btn { flex: 0 0 auto; white-space: nowrap; }
.error { color: var(--red); font-size: 12.5px; margin-bottom: 8px; }
.modal-btns { display: flex; gap: 10px; justify-content: flex-end; }

/* ══════════ 底部 dock（<768px；rail 隐藏后入口下沉） ══════════ */
.dock { display: none; }

/* ══════════ 响应式：<1024px 侧栏抽屉；<768px 隐藏 rail 改底部 dock ══════════ */
@media (max-width: 1023px) {
  .tabbar__menu {
    display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; flex-shrink: 0; margin-right: 2px;
    border: none; border-radius: var(--radius-sm); background: transparent;
    color: var(--text-dim); cursor: pointer;
    transition: background 0.12s ease-out, color 0.12s ease-out;
  }
  .tabbar__menu svg { width: 16px; height: 16px; }
  .tabbar__menu:hover { background: var(--bg-elevated-2); color: var(--text); }
  /* 侧栏改为固定抽屉，脱离文档流，主区占满 */
  .sidebar {
    position: fixed; left: 48px; top: 0; bottom: 0; z-index: 50;
    transform: translateX(-110%);
    transition: transform 0.15s ease-out;
  }
  .app.sidebar-open .sidebar { transform: none; }
  .sidebar-backdrop { display: block; position: fixed; inset: 0; z-index: 45; background: rgba(0, 0, 0, 0.45); }
}
@media (max-width: 767px) {
  /* 隐藏图标栏，入口下沉底部 dock */
  .rail { display: none; }
  .sidebar { left: 0; width: 260px; }
  .dock {
    display: flex; position: fixed; left: 0; right: 0; bottom: 0; z-index: 60;
    height: 48px; background: var(--bg-chrome); border-top: 1px solid var(--border);
    align-items: center; justify-content: space-around; padding: 0 8px;
  }
  .dock__btn {
    width: 36px; height: 36px; border: none; border-radius: var(--radius-md);
    background: transparent; color: #8a8a8a; cursor: pointer; text-decoration: none;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.12s ease-out, color 0.12s ease-out;
  }
  .dock__btn svg { width: 22px; height: 22px; }
  .dock__btn:hover, .dock__btn.router-link-active { color: var(--text); }
  .dock__btn.router-link-active { position: relative; }
  .dock__btn.router-link-active::before {
    content: ''; position: absolute; top: 2px; left: 7px; right: 7px; height: 2px;
    border-radius: 1px; background: var(--accent);
  }
  /* 主区与右侧栏给底部 dock 让位 */
  .app { height: calc(100vh - 48px); }
  .right-col { display: none; }
  /* 消息列收窄边距 */
  .chat-inner { padding: 0 12px; }
  .composer-wrap { padding: 0 12px 10px; }
  .msg-user .ai-col { max-width: 85%; }
  /* 模型胶囊在窄屏可伸缩截断 */
  .tabbar__model { max-width: 140px; min-width: 0; }
  .tabbar__tab { max-width: 200px; }
}
</style>
