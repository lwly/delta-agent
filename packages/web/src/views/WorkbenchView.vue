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
// 架构收口 T9：配对/状态推导收敛到共享纯函数（与任务详情、回放页同一实现）
import {
  agentLabelOf,
  collectCallInfos,
  collectToolResults,
  isRejectedContent,
  orphanCardOf,
  toolCardOf as toolCardOfShared,
  type TranscriptToolCard,
  type ToolCallInfo,
} from '../composables/useSessionTranscript';
// F-39：ExpertDetail 在根级渲染（见模板尾部）
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

/** 是否处于工作台子路由（定时任务 /cron、用量 /usage）：主区渲染 <router-view>，对话流/输入区不渲染 */
const isSubRoute = computed(() => route.path.startsWith('/cron') || route.path.startsWith('/usage'));

/** 标签栏会话 tab 标题：当前会话 > 当前项目 > 兜底 */
const tabTitle = computed(() => chat.sessionMeta?.title || activeProjectName.value || '工作台');
/** 会话列表头像蓝/红渐变交替（纯展示：按会话 id 哈希决定色调，不参与任何业务） */
function avatarTone(id: string): 'blue' | 'red' {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 2 === 0 ? 'blue' : 'red';
}

const error = ref('');
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

// ⌘B / Ctrl+B：开合右侧文件面板（F-38，与顶栏 📁 按钮等价）
function onGlobalKeydown(e: KeyboardEvent) {
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
  void refreshProviders();
});

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
/** F-39：返回新会话 id（null = 失败；失败方只写 error 不推提示，调用方据返回值决定是否推成功提示） */
async function newSession(mode?: string, expert?: string): Promise<string | null> {
  if (!ws.activeProjectId) {
    error.value = '请先在「项目管理」注册并选择项目';
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

// 「由 X 执行」标签（agentLabelOf）已收敛到共享模块 useSessionTranscript（T9）

async function openSession(id: string) {
  error.value = '';
  try {
    if (isSubRoute.value) {
      await router.push({ path: '/', query: { session: id } });
      return;
    }
    await chat.open(id);
    await router.replace({ path: '/', query: { ...route.query, session: id } });
  } catch (e) {
    error.value = (e as Error).message;
  }
}

/** 深链 /?session=：打开对应会话（项目管理页跳转后消费） */
async function openSessionFromQuery(id: string) {
  if (chat.sessionId === id && chat.sessionMeta) return;
  error.value = '';
  try {
    await chat.open(id);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

watch(
  () => route.query.session,
  (raw) => {
    const id = typeof raw === 'string' ? raw : '';
    if (!id || route.path !== '/') return;
    void openSessionFromQuery(id);
  },
  { immediate: true },
);

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
 * T9：两处收集逻辑收敛到共享 collectCallInfos / collectToolResults（判据 1，
 * 与任务详情 composable / 回放页同一实现）
 */
const callInfoMap = computed(() => collectCallInfos(chat.messages, chat.pendingCalls));

const resultMap = computed(() => collectToolResults(chat.messages));

/** ToolCallCard 的 props 集合（状态 / 结果 / 耗时 / 序号一次算好） */
// T9：ToolCardProps / toolCardOf / orphanCard 收敛到共享模块（useSessionTranscript
// 的 TranscriptToolCard / toolCardOf / orphanCardOf），状态推导（running/ok/fail、
// rejected_by_user、agent 角标、懒加载字段）三处同源。
type ToolCardProps = TranscriptToolCard;
function toolCardOf(id: string, name: string, argsJson: string): ToolCardProps {
  return toolCardOfShared(id, name, argsJson, resultMap.value.get(id), callInfoMap.value.get(id));
}
/** 助手消息上的调用 → 完整工具卡（结果未到 = 运行中态） */
function cardsFor(m: ChatMessage): ToolCardProps[] {
  return (m.toolCalls ?? []).map((c) => toolCardOf(c.id, c.name, c.argsJson));
}
/** 孤儿结果卡兜底：结果消息找不到任何调用记录时，仍以结果为主体渲染一张卡 */
function orphanCard(m: ChatMessage): ToolCardProps {
  const info = m.toolCallId ? callInfoMap.value.get(m.toolCallId) : undefined;
  return orphanCardOf(m, info);
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

/** 任务台右侧抽屉开合（tabbar 最右侧入口；详情面板 z-index 更高可叠加打开） */
const showTaskDrawer = ref(false);

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
    if (running !== prev) void ws.refreshRunning();
  },
);
</script>

<template>
  <div class="workbench" :class="{ 'panel-open': panel.open }">
    <!-- ══════════ 主区域 ══════════ -->
    <main class="main">
      <!-- ══════════ 标签栏 tabbar（40px；chrome 底色，子路由页共用） ══════════ -->
      <div class="tabbar">
        <!-- 会话 tab：20px 头像 + 标题；有会话时 hover 显示关闭（仅关视图，不动会话数据） -->
        <div class="tabbar__tab tabbar__tab--active">
          <span class="tabbar__avatar" :class="chat.sessionId ? `tabbar__avatar--${avatarTone(chat.sessionId)}` : ''">
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2.6 14.5 9l6.7.3-5.3 4.2 1.9 6.6L12 16.3 6.2 20.1l1.9-6.6L2.8 9.3 9.5 9z" /></svg>
          </span>
          <span class="tabbar__title" :title="tabTitle">{{ tabTitle }}</span>
          <button v-if="chat.sessionId" class="tabbar__close" type="button" title="关闭会话视图" @click.stop="chat.close(); void router.replace({ path: '/', query: {} })">
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
        <!-- F-58b 任务台入口：tabbar 最右侧菜单按钮（点击右侧抽屉；interrupt 红点角标） -->
        <button
          class="cfg-op taskboard-toggle"
          :class="{ active: showTaskDrawer }"
          type="button"
          :title="showTaskDrawer ? '收起任务台' : '任务台'"
          :aria-pressed="showTaskDrawer"
          @click="showTaskDrawer = !showTaskDrawer"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4.5" width="16" height="15" rx="2.5" /><path d="M8 9.5h8" /><path d="M8 13h8" /><path d="M8 16.5h5" /></svg>
          <span v-if="tasksStore.interruptCount > 0" class="taskboard-badge">{{ tasksStore.interruptCount > 99 ? '99+' : tasksStore.interruptCount }}</span>
        </button>
      </div>
      <!-- 工作台子路由（/cron 定时任务、/usage 用量）：主区整块交给子路由视图（侧栏常驻），对话流 / 输入区不渲染 -->
      <router-view v-if="isSubRoute" />
      <template v-else>
        <!-- 无打开会话：引导至项目管理 / 委派任务 -->
        <div v-if="!chat.sessionId" class="hero empty-start">
          <h2 class="empty-title">工作台</h2>
          <p class="home-sub">在「项目管理」打开或新建对话，或在「委派任务」派发后台任务。</p>
          <div class="empty-links">
            <router-link class="empty-link" to="/projects">项目管理</router-link>
            <router-link class="empty-link" to="/tasks">委派任务</router-link>
          </div>
          <p v-if="error" class="error">✘ {{ error }}</p>
        </div>

      <template v-else-if="chat.sessionMeta">
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

    <!-- ══════════ 任务台右侧抽屉（tabbar 最右侧入口；F-58b 入口从侧栏移至此） ══════════ -->
    <aside v-if="showTaskDrawer" class="task-drawer">
      <TaskBoard closable @close="showTaskDrawer = false" />
    </aside>

    <!-- ══════════ 任务详情右滑面板（tasks.openTaskId 驱动；轻首页/任务台共用） ══════════ -->
    <TaskDetailPanel />

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
.workbench { display: flex; flex: 1; min-height: 0; height: 100%; width: 100%; position: relative; }
/* F-47 右侧栏列容器：文件面板占满剩余高度，内置终端 300px 停靠其下。
   宽度跟随文件面板的行内 width；仅终端（面板收起）时兜底最小宽度 */
.right-col { display: flex; flex-direction: column; height: 100%; flex: 0 0 auto; min-width: 360px; }
.right-col:has(.file-panel) { min-width: 0; }
.right-col .file-panel { flex: 1 1 0; height: auto; min-height: 0; }
/* F-38：面板展开时主区最小宽度 480px（PRD F-38-1）；窄屏覆盖式面板不挤压主区 */
.workbench.panel-open .main { min-width: 480px; }

@keyframes dot-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.btn-sm {
  padding: 7px 12px; border-radius: 7px;
  border: 1px solid var(--border); background: var(--bg-elevated);
  color: var(--text); font-size: 12.5px; cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.btn-sm:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
.btn-sm:disabled { opacity: 0.4; cursor: not-allowed; }

/* ══════════ 主区域 ══════════ */
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

/* 轻首页（委派式工作台）：居中 slogan + 输入即派任务 + 状态分组任务列表 */
.hero {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; padding: 24px; overflow-y: auto;
}
.empty-start { gap: 14px; max-width: 420px; margin: 0 auto; width: 100%; text-align: center; }
.empty-title { font-size: 20px; font-weight: 600; margin: 0; color: var(--text); }
.empty-links { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
.empty-link {
  padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--bg-elevated); color: var(--text); font-size: 13px; text-decoration: none;
  transition: background 0.12s, border-color 0.12s;
}
.empty-link:hover { background: var(--bg-hover); border-color: var(--border-strong); }
.home-sub { color: var(--text-faint); font-size: 12.5px; text-align: center; }
/* 任务台入口（tabbar 最右侧）：按钮 + interrupt 红点角标（样式对齐 rail__badge 口径） */
.taskboard-toggle { position: relative; }
.taskboard-badge {
  position: absolute; top: 1px; right: 1px;
  min-width: 14px; height: 14px; padding: 0 4px;
  border-radius: var(--radius-pill, 999px); background: var(--red); color: #fff;
  font-size: 10px; line-height: 14px; text-align: center;
}
/* 任务台右侧抽屉：非模态（不挡主区点击），详情面板（z-index 60）可叠加其上 */
.task-drawer {
  position: fixed; top: 0; right: 0; bottom: 0;
  width: 300px; max-width: 86vw;
  z-index: 55;
  display: flex; flex-direction: column;
  background: var(--bg-chrome);
  border-left: 1px solid var(--border);
  animation: task-drawer-in 0.18s ease-out;
}
@keyframes task-drawer-in {
  from { transform: translateX(24px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

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
/* 消息流与 .composer 同宽：内容列最大 912 居中（原 760 扩宽 20%），左右 padding 24 */
.chat-inner { max-width: 960px; margin: 0 auto; padding: 0 24px; }
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
.cards-inner { max-width: 912px; margin: 0 auto; }
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
   宽度与 .composer 对齐（max-width 912 居中），避免比输入框更宽显得游离在外 */
.external-bar {
  display: flex; align-items: flex-start; gap: 8px;
  max-width: 912px; margin: 0 auto 8px;
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
  max-width: 912px; margin: 0 auto; position: relative;
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

@media (max-width: 767px) {
  .workbench { min-height: 0; }
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
