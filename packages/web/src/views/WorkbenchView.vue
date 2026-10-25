<script setup lang="ts">
// 工作台主页（对齐 prototype/index.html 高保真原型）：
// 左侧「项目 × 会话」树形侧边栏 + 主区对话流（工具卡片/事件卡/审批卡）+ 底部输入区
// 模型配置（记忆/配置/用量已迁移至独立设置页 /settings）；设置入口固定在侧栏底部（Token 用量条上方），角标保留待确认记忆提示；
// 定时任务为工作台子路由 /cron（侧栏常驻，主区按路由切换）；回收站 / 检索仍为弹窗；回放走独立路由 /replay/:sessionId
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useWorkspaceStore } from '../stores/workspace';
import { useChatStore } from '../stores/chat';
import { api, type ChatMessage, type MessageHit, type MessageImage, type ProviderView, type SkillCandidate } from '../api/client';
import { renderMarkdown } from '../render';
import ModalShell from '../components/ModalShell.vue';
import TrashModal from '../components/TrashModal.vue';
import SearchModal from '../components/SearchModal.vue';
import GitStatusBar from '../components/GitStatusBar.vue';
import ToolCallCard from '../components/ToolCallCard.vue';
import RunStatusBar from '../components/RunStatusBar.vue';

const ws = useWorkspaceStore();
const chat = useChatStore();
const route = useRoute();

/** 是否处于定时任务子路由：主区渲染 <router-view>，对话流/输入区不渲染 */
const isCronRoute = computed(() => route.path.startsWith('/cron'));

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

