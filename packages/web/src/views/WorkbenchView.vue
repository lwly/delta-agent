<script setup lang="ts">
// 工作台主页（对齐 prototype/index.html 高保真原型）：
// 左侧「项目 × 会话」树形侧边栏 + 主区对话流（工具卡片/事件卡/审批卡）+ 底部输入区
// 记忆 / 模型配置 / 用量 / 回收站 / 检索均为弹窗；回放走独立路由 /replay/:sessionId
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import { useChatStore } from '../stores/chat';
import { api, type MessageHit, type MessageImage, type ProviderView, type SkillCandidate } from '../api/client';
import { renderMarkdown } from '../render';
import ModalShell from '../components/ModalShell.vue';
import MemoryModal from '../components/MemoryModal.vue';
import ProvidersModal from '../components/ProvidersModal.vue';
import UsageModal from '../components/UsageModal.vue';
import CronModal from '../components/CronModal.vue';
import TrashModal from '../components/TrashModal.vue';
import SearchModal from '../components/SearchModal.vue';
import GitStatusBar from '../components/GitStatusBar.vue';

const ws = useWorkspaceStore();
const chat = useChatStore();

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
const showMemory = ref(false);
const showProviders = ref(false);
const showUsage = ref(false);
const showCron = ref(false);
const showTrash = ref(false);
const showSearch = ref(false);

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
const pendingImages = ref<Array<MessageImage & { preview: string; name: string }>>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const MAX_IMAGES = 5;
const MAX_BYTES = 4 * 1024 * 1024;

const activeProjectName = computed(
  () => ws.projects.find((p) => p.id === ws.activeProjectId)?.name ?? '',
);

/** callId → 工具调用（name/args），用于把 tool_result 卡片与调用配对 */
const callMap = computed(() => {
  const map = new Map<string, { name: string; argsJson: string }>();
  for (const m of chat.messages) {
    for (const c of m.toolCalls ?? []) map.set(c.id, { name: c.name, argsJson: c.argsJson });
  }
  return map;
});

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
function argsOneLine(argsJson: string): string {
  const s = argsPretty(argsJson).replace(/\s+/g, ' ');
  return s.length > 72 ? `${s.slice(0, 72)}…` : s;
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
watch(showMemory, (open) => {
  if (!open) void refreshMemoryBadge();
});
</script>

<template>
  <div class="app">
    <!-- 项目菜单打开时的点击外部关闭层 -->
    <div v-if="projectMenuFor" class="menu-overlay" @click="projectMenuFor = ''" />
    <!-- ══════════ 侧边栏：多项目 × 多对话 ══════════ -->
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-logo">y0</span>
        <span>
          <span class="brand-name">y-zero-agent</span><br />
          <span class="brand-sub">AI Coding Agent · v0.1.0</span>
        </span>
      </div>

      <div class="sidebar-actions">
        <button class="btn-sm" @click="showNewProject = true">＋ 新项目</button>
        <button class="btn-sm primary" :disabled="!ws.activeProjectId" @click="newSession()">＋ 新对话</button>
      </div>

      <div class="sidebar-search">
        <input placeholder="🔍 检索会话与消息…" readonly @click="showSearch = true" />
      </div>

      <div class="sidebar-scroll">
        <p v-if="error" class="error">✘ {{ error }}</p>
        <div v-for="p in ws.projects" :key="p.id" class="project-group">
          <div class="project-header" :class="{ active: p.id === ws.activeProjectId && !chat.sessionId }" @click="selectProject(p.id)">
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
              @click="openSession(s.id)"
            >
              <span class="session-icon">💬</span>
              <span class="session-title" :title="s.title">{{ s.title }}</span>
              <!-- F-37：绑定 worktree 的会话轻量标识（重开自动还原绑定） -->
              <span v-if="s.worktree_path" class="wt-badge" title="已绑定 worktree：会话重开自动还原">🌿</span>
              <span v-if="isSessionRunning(s.id)" class="mode-tag running" title="执行中">运行中</span>
              <span v-else-if="s.status === 'paused'" class="mode-tag paused" title="已暂停，打开会话发送消息即恢复">已暂停</span>
              <span class="mode-tag" :class="modeCls(s.mode)">{{ modeShort(s.mode) }}</span>
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

      <div class="sidebar-footer">
        <div class="footer-row"><span>Token（今日）</span><span class="footer-val">{{ todayLabel }} / 2M</span></div>
        <div class="footer-row"><span>回收站</span><span class="footer-val link" @click="showTrash = true">{{ ws.trash.length }} 项</span></div>
        <div class="footer-row"><span>平台</span><span class="footer-val">{{ platform }}</span></div>
      </div>
    </aside>

    <!-- ══════════ 主区域 ══════════ -->
    <main class="main">
      <!-- 空态：未选择会话 -->
      <div v-if="!chat.sessionId || !chat.sessionMeta" class="hero">
        <div class="hero-logo">y0</div>
        <h1>y-zero-agent</h1>
        <p>从左侧选择一个对话，或新建对话开始你的任务。</p>
        <p class="hero-hint">支持 ReAct 推理 / 计划执行 / 多智能体 三种执行模式 · MCP 工具扩展 · 自动上下文压缩</p>
      </div>

      <template v-else>
        <!-- 顶栏 -->
        <div class="topbar">
          <div class="crumb">
            y-zero-agent <span class="dim">/</span> {{ activeProjectName }} <span class="dim">/</span> {{ chat.sessionMeta.title }}
          </div>
          <div class="mode-switch" title="执行模式在会话创建时确定，点击将以该模式新建对话">
            <button
              v-for="m in MODES"
              :key="m.value"
              class="mode-btn"
              :class="[m.cls, { active: chat.sessionMeta?.mode === m.value }]"
              @click="onModeSwitch(m.value)"
            >
              <span class="mode-ico">{{ m.ico }}</span>{{ m.label }}
            </button>
          </div>
          <select class="model-select" :value="chat.sessionMeta.model || preferredModel" title="模型偏好（对新建对话生效）" @change="onModelChange">
            <option v-if="modelOptions.length === 0" value="">{{ chat.sessionMeta.model || '默认模型' }}</option>
            <option v-for="o in modelOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <button class="cfg-op badge-btn" @click="showMemory = true">
            🧠 记忆<span v-if="memoryPendingCount > 0" class="badge">{{ memoryPendingCount }}</span>
          </button>
          <button class="cfg-op" @click="showProviders = true">⚙ 配置</button>
          <button class="cfg-op" @click="showUsage = true">📊 用量</button>
          <button class="cfg-op" @click="showCron = true">⏰ 定时</button>
          <router-link class="cfg-op replay" :to="`/replay/${chat.sessionId}`" title="会话回放">🎬 回放</router-link>
          <div class="budget-pill" :title="`今日 token ${todayLabel} / ${DAILY_TOKEN_BUDGET / 10000}k（展示口径）`">
            <span class="budget-bar"><span class="budget-fill" :class="{ warn: todayPct >= 80 }" :style="{ width: `${Math.max(2, todayPct)}%` }" /></span>
            <span>{{ todayPct }}%</span>
          </div>
        </div>

        <!-- 消息流 -->
        <div ref="listRef" class="chat-scroll">
          <div class="chat-inner">
            <!-- 用户消息 -->
            <div v-for="(m, i) in chat.messages" :key="i">
              <div v-if="m.role === 'user'" class="msg msg-user">
                <span class="avatar user">👤</span>
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
                    <button class="uop" title="复制原文" @click="copyText(m.content)">复制</button>
                    <button class="uop" title="编辑后重发" :disabled="chat.running" @click="startEdit(i, m)">编辑</button>
                    <button class="uop" title="原样重发" :disabled="chat.running" @click="resend(m)">重发</button>
                  </div>
                </div>
              </div>

              <!-- 助手消息 -->
              <div v-else-if="m.role === 'assistant'" class="msg msg-ai">
                <span class="avatar ai">y0</span>
                <div class="ai-col">
                  <div class="msg-meta"><span class="tag turn">ASSISTANT</span><span>{{ chat.sessionMeta.model || '默认模型' }}</span></div>
                  <div v-if="m.content" class="bubble msg-text md" v-html="md(m.content)" />
                  <!-- 快捷操作：悬停显示，与用户消息一致 -->
                  <div v-if="m.content" class="msg-ops">
                    <button class="uop" title="复制回复" @click="copyText(m.content)">复制</button>
                  </div>
                  <div v-for="(c, ci) in m.toolCalls ?? []" :key="ci" class="tool-card">
                    <div class="tool-head">
                      <span class="tool-status run">⚙</span>
                      <span class="tool-name">{{ c.name }}</span>
                      <span class="tool-args">{{ argsOneLine(c.argsJson) }}</span>
                      <!-- 阻止冒泡：点击复制不折叠卡片 -->
                      <button class="uop tool-copy" title="复制参数 JSON" @click.stop.prevent="copyText(argsPretty(c.argsJson))">复制 JSON</button>
                      <span class="tool-caret">▶</span>
                    </div>
                    <div class="tool-body"><pre>{{ argsPretty(c.argsJson) }}</pre></div>
                  </div>
                </div>
              </div>

              <!-- 工具结果卡片 -->
              <div v-else-if="m.role === 'tool'" class="msg tool-msg">
                <div class="tool-card result">
                  <details>
                    <summary class="tool-head">
                      <span class="tool-status ok">✔</span>
                      <span class="tool-name">{{ callMap.get(m.toolCallId ?? '')?.name ?? 'tool' }}</span>
                      <span v-if="m.sandboxMeta" class="sandbox-badge" :title="`沙箱后端 ${m.sandboxMeta.mode}${m.sandboxMeta.degraded ? '（已降级）' : ''}`">
                        🛡 {{ m.sandboxMeta.mode }}{{ m.sandboxMeta.ms != null ? ` · ${m.sandboxMeta.ms}ms` : '' }}
                      </span>
                      <span class="tool-args">{{ m.content.length }} 字符</span>
                      <button
                        v-if="callMap.get(m.toolCallId ?? '')"
                        class="uop tool-copy"
                        title="复制参数 JSON"
                        @click.stop.prevent="copyText(argsPretty(callMap.get(m.toolCallId ?? '')!.argsJson))"
                      >复制 JSON</button>
                      <span class="tool-caret">▶</span>
                    </summary>
                    <pre v-if="callMap.get(m.toolCallId ?? '')" class="args-pre">{{ argsPretty(callMap.get(m.toolCallId ?? '')!.argsJson) }}</pre>
                    <pre class="result-pre">{{ m.content }}</pre>
                  </details>
                </div>
              </div>
            </div>

            <!-- 流式中的助手输出 -->
            <div v-if="chat.streamingText" class="msg msg-ai">
              <span class="avatar ai">y0</span>
              <div class="ai-col">
                <div class="bubble msg-text md" v-html="md(chat.streamingText)" />
                <span class="typing"><span /><span /><span /></span>
              </div>
            </div>

            <!-- 事件通知（压缩/预算/计划/子任务…） -->
            <div v-for="n in chat.notices" :key="n.id" class="event-card">
              <span class="event-ico">ℹ</span>
              <span class="event-text">{{ n.text }}</span>
            </div>

            <div v-if="chat.messages.length === 0 && !chat.streamingText" class="chat-empty">
              发送第一条消息开始对话
            </div>
          </div>
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

        <!-- 输入区 -->
        <div class="composer-wrap">
          <div class="composer">
            <!-- 工具栏：移至输入框上方（图片 / @引用 / skill / mcp / 执行模式 / 权限） -->
            <div class="composer-tools">
              <span class="hint-chip" @click="fileInput?.click()" style="cursor: pointer">🖼 图片</span>
              <span class="hint-chip" title="插入 @ 后自动补全项目文件" style="cursor: pointer" @click="acTrigger('file')">@文件引用</span>
              <span class="hint-chip" title="插入 / 后自动补全可用技能" style="cursor: pointer" @click="acTrigger('skill')">/skill 技能</span>
              <span class="hint-chip">/mcp 扩展工具</span>
              <!-- 当前会话模式下拉：模式在会话创建时确定，切换 = 以该模式新建对话 -->
              <select
                class="mode-select"
                :value="chat.sessionMeta.mode"
                :disabled="chat.running"
                title="当前执行模式（模式在会话创建时确定，切换将以所选模式新建对话）"
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
                title="会话权限：只读 / 询问确认 / 全部放行"
                @change="onPermissionChange(($event.target as HTMLSelectElement).value as 'plan' | 'default' | 'yolo')"
              >
                <option value="default">🖐 询问确认</option>
                <option value="plan">📖 只读</option>
                <option value="yolo">⚡ 全部放行</option>
              </select>
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
              :placeholder="chat.running ? 'Agent 运行中…' : chat.paused ? '已暂停——发送消息将继续执行' : '描述你的任务，支持 Markdown 语法（**粗体**、代码块、列表…），@ 引用文件，/ 调用 Skill，可直接粘贴图片（Enter 发送，Shift+Enter 换行）'"
              @input="onComposerInput"
              @blur="ac = null"
              @keydown.enter.exact="onEnterKey"
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
            <!-- 底部操作区：暂停/停止/发送（仅运行态按钮 + 发送，右对齐） -->
            <div class="composer-actions">
              <button v-if="chat.running" class="stop-btn pause" title="暂停执行（发送消息可恢复）" @click="chat.pause()">⏸ 暂停</button>
              <button v-if="chat.running" class="stop-btn" @click="chat.abort()">■ 停止</button>
              <button v-else class="send-btn" :disabled="!input.trim() && pendingImages.length === 0" @click="submit">
                发送 <span class="kbd">↵</span>
              </button>
            </div>
          </div>
        </div>

        <!-- F-37 底部状态条：项目名 ｜ 当前分支 ｜ Worktree 开关（输入框下方） -->
        <div v-if="chat.sessionId" class="composer-wrap git-bar-zone">
          <GitStatusBar />
        </div>
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

    <MemoryModal v-if="showMemory" @close="showMemory = false" />
    <ProvidersModal v-if="showProviders" @close="showProviders = false" />
    <UsageModal v-if="showUsage" @close="showUsage = false" />
    <CronModal v-if="showCron" @close="showCron = false" />
    <TrashModal v-if="showTrash" @close="showTrash = false" />
    <SearchModal v-if="showSearch" @close="showSearch = false" @open-session="openSession" />
  </div>
</template>

<style scoped>
.app { display: flex; height: 100vh; }

/* ══════════ 侧边栏 ══════════ */
.sidebar {
  width: 268px; min-width: 268px;
  background: var(--bg-panel); border-right: 1px solid var(--border);
  display: flex; flex-direction: column;
}
.brand { display: flex; align-items: center; gap: 10px; padding: 16px 16px 12px; }
.brand-logo {
  width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0;
  background: linear-gradient(135deg, #58a6ff, #bc8cff);
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 13px; color: #fff; font-family: var(--mono);
}
.brand-name { font-weight: 600; font-size: 14px; }
.brand-sub { font-size: 10.5px; color: var(--text-faint); }

.sidebar-actions { padding: 4px 12px 8px; display: flex; gap: 8px; }
.btn-sm {
  flex: 1; padding: 7px 0; border-radius: 7px;
  border: 1px solid var(--border); background: var(--bg-elevated);
  color: var(--text); font-size: 12.5px; cursor: pointer; transition: all 0.15s;
}
.btn-sm:hover { background: var(--bg-hover); border-color: #444c56; }
.btn-sm.primary { background: var(--accent-soft); border-color: rgba(88, 166, 255, 0.4); color: var(--accent); }
.btn-sm.primary:hover { background: rgba(88, 166, 255, 0.2); }
.btn-sm:disabled { opacity: 0.4; cursor: not-allowed; }

.sidebar-search { padding: 0 12px 8px; }
.sidebar-search input { width: 100%; padding: 6px 10px; font-size: 12px; cursor: pointer; color: var(--text-faint); }

.sidebar-scroll { flex: 1; overflow-y: auto; padding: 4px 8px 12px; }
.project-group { margin-top: 8px; }
.project-header {
  position: relative;
  display: flex; align-items: center; gap: 8px;
  padding: 7px 8px; border-radius: 7px; cursor: pointer; transition: background 0.15s;
}
.project-header:hover { background: var(--bg-hover); }
.project-header.active { background: var(--accent-soft); }
.project-caret { font-size: 10px; color: var(--text-faint); transition: transform 0.15s; width: 10px; }
.project-caret.open { transform: rotate(90deg); }
.project-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); flex-shrink: 0; }
.project-name { font-weight: 600; font-size: 13px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.project-count { font-size: 11px; color: var(--text-faint); background: var(--bg-elevated); padding: 1px 7px; border-radius: 8px; }

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
.project-menu .menu-item .mi { width: 16px; text-align: center; flex: none; }
.project-menu .menu-item.danger:hover { background: var(--red-soft); color: var(--red); }

.session-list { margin: 2px 0 4px 18px; border-left: 1px solid var(--border); padding-left: 8px; }
.session-item {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; border-radius: 6px; cursor: pointer;
  color: var(--text-dim); font-size: 12.5px; transition: all 0.15s; margin: 1px 0;
}
.session-item:hover { background: var(--bg-hover); color: var(--text); }
.session-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 500; }
.session-icon { font-size: 11px; opacity: 0.7; width: 14px; text-align: center; }
.session-title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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

.sidebar-footer { border-top: 1px solid var(--border); padding: 10px 14px; font-size: 11.5px; color: var(--text-faint); }
.footer-row { display: flex; justify-content: space-between; padding: 2.5px 0; }
.footer-val { font-family: var(--mono); color: var(--text-dim); }
.footer-val.link { cursor: pointer; }
.footer-val.link:hover { color: var(--accent); }

/* ══════════ 主区域 ══════════ */
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

/* 空态 */
.hero { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; }
.hero-logo {
  width: 64px; height: 64px; border-radius: 16px;
  background: linear-gradient(135deg, #58a6ff, #bc8cff);
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 26px; color: #fff; font-family: var(--mono);
}
.hero h1 { font-size: 22px; font-weight: 600; }
.hero p { color: var(--text-dim); font-size: 13.5px; }
.hero-hint { color: var(--text-faint); font-size: 12px; }

/* 顶栏 */
.topbar {
  min-height: 52px; border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 6px 18px; background: var(--bg-panel);
}
.crumb { font-size: 13.5px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px; }
.crumb .dim { color: var(--text-faint); margin: 0 6px; }
.mode-switch {
  display: flex; background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: 8px; padding: 3px; margin-left: auto;
}
.mode-btn {
  padding: 5px 11px; border-radius: 6px; border: none;
  background: transparent; color: var(--text-dim); font-size: 12px; cursor: pointer;
  transition: all 0.15s; display: flex; align-items: center; gap: 5px; white-space: nowrap;
}
.mode-btn:hover { color: var(--text); }
.mode-btn.active { background: var(--bg-hover); color: var(--text); font-weight: 600; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); }
.mode-btn.active.react .mode-ico { color: var(--green); }
.mode-btn.active.plan .mode-ico { color: var(--orange); }
.mode-btn.active.multi .mode-ico { color: var(--purple); }
.mode-ico { font-size: 12px; }
.model-select { padding: 5px 9px; font-size: 12px; font-family: var(--mono); max-width: 190px; }
.cfg-op {
  padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--bg-elevated); color: var(--text-dim); font-size: 12px; cursor: pointer;
  transition: all 0.12s; text-decoration: none; position: relative; white-space: nowrap;
}
.cfg-op:hover { background: var(--bg-hover); color: var(--text); }
.badge {
  position: absolute; top: -5px; right: -5px;
  background: var(--orange); color: #fff; font-size: 9px; border-radius: 8px;
  padding: 1px 5px; font-weight: 700;
}
.budget-pill {
  display: flex; align-items: center; gap: 8px; padding: 5px 12px; border-radius: 8px;
  background: var(--bg-elevated); border: 1px solid var(--border);
  font-size: 11.5px; font-family: var(--mono); color: var(--text-dim);
}
.budget-bar { width: 64px; height: 5px; background: #30363d; border-radius: 3px; overflow: hidden; }
.budget-fill { display: block; height: 100%; background: var(--green); border-radius: 3px; transition: width 0.4s; }
.budget-fill.warn { background: var(--orange); }

/* ══════════ 消息流 ══════════ */
.chat-scroll { flex: 1; overflow-y: auto; padding: 22px 0; }
.chat-inner { max-width: 860px; margin: 0 auto; padding: 0 24px; }
.msg { margin-bottom: 18px; animation: fadeIn 0.25s ease; }
.msg-user { display: flex; gap: 12px; }
.msg-user .bubble { background: var(--accent-soft); border-color: rgba(88, 166, 255, 0.25); }
.msg-ai { display: flex; gap: 12px; }
.ai-col { flex: 1; min-width: 0; }
.avatar {
  width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700;
}
.avatar.user { background: #30363d; color: var(--text-dim); }
.avatar.ai { background: linear-gradient(135deg, #58a6ff, #bc8cff); color: #fff; font-size: 11px; font-family: var(--mono); }
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
.md :deep(code) { font-family: var(--mono); font-size: 12.5px; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; color: #79c0ff; }
.md :deep(pre code) { border: none; background: none; padding: 0; color: inherit; }
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
.uop:hover { color: var(--accent); border-color: rgba(88, 166, 255, 0.4); background: var(--accent-soft); }
.uop:disabled { opacity: 0.4; cursor: not-allowed; }
.uop.primary { color: var(--accent); border-color: rgba(88, 166, 255, 0.45); }
.edit-box { min-width: 420px; }
.edit-input {
  width: 100%; background: var(--bg); border: 1px solid var(--border);
  border-radius: 8px; color: var(--text); font-size: 13px; line-height: 1.6;
  padding: 8px 10px; resize: vertical; margin-bottom: 8px;
}
.edit-input:focus { outline: none; border-color: rgba(88, 166, 255, 0.5); }
.edit-ops { display: flex; gap: 6px; justify-content: flex-end; }
.msg-meta { font-size: 11px; color: var(--text-faint); margin-bottom: 5px; display: flex; gap: 8px; align-items: center; }
.tag { font-size: 9.5px; font-family: var(--mono); padding: 1px 6px; border-radius: 4px; }
.tag.turn { background: var(--bg-elevated); color: var(--text-dim); }

.imgs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
.imgs img { max-width: 200px; max-height: 150px; border-radius: 8px; display: block; }

/* 工具调用 / 结果卡片 */
.tool-msg { padding-left: 42px; }
.tool-card {
  border: 1px solid var(--border); border-radius: 10px;
  background: var(--bg-panel); margin: 8px 0; overflow: hidden; animation: fadeIn 0.25s ease;
}
.tool-head {
  display: flex; align-items: center; gap: 10px; padding: 9px 14px;
  cursor: pointer; user-select: none; list-style: none;
}
.tool-head::-webkit-details-marker { display: none; }
.tool-head:hover { background: var(--bg-hover); }
.tool-status {
  width: 18px; height: 18px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center; font-size: 10px;
}
.tool-status.ok { background: var(--green-soft); color: var(--green); }
.tool-status.run { background: var(--orange-soft); color: var(--orange); }
.tool-status.confirm { background: var(--red-soft); color: var(--red); }
.tool-name { font-family: var(--mono); font-size: 12.5px; font-weight: 600; color: var(--accent); }
.tool-args { font-family: var(--mono); font-size: 11.5px; color: var(--text-faint); flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tool-caret { color: var(--text-faint); font-size: 10px; }
/* 工具卡片头部的「复制 JSON」按钮：紧凑形态，不挤占一行 */
.tool-copy { padding: 0 6px; font-size: 10.5px; flex-shrink: 0; }
.tool-card details[open] .tool-caret { transform: rotate(90deg); }
.tool-body pre, .args-pre, .result-pre {
  font-family: var(--mono); font-size: 12px; line-height: 1.6;
  padding: 12px 16px; overflow-x: auto; color: var(--text-dim);
  background: var(--bg); margin: 0; white-space: pre-wrap; word-break: break-word;
  border-top: 1px solid var(--border); max-height: 280px; overflow-y: auto;
}
.sandbox-badge { font-size: 11px; color: var(--green); background: var(--green-soft); border-radius: 4px; padding: 1px 7px; font-family: var(--mono); }

/* 事件卡 */
.event-card {
  display: flex; align-items: flex-start; gap: 10px;
  margin: 12px 0 12px 42px; padding: 9px 14px;
  border-radius: 10px; font-size: 12.5px; color: var(--text-dim);
  border: 1px dashed var(--border); animation: fadeIn 0.25s ease;
  white-space: pre-wrap; word-break: break-word;
}
.event-ico { font-size: 13px; }

.typing { display: inline-flex; gap: 4px; align-items: center; margin: 6px 0 0 4px; }
.typing span { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); animation: blink 1.2s infinite; }
.typing span:nth-child(2) { animation-delay: 0.2s; }
.typing span:nth-child(3) { animation-delay: 0.4s; }
@keyframes blink { 0%, 70%, 100% { opacity: 0.25; } 35% { opacity: 1; } }

.chat-empty { text-align: center; color: var(--text-faint); padding: 60px 0; }

/* ══════════ 审批卡片 ══════════ */
.cards-zone { padding-top: 0; }
.cards-inner { max-width: 860px; margin: 0 auto; }
.approve-card {
  border: 1px solid var(--border); border-radius: 12px;
  padding: 12px 16px; margin-bottom: 10px; animation: fadeIn 0.25s ease;
}
.approve-card.confirm { border-color: rgba(248, 81, 73, 0.45); background: var(--red-soft); }
.approve-card.plan { border-color: rgba(210, 153, 34, 0.35); background: var(--orange-soft); }
.approve-card.ask { border-color: rgba(88, 166, 255, 0.4); background: var(--accent-soft); }
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
.composer-wrap { padding: 0 24px 18px; }
/* F-37：git 状态条区（输入框下方，压缩底部留白） */
.git-bar-zone { padding-top: 0; padding-bottom: 12px; }
.composer {
  max-width: 860px; margin: 0 auto;
  background: var(--bg-panel); border: 1px solid var(--border);
  border-radius: 14px; padding: 12px 14px 10px; transition: border-color 0.15s;
}
.composer:focus-within { border-color: rgba(88, 166, 255, 0.5); }
/* 自动补全面板：悬浮于输入框上方 */
.composer { position: relative; }
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
}
.composer textarea:focus { border: none; }
.composer textarea:disabled { opacity: 0.6; }
/* 工具栏：位于输入框上方，底部分隔线与输入区衔接（替代原 composer-bar） */
.composer-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-bottom: 8px; margin-bottom: 9px; border-bottom: 1px solid var(--border); }
/* 底部操作区：暂停/停止/发送按钮右对齐 */
.composer-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; justify-content: flex-end; }
.hint-chip {
  font-size: 11px; color: var(--text-faint);
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: 6px; padding: 3px 9px; cursor: default;
}
.hint-chip b { color: var(--accent); font-weight: 500; font-family: var(--mono); }
.mode-select {
  font-size: 11px; color: var(--text-dim);
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: 6px; padding: 3px 6px; cursor: pointer;
}
.mode-select:hover { color: var(--text); }
.mode-select:disabled { opacity: 0.5; cursor: not-allowed; }
/* 权限选择器：yolo 高亮警示（全部放行状态一眼可辨） */
.perm-select.yolo { color: var(--orange); border-color: var(--orange); background: var(--orange-soft); font-weight: 600; }
.send-btn {
  margin-left: auto; padding: 7px 20px; border: none; border-radius: 8px;
  background: linear-gradient(135deg, #58a6ff, #4c8dff);
  color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;
  display: flex; align-items: center; gap: 7px; transition: opacity 0.15s;
}
.send-btn:hover { opacity: 0.88; }
.send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.stop-btn {
  margin-left: auto; padding: 7px 20px; border: 1px solid var(--red);
  border-radius: 8px; background: var(--red-soft); color: var(--red);
  font-size: 13px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 7px;
}
/* PASI-9：暂停按钮（与停止并排，主间距由停止的 margin-left:auto 提供） */
.stop-btn.pause { margin-left: auto; border-color: var(--orange); background: var(--orange-soft); color: var(--orange); }
.stop-btn.pause + .stop-btn { margin-left: 0; }
.kbd { font-family: var(--mono); font-size: 10.5px; border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; color: var(--text-faint); }
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