// ⌘K / Ctrl+K 全局快捷键：打开会话检索弹窗（仅新增入口，不改动既有逻辑）
function onGlobalKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    showSearch.value = true;
  }
}
onMounted(() => window.addEventListener('keydown', onGlobalKeydown));
onUnmounted(() => window.removeEventListener('keydown', onGlobalKeydown));
/** hero 快捷键提示的平台检测：macOS 显示 ⌘K，其余显示 Ctrl+K */
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

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
    const res = await fetch('/api/providers');
    const json = await res.json();
    // serve 未挂 ProviderManager 时该端点 404/返回错误对象，退化为空列表
    providers.value = Array.isArray(json) ? (json as ProviderView[]) : [];
  } catch {
    // Provider 列表不可用时模型下拉退化为当前会话模型
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

async function newSession(mode?: string) {
  if (!ws.activeProjectId) {
    error.value = '请先选择或注册一个项目';
    return;
  }
  try {
    const s = await ws.createSession({
      title: `新对话 ${new Date().toLocaleString('zh-CN')}`,
      mode: mode ?? modeChoice.value,
      model: preferredModel.value || undefined,
    });
    await openSession(s.id);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function openSession(id: string) {
  error.value = '';
  try {
    await chat.open(id);
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
  const cur = chat.sessionMeta?.model;
  if (cur && !opts.some((o) => o.value === cur)) opts.unshift({ value: cur, label: cur });
  return opts;
});

function onModelChange(ev: Event) {
  const v = (ev.target as HTMLSelectElement).value;
  preferredModel.value = v;
  localStorage.setItem('yz.preferredModel', v);
  chat.notice(`已记录模型偏好：${v}（对新建对话生效）`);
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
const COMPOSER_H_KEY = 'yzero-composer-h';
const COMPOSER_TOUCHED_KEY = 'yzero-composer-h-touched';
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
  };
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
}
function jumpToBottom() {
  listRef.value?.scrollTo({ top: listRef.value.scrollHeight, behavior: 'smooth' });
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
/** 保存编辑并重发（作为一条新的用户消息发送） */
async function resendEdit() {
  const text = editText.value.trim();
  if (!text || chat.running) return;
  cancelEdit();
  await chat.send(text);
}
/** 原样重发该消息 */
async function resend(m: { content: string }) {
  if (chat.running || !m.content.trim()) return;
  await chat.send(m.content);
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
const EMPTY_PROMPTS = ['帮我审查这段代码', '创建一个 Vue3 组件', '解释这个报错原因'] as const;
function fillPrompt(text: string) {
  input.value = text;
  void nextTick(() => {
    const ta = composerEl.value;
    if (!ta) return;
    ta.focus();
    const pos = input.value.length;
    ta.setSelectionRange(pos, pos);
  });
}

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

// 消息增长 / 流式输出时滚到底部；运行结束后刷新今日 token 与待确认记忆角标
watch(
  () => [chat.messages.length, chat.streamingText],
  async () => {
    await nextTick();
    listRef.value?.scrollTo({ top: listRef.value.scrollHeight });
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
  <div class="app">
    <!-- 项目菜单打开时的点击外部关闭层 -->
    <div v-if="projectMenuFor" class="menu-overlay" @click="projectMenuFor = ''" />
    <!-- ══════════ 侧边栏（五段式：品牌 / 全局操作 / 会话列表 / 底部功能） ══════════ -->
    <aside class="sidebar">
      <!-- 品牌区：图标 + 名称 + 版本，紧凑成组 -->
      <div class="brand">
        <span class="brand-logo">y0</span>
        <span class="brand-text">
          <span class="brand-name">y-zero-agent</span>
          <span class="brand-sub">AI Coding Agent · v0.1.0</span>
        </span>
      </div>

      <!-- 全局操作区：定时任务 / 新项目 / 新对话 / 会话搜索 -->
      <div class="side-section">
        <nav class="side-nav">
          <router-link class="nav-item" to="/cron"><span class="ni-ico">⏰</span>定时任务</router-link>
        </nav>
        <div class="sidebar-actions">
          <button class="btn-sm" @click="showNewProject = true">＋ 新项目</button>
          <button class="btn-sm primary" :disabled="!ws.activeProjectId" @click="newSession()">＋ 新对话</button>
        </div>
        <div class="sidebar-search">
          <input placeholder="🔍 检索会话与消息…" readonly @click="showSearch = true" />
        </div>
      </div>

      <!-- 会话列表区：小节标题 + 项目 × 会话树 -->
      <div class="sidebar-scroll">
        <div class="section-title">会话</div>
        <p v-if="error" class="error">✘ {{ error }}</p>
        <div v-for="p in ws.projects" :key="p.id" class="project-group">
          <div class="project-header" :class="{ active: p.id === ws.activeProjectId && !chat.sessionId }" tabindex="0" @click="selectProject(p.id)">
            <span class="project-caret" :class="{ open: expanded.has(p.id) }">▶</span>
            <span class="project-dot" />
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
              <span class="session-icon">💬</span>
              <!-- 两行条目：第一行标题，第二行模式徽标 + 相对时间预览 -->
              <span class="session-main">
                <span class="session-title" :title="s.title">{{ s.title }}</span>
                <span class="session-sub">
                  <span class="mode-tag" :class="modeCls(s.mode)">{{ modeShort(s.mode) }}</span>
                  <span class="session-time" :title="s.updated_at">{{ relTime(s.updated_at) }}</span>
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
          </div>
        </div>
        <p v-if="ws.projects.length === 0" class="session-empty" style="padding: 10px 8px">
          还没有项目，点「＋ 新项目」注册本地仓库根目录。
        </p>
      </div>

      <!-- 底部功能区：设置（含待确认记忆角标）独立成组；Token 进度条；回收站 / 平台降为次级灰字 -->
      <div class="side-section bottom-group">
        <nav class="side-nav bottom">
          <router-link class="nav-item" to="/settings">
            <span class="ni-ico">⚙️</span>设置<span v-if="memoryPendingCount > 0" class="nav-badge">{{ memoryPendingCount }}</span>
          </router-link>
        </nav>
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
          </div>
        </div>
      </div>
    </aside>

    <!-- ══════════ 主区域 ══════════ -->
    <main class="main">
      <!-- 定时任务子路由：主区整块交给 CronView（侧栏常驻），对话流 / 输入区不渲染 -->
      <router-view v-if="isCronRoute" />
      <template v-else>
        <!-- 空态 hero：图标 / 产品名 / 价值主张 / 主行动 + 快捷键提示 / 次级入口 / 三特性卡 -->
        <div v-if="!chat.sessionId || !chat.sessionMeta" class="hero">
          <div class="hero-logo">y0</div>
          <h1>y-zero-agent</h1>
          <p class="hero-tagline">在本地仓库中推理、规划并执行你的开发任务</p>
          <div class="hero-actions">
            <button class="hero-btn primary" :disabled="!ws.activeProjectId" @click="newSession()">新建对话</button>
            <button class="hero-btn" @click="showNewProject = true">注册项目</button>
            <span class="kbd-hint" title="打开会话检索"><span class="kbd">{{ isMac ? '⌘ K' : 'Ctrl K' }}</span> 快速搜索</span>
          </div>
          <div class="hero-features">
            <div class="feature-card">
              <span class="f-ico">⚡</span>
              <span class="f-title">ReAct 推理</span>
              <span class="f-desc">思考-行动循环逐步调用工具，MCP 扩展任意外部能力</span>
            </div>
            <div class="feature-card">
              <span class="f-ico">📋</span>
              <span class="f-title">计划执行</span>
              <span class="f-desc">先拆解计划再逐步执行，关键节点支持人工审批</span>
            </div>
            <div class="feature-card">
              <span class="f-ico">🤖</span>
              <span class="f-title">多智能体</span>
              <span class="f-desc">子任务分派协作，上下文自动压缩不失真</span>
            </div>
          </div>
        </div>

      <template v-else>
        <!-- 顶栏：层级面包屑 + 回放（右侧） -->
        <div class="topbar">
          <nav class="crumb" aria-label="会话位置">
            <span class="crumb-seg crumb-brand" title="y-zero-agent">y-zero-agent</span>
            <span class="crumb-sep" aria-hidden="true">/</span>
            <span class="crumb-seg crumb-project" :title="activeProjectName || '未选择项目'">{{ activeProjectName || '未选择项目' }}</span>
            <span class="crumb-sep" aria-hidden="true">/</span>
            <span class="crumb-seg current" :title="chat.sessionMeta.title">{{ chat.sessionMeta.title }}</span>
          </nav>
          <router-link
            class="cfg-op replay"
            :class="{ disabled: chat.messages.length === 0 }"
            :to="`/replay/${chat.sessionId}`"
            :title="chat.messages.length === 0 ? '暂无可回放的会话内容' : '会话回放'"
            @click="onReplayClick"
          >▶ 回放</router-link>
        </div>

        <!-- 运行状态条（topbar 下、消息流上）：运行中/已暂停/已停止三态 + 暂停/停止/继续控制 -->
        <RunStatusBar @resume="resumeRun" />

        <!-- 消息流（含「回到底部」浮动按钮） -->
        <div class="chat-area">
          <div ref="listRef" class="chat-scroll" @scroll.passive="onChatScroll">
          <div class="chat-inner">
            <!-- 用户消息 -->
            <div v-for="(m, i) in chat.messages" :key="i">
              <div v-if="m.role === 'user'" class="msg msg-user">
                <span class="avatar user">👤</span>
                <div class="ai-col">
                  <!-- 元信息行：角色徽章 + 时间戳（仅实时到达消息有 ts） -->
                  <div class="msg-meta">
                    <span class="role-tag user">👤 USER</span>
                    <span v-if="m.ts" class="meta-ts">{{ fmtTs(m.ts) }}</span>
                  </div>
                  <!-- 编辑态：原文填入文本框，可改后重发 -->
                  <div v-if="editingIdx === i" class="bubble edit-box">
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
                      <button class="uop ico" title="编辑后重发" :disabled="chat.running" @click="startEdit(i, m)">✏️</button>
                      <button class="uop ico" title="原样重发" :disabled="chat.running" @click="resend(m)">🔁</button>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 助手消息 -->
              <div v-else-if="m.role === 'assistant'" class="msg msg-ai">
                <span class="avatar ai">y0</span>
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
                  <!-- 工具调用卡（调用 + 结果按 callId 合并；结果未到 = 运行中态） -->
                  <template v-for="c in cardsFor(m)" :key="c.callId">
                    <ToolCallCard v-bind="c" />
                  </template>
                </div>
              </div>

              <!-- 工具结果（已合并进上方调用卡则整条不渲染，避免空 .msg 产生累积空白）；仅孤儿结果在此兜底渲染 -->
              <div v-else-if="m.role === 'tool' && !(m.toolCallId && callInfoMap.has(m.toolCallId))" class="msg tool-msg">
                <div class="msg-meta">
                  <span class="role-tag tool">⚙ TOOL</span>
                  <span v-if="m.ts" class="meta-ts">{{ fmtTs(m.ts) }}</span>
                </div>
                <ToolCallCard v-bind="orphanCard(m)" />
              </div>
            </div>

            <!-- 流式中的助手输出：打字机光标 ▍（CSS blink） -->
            <div v-if="chat.streamingText" class="msg msg-ai">
              <span class="avatar ai">y0</span>
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
              <span class="event-text">{{ n.text }}</span>
            </div>

            <!-- 空对话引导：主标题 + 价值主张 + 示例提示词卡（点击填入不发送）+ 快捷键提示 -->
            <div v-if="chat.messages.length === 0 && !chat.streamingText" class="chat-empty">
              <h2 class="ce-title">开始你的第一个任务</h2>
              <p class="ce-sub">描述任务，Agent 将推理、执行工具并交付结果</p>
              <div class="ce-cards">
                <button v-for="t in EMPTY_PROMPTS" :key="t" class="ce-card" type="button" @click="fillPrompt(t)">{{ t }}</button>
              </div>
              <p class="ce-kbd-row">
                <span class="kbd">{{ isMac ? '⌘K' : 'Ctrl K' }}</span> 检索会话
                <span class="ce-dot">·</span>
                <span class="kbd">Enter</span> 发送
                <span class="ce-dot">·</span>
                <span class="kbd">Shift+Enter</span> 换行
                <span class="ce-dot">·</span>
                <span class="kbd">{{ isMac ? '⌘Enter' : 'Ctrl+Enter' }}</span> 发送
              </p>
            </div>
          </div>
          </div>
          <!-- 回到底部：距底 > 200px 时出现 -->
          <button v-if="showJump" class="jump-btn" type="button" @click="jumpToBottom">↓ 回到底部</button>
        </div>

        <!-- 审批卡片区 -->
        <div class="composer-wrap cards-zone">
          <div class="cards-inner">
            <!-- 工具确认 -->
            <div v-if="chat.pendingConfirm" class="approve-card confirm">
              <div class="ac-head"><span class="tool-status confirm">!</span> 需要确认：{{ chat.pendingConfirm.tool }}</div>
              <div class="ac-reason">{{ chat.pendingConfirm.reason }}</div>
              <pre>{{ argsPretty(JSON.stringify(chat.pendingConfirm.args)) }}</pre>
              <div class="ac-actions">
                <button class="btn primary" @click="chat.decideConfirm({ kind: 'allow' })">允许</button>
                <button class="btn" @click="chat.decideConfirm({ kind: 'reject' })">拒绝</button>
              </div>
            </div>

            <!-- 计划审批（可编辑节点） -->
            <div v-if="chat.pendingPlan" class="approve-card plan">
              <div class="ac-head">📋 计划审批（rev {{ chat.pendingPlan.plan.revision }} · {{ chat.pendingPlan.plan.nodes.length }} 节点）</div>
              <div class="ac-reason">总目标：{{ chat.pendingPlan.plan.goal }}</div>
              <div v-for="(n, i) in chat.pendingPlan.plan.nodes" :key="n.id" class="plan-node">
                <code class="nid">{{ n.id }}</code>
                <input class="goal" v-model="n.goal" placeholder="子任务目标" />
                <input
                  class="deps"
                  :value="n.deps.join(',')"
                  placeholder="依赖（逗号分隔）"
                  @change="n.deps = ($event.target as HTMLInputElement).value.split(',').map(s => s.trim()).filter(Boolean)"
                />
                <label class="crit"><input v-model="n.critical" type="checkbox" />critical</label>
                <button class="btn danger sm" @click="chat.pendingPlan?.plan.nodes.splice(i, 1)">删除</button>
              </div>
              <div class="ac-actions">
                <button class="btn primary" @click="chat.decidePlan({ kind: 'edit' })">按此计划执行</button>
                <button class="btn" @click="chat.decidePlan({ kind: 'reject' })">跳过计划（直接执行）</button>
              </div>
            </div>

            <!-- Agent 提问 -->
            <div v-if="chat.pendingAsk" class="approve-card ask">
              <div class="ac-head">❓ {{ chat.pendingAsk.question }}</div>
              <div v-if="chat.pendingAsk.options?.length" class="ac-actions">
                <button v-for="o in chat.pendingAsk.options" :key="o" class="btn" @click="chat.answerAsk(o)">{{ o }}</button>
              </div>
              <input
                class="ask-input"
                placeholder="输入回答后回车"
                @keyup.enter="chat.answerAsk(($event.target as HTMLInputElement).value); ($event.target as HTMLInputElement).value = ''"
              />
            </div>
          </div>
        </div>

        <!-- 输入区（运行中整体轻量降级：opacity 0.75 + 顶部细提示行，不做遮挡，保留紧急停止入口） -->
        <div class="composer-wrap">
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
              </div>
              <span class="tool-divider" aria-hidden="true" />
              <div class="tool-group">
                <!-- 当前会话模式下拉：模式在会话创建时确定，切换 = 以该模式新建对话 -->
                <select
                  class="mode-select"
                  :value="chat.sessionMeta.mode"
                  :disabled="chat.running"
                  title="当前执行模式（Agent 运行中不可切换，停止后可继续）"
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
            <!-- 底部操作区：模型选择（右下角，对齐 WorkBuddy）+ 暂停/停止/发送 -->
            <div class="composer-actions">
              <select class="composer-model" :value="chat.sessionMeta.model || preferredModel" title="模型偏好（对新建对话生效）" @change="onModelChange">
                <option v-if="modelOptions.length === 0" value="">{{ chat.sessionMeta.model || '默认模型' }}</option>
                <option v-for="o in modelOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
              <button v-if="chat.running" class="stop-btn pause" title="暂停执行（发送消息可恢复）" @click="chat.pause()">⏸ 暂停</button>
              <button v-if="chat.running" class="stop-btn" @click="chat.abort()">■ 停止</button>
              <button v-else class="send-btn" :disabled="!input.trim() && pendingImages.length === 0" @click="submit">
                ➤ 发送 <span class="kbd">Enter</span>
              </button>
            </div>
            <div class="rsz bottom" title="拖动调整输入框高度" @pointerdown="startComposerResize('bottom', $event)"></div>
          </div>

          <!-- F-37 底部状态条：吸附输入框正下方（项目名 ｜ 当前分支 ｜ Worktree 开关） -->
          <GitStatusBar v-if="chat.sessionId" />
        </div>
      </template>
      </template>
    </main>

    <!-- ══════════ 弹窗 ══════════ -->
    <ModalShell v-if="showNewProject" title="注册项目" icon="📁" @close="showNewProject = false">
      <p class="modal-tip">输入项目根目录的<b>绝对路径</b>，Agent 会在该目录内读写代码。</p>
      <input v-model="newRoot" class="full" placeholder="/path/to/your/project" @keyup.enter="addProject" />
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
  </div>
</template>

<style scoped>
.app { display: flex; height: 100vh; }

/* ══════════ 侧边栏（五段式：品牌 / 全局操作 / 会话列表 / 底部功能） ══════════ */
.sidebar {
  width: 268px; min-width: 268px;
  background: var(--bg-panel); border-right: 1px solid var(--border);
  display: flex; flex-direction: column;
}
/* 品牌区：图标 + 名称 + 版本紧凑成组，与下方留 16px 间距 */
.brand { display: flex; align-items: center; gap: 10px; padding: 16px 16px 12px; }
.brand-logo {
  width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0;
  background: linear-gradient(135deg, #4c8dff, #2e6fe0);
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 13px; color: #fff; font-family: var(--mono);
}
.brand-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.brand-name { font-weight: 600; font-size: 14px; line-height: 1.2; }
.brand-sub { font-size: 10.5px; color: var(--text-faint); line-height: 1.2; }

/* 段落容器：12px 间距 + 1px 细分隔线区分各段 */
.side-section { padding: 12px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
.side-section.bottom-group { border-bottom: none; border-top: 1px solid var(--border); }

/* ══════════ 侧栏导航项（图标+文字整行项） ══════════ */
.side-nav { display: flex; flex-direction: column; gap: 2px; }
.nav-item {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 7px 10px; border: none; border-radius: 8px;
  background: transparent; color: var(--text-dim); font-size: 13px;
  cursor: pointer; text-align: left; text-decoration: none;
  transition: background 0.12s, color 0.12s;
}
.nav-item:hover { background: var(--bg-hover); color: var(--text); }
.nav-item:active { background: var(--bg-active); }
.nav-item .ni-ico { width: 20px; flex: none; text-align: center; font-size: 14px; }
.nav-select {
  flex: 1; min-width: 0; background: transparent; border: none; outline: none;
  color: inherit; font-size: 13px; cursor: pointer; font-family: inherit;
}
.nav-select option { background: var(--bg-elevated); color: var(--text); }
.nav-badge {
  margin-left: auto; background: var(--orange); color: #fff; font-size: 9px;
  border-radius: 8px; padding: 1px 6px; font-weight: 700;
}
.nav-item.disabled { opacity: 0.45; cursor: not-allowed; pointer-events: none; }
/* 底部导航区：设置入口（分隔线由 bottom-group 的 border-top 提供） */
.side-nav.bottom { padding: 0; }

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

.sidebar-search { padding: 0; }
.sidebar-search input {
  width: 100%; padding: 6px 10px; font-size: 12px; cursor: pointer;
  color: var(--text-dim); background: var(--bg-elevated); border-color: var(--border);
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
.project-header.active { background: var(--accent-soft); }
.project-caret { font-size: 10px; color: var(--text-faint); transition: transform 0.15s; width: 10px; }
.project-caret.open { transform: rotate(90deg); }
.project-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); flex-shrink: 0; }
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
  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 9px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
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

.session-list { margin: 2px 0 4px 18px; border-left: 1px solid var(--border); padding-left: 8px; }
.session-item {
  position: relative;
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; border-radius: 6px; cursor: pointer;
  color: var(--text-dim); font-size: 12.5px; transition: background 0.15s, color 0.15s; margin: 1px 0;
}
.session-item:hover { background: var(--bg-hover); color: var(--text); }
.session-item:active { background: var(--bg-active); }
/* 选中态：accent-soft 背景 + 左侧 2px 强调色指示条 */
.session-item.active { background: var(--accent-soft); color: var(--text); font-weight: 500; box-shadow: inset 2px 0 0 var(--accent); }
.session-icon { font-size: 11px; opacity: 0.7; width: 14px; text-align: center; }
/* 两行条目主体：上行标题、下行模式徽标 + 相对时间预览 */
.session-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.session-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.session-sub { display: flex; align-items: center; gap: 6px; }
.session-time { font-size: 10px; color: var(--text-faint); font-family: var(--mono); white-space: nowrap; }
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
}
.mode-tag.running::before {
  content: ''; width: 6px; height: 6px; border-radius: 50%;
  background: var(--green); animation: run-pulse 1.2s ease-in-out infinite;
}
@keyframes run-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.3; transform: scale(0.75); } }
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

/* ══════════ 主区域 ══════════ */
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

/* 空态 hero：图标 / 产品名 / 价值主张 / 行动按钮 / 三特性卡，共用同一套变量与卡片规范 */
.hero {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; padding: 24px; overflow-y: auto;
}
.hero-logo {
  width: 64px; height: 64px; border-radius: 16px;
  background: linear-gradient(135deg, #4c8dff, #2e6fe0);
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 26px; color: #fff; font-family: var(--mono);
  box-shadow: 0 8px 24px rgba(46, 111, 224, 0.25);
}
.hero h1 { font-size: 21px; font-weight: 600; letter-spacing: 0.01em; }
.hero-tagline { color: var(--text-dim); font-size: 13.5px; }
.hero-actions { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
.hero-btn {
  padding: 10px 24px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--bg-elevated);
  color: var(--text); font-size: 13.5px; font-weight: 500; cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.hero-btn:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
.hero-btn:active:not(:disabled) { background: var(--bg-active); }
.hero-btn.primary { background: var(--accent); border-color: transparent; color: #fff; font-weight: 600; }
.hero-btn.primary:hover:not(:disabled) { background: var(--accent-strong); }
.hero-btn.primary:active:not(:disabled) { background: var(--accent-press); }
.hero-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.kbd-hint { display: inline-flex; align-items: center; gap: 6px; color: var(--text-faint); font-size: 11.5px; }
/* 三张等宽特性小卡 */
.hero-features { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; width: 100%; max-width: 640px; margin-top: 24px; }
.feature-card {
  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 12px; padding: 16px;
  display: flex; flex-direction: column; gap: 6px; text-align: left;
}
.f-ico { font-size: 18px; }
.f-title { font-size: 13px; font-weight: 600; color: var(--text); }
.f-desc { font-size: 11.5px; line-height: 1.6; color: var(--text-dim); }

/* 顶栏：与侧栏同色阶，底部 1px 分隔 */
.topbar {
  min-height: 52px; border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: 12px;
  padding: 10px 16px; background: var(--bg-panel);
}
/* 层级面包屑：段间 / 用 faint 色；最后一段为主文本（600），前两段 dim + hover 提亮下划线 */
.crumb { display: flex; align-items: center; min-width: 0; flex: 1; font-size: 13px; overflow: hidden; }
.crumb-seg {
  min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  color: var(--text-dim); transition: color 0.12s;
}
.crumb-seg.crumb-brand { flex: none; }
.crumb-seg.crumb-project, .crumb-seg.current { flex: 0 1 auto; }
.crumb-seg.current { color: var(--text); font-weight: 600; }
.crumb-seg:not(.current) { cursor: pointer; }
.crumb-seg:not(.current):hover { color: var(--text); text-decoration: underline; text-underline-offset: 3px; }
.crumb-sep { flex: none; color: var(--text-faint); margin: 0 7px; font-size: 12px; }
.cfg-op {
  padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--bg-elevated); color: var(--text-dim); font-size: 12px; cursor: pointer;
  transition: all 0.12s; text-decoration: none; white-space: nowrap;
}
.cfg-op:hover { background: var(--bg-hover); color: var(--text); }
.cfg-op:active { background: var(--bg-active); }
/* 回放固定在顶栏最右：▶ 图标 + 文案；空会话禁用态（faint 色 + not-allowed） */
.cfg-op.replay { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; }
.cfg-op.replay.disabled,
.cfg-op.replay.disabled:hover { color: var(--text-faint); cursor: not-allowed; background: var(--bg-elevated); border-color: var(--border); }

/* 消息流容器（含回到底部按钮的定位上下文） */
.chat-area { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
.chat-scroll { flex: 1; overflow-y: auto; padding: 22px 0; }
.chat-inner { max-width: 860px; margin: 0 auto; padding: 0 24px; }
.jump-btn {
  position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 5;
  padding: 7px 16px; border-radius: 999px; border: 1px solid var(--border-strong);
  background: var(--bg-elevated); color: var(--text-dim); font-size: 12px; cursor: pointer;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
  transition: background 0.15s, color 0.15s, border-color 0.15s;
  animation: fadeIn 0.2s ease;
}
.jump-btn:hover { background: var(--bg-hover); color: var(--text); border-color: var(--accent-border); }
.msg { margin-bottom: 18px; animation: fadeIn 0.25s ease; }
.msg-user { display: flex; gap: 12px; }
.msg-user .bubble { background: var(--accent-soft); border-color: var(--accent-border); }
.msg-ai { display: flex; gap: 12px; }
.ai-col { flex: 1; min-width: 0; }
.avatar {
  width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700;
}
.avatar.user { background: var(--bg-hover); color: var(--text-dim); }
.avatar.ai { background: linear-gradient(135deg, #4c8dff, #2e6fe0); color: #fff; font-size: 11px; font-family: var(--mono); }
.bubble {
  background: var(--bg-panel); border: 1px solid var(--border);
  border-radius: 12px; padding: 12px 16px; line-height: 1.65;
}
.msg-user .bubble { max-width: 75%; }
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
  border: 1px dashed var(--border); animation: fadeIn 0.25s ease;
  white-space: pre-wrap; word-break: break-word;
}
.event-ico { font-size: 13px; }

/* 空对话引导：居中、窄容器，与 hero 空态共用同一套变量与卡片规范 */
.chat-empty {
  display: flex; flex-direction: column; align-items: center;
  max-width: 560px; margin: 0 auto; padding: 64px 16px 40px;
  text-align: center;
}
.ce-title { font-size: 17px; font-weight: 600; color: var(--text); }
.ce-sub { margin-top: 8px; font-size: 13px; color: var(--text-dim); }
.ce-cards { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-top: 22px; }
.ce-card {
  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 10px;
  padding: 12px 14px; font-size: 12.5px; color: var(--text-dim); cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.ce-card:hover { background: var(--bg-hover); border-color: var(--accent-border); color: var(--text); }
.ce-card:active { background: var(--bg-active); }
.ce-kbd-row {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 6px;
  margin-top: 28px; font-size: 11.5px; color: var(--text-faint);
}
.ce-dot { opacity: 0.5; margin: 0 2px; }

/* ══════════ 审批卡片 ══════════ */
.cards-zone { padding-top: 0; }
.cards-inner { max-width: 860px; margin: 0 auto; }
.approve-card {
  border: 1px solid var(--border); border-radius: 12px;
  padding: 12px 16px; margin-bottom: 10px; animation: fadeIn 0.25s ease;
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
.composer {
  max-width: 860px; margin: 0 auto; position: relative;
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: 12px; padding: 12px 14px 10px;
  transition: border-color 0.15s, box-shadow 0.15s;
}
/* 聚焦：accent 描边 + subtle 外发光 */
.composer:focus-within {
  border-color: rgba(76, 141, 255, 0.4);
  box-shadow: 0 0 0 3px rgba(76, 141, 255, 0.08);
}
.ac-panel {
  position: absolute; left: 10px; right: 10px; bottom: calc(100% + 6px);
  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45); overflow: hidden; z-index: 30;
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
  color: var(--text); font-size: 14px; resize: none; height: 44px; line-height: 1.5;
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
.composer-hint {
  font-size: 11px; color: var(--orange); background: var(--orange-soft);
  border-radius: 6px; padding: 4px 9px; margin-bottom: 8px;
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
.cap-right { display: inline-flex; align-items: center; gap: 5px; transition: color 0.15s; }
.composer-cap .kbd { font-size: 10px; }
/* composer 聚焦时快捷键提示提亮一档 */
.composer:focus-within .cap-right { color: var(--text-dim); }
.composer:focus-within .cap-right .kbd { color: var(--text-dim); border-color: var(--border-strong); }
/* 底部操作区：暂停/停止/发送按钮右对齐（与模型选择间距 ≥12px） */
.composer-actions { display: flex; align-items: center; gap: 12px; margin-top: 8px; justify-content: flex-end; }
.send-btn {
  padding: 7px 20px; border: none; border-radius: 8px;
  background: var(--accent);
  color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;
  display: flex; align-items: center; gap: 7px; transition: background 0.15s;
}
.send-btn:hover:not(:disabled) { background: var(--accent-strong); }
.send-btn:active:not(:disabled) { background: var(--accent-press); }
.send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
/* 输入框右下角模型选择：独立 pill 控件（28px 高、自定义 ▾ caret、bg-elevated + border） */
.composer-model {
  appearance: none; -webkit-appearance: none;
  margin-left: auto; max-width: 220px; height: 28px;
  padding: 0 24px 0 10px;
  color: var(--text-dim); font-size: 12px; font-family: var(--mono);
  background: var(--bg-elevated)
    url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5' viewBox='0 0 8 5'%3E%3Cpath d='M0 0l4 5 4-5z' fill='%236b7280'/%3E%3C/svg%3E")
    no-repeat right 8px center;
  border: 1px solid var(--border); border-radius: 8px; cursor: pointer;
  transition: border-color 0.12s, color 0.12s, background-color 0.12s;
}
.composer-model:hover { background-color: var(--bg-hover); border-color: var(--border-strong); color: var(--text); }
.composer-model:focus-visible { outline: none; border-color: var(--accent-border); }
.composer-model option { background: var(--bg-elevated); color: var(--text); }
/* 停止：实心危险红 + #fff 字（与状态条控制按钮同规范）；暂停：中性描边 */
.stop-btn {
  padding: 7px 20px; border: 1px solid var(--red);
  border-radius: 8px; background: var(--red); color: #fff;
  font-size: 13px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 7px;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.stop-btn:hover { background: rgba(248, 81, 73, 0.85); }
.stop-btn:active { background: rgba(248, 81, 73, 0.7); }
.stop-btn.pause { border-color: var(--border-strong); background: var(--bg-elevated); color: var(--text-dim); }
.stop-btn.pause:hover { background: var(--bg-hover); color: var(--text); border-color: var(--text-faint); }
.stop-btn.pause:active { background: var(--bg-active); }
.kbd { font-family: var(--mono); font-size: 10.5px; border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; color: var(--text-faint); }
/* 发送按钮内的快捷键块：蓝底上用纯白，避免暗色块看起来像渲染异常 */
.send-btn .kbd { color: #fff; border-color: rgba(255, 255, 255, 0.6); font-size: 10px; }
.pending-imgs { display: flex; gap: 8px; margin-bottom: 8px; }
.thumb { position: relative; display: inline-block; }
.thumb img { width: 52px; height: 52px; object-fit: cover; border-radius: 7px; border: 1px solid var(--border); display: block; }
.thumb .rm {
  position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 50%;
  border: none; background: var(--red); color: #fff; font-size: 12px; line-height: 18px; padding: 0; cursor: pointer;
}

/* 弹窗内共用 */
.modal-tip { font-size: 13px; color: var(--text-dim); line-height: 1.7; margin-bottom: 12px; }
.modal-tip b { color: var(--text); }
.full { width: 100%; margin-bottom: 12px; }
.error { color: var(--red); font-size: 12.5px; margin-bottom: 8px; }
.modal-btns { display: flex; gap: 10px; justify-content: flex-end; }
</style>
