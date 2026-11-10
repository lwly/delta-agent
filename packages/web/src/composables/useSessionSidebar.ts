/**
 * 项目管理侧栏：项目树、会话列表、注册/检索/分页等（自 WorkbenchView 抽出，供 ProjectsView + SessionSidebar）。
 */
import { computed, inject, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useWorkspaceStore } from '../stores/workspace';
import { useChatStore } from '../stores/chat';
import { api, apiFetch, type ExternalAgentInfo, type ProviderView } from '../api/client';
import { hasDesktopBridge, pickDirectory } from '../utils/desktop';
import { resolveSelectedModel } from '../utils/modelChoice';

const MODES = [
  { value: 'react', label: 'ReAct 推理' },
  { value: 'plan-execute', label: '计划执行' },
  { value: 'multi-agent', label: '多智能体' },
] as const;

export function useSessionSidebar() {
  const ws = useWorkspaceStore();
  const chat = useChatStore();
  const route = useRoute();
  const router = useRouter();
  const openTrash = inject<() => void>('openTrash', () => {});

  const expanded = ref<Set<string>>(new Set());
  const newRoot = ref('');
  const error = ref('');
  const addError = ref('');
  const showNewProject = ref(false);
  const showRemove = ref(false);
  const removeTarget = ref<{ kind: 'project' | 'session'; id: string; name: string } | null>(null);
  const removeConfirmName = ref('');
  const showSearch = ref(false);
  const sidebarScrollEl = ref<HTMLElement | null>(null);

  const modeChoice = ref<string>('react');
  const preferredModel = ref(localStorage.getItem('yz.preferredModel') ?? '');
  const providers = ref<ProviderView[]>([]);
  const externalAgents = ref<ExternalAgentInfo[]>([]);

  const todayTokens = ref(0);
  const DAILY_TOKEN_BUDGET = 2_000_000;
  const todayPct = computed(() => Math.min(100, Math.round((todayTokens.value / DAILY_TOKEN_BUDGET) * 100)));
  const todayLabel = computed(() =>
    todayTokens.value >= 1000 ? `${(todayTokens.value / 1000).toFixed(1)}k` : String(todayTokens.value),
  );

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
        /* ignore */
      }
    }
    platform.value = [name, arch].filter(Boolean).join(' · ') || platform.value;
  })();

  function avatarTone(id: string): 'blue' | 'red' {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return h % 2 === 0 ? 'blue' : 'red';
  }

  function modeCls(mode: string): string {
    if (mode === 'plan-execute') return 'plan';
    if (mode === 'multi-agent') return 'multi';
    return 'react';
  }
  function modeShort(mode: string): string {
    if (mode === 'plan-execute') return '计划';
    if (mode === 'multi-agent') return '多智能体';
    return '推理';
  }
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

  async function refreshTodayUsage() {
    try {
      const s = await api.usageSummary('today');
      todayTokens.value = s.totals.input_tokens + s.totals.output_tokens;
    } catch {
      /* ignore */
    }
  }

  async function refreshProviders() {
    try {
      const res = await apiFetch('/api/providers');
      const json = await res.json();
      providers.value = Array.isArray(json) ? (json as ProviderView[]) : [];
    } catch {
      providers.value = [];
    }
    try {
      externalAgents.value = (await api.externalAgents()).agents;
    } catch {
      externalAgents.value = [];
    }
  }

  const modelOptions = computed(() => {
    const opts = providers.value
      .filter((p) => p.enabled)
      .map((p) => ({
        value: p.model || '',
        label: p.model ? `${p.model}（${p.id}）` : `${p.id}（默认模型）`,
      }));
    for (const a of externalAgents.value) {
      const name = a.displayName || a.label || a.id;
      const suffix = a.model ? ` · ${a.model}` : '';
      opts.push({ value: a.id, label: `${name}（外部 Agent${suffix}）` });
    }
    const cur = chat.sessionMeta?.model;
    if (cur && !opts.some((o) => o.value === cur)) opts.unshift({ value: cur, label: cur });
    return opts;
  });

  const selectedModel = computed(() =>
    resolveSelectedModel(chat.sessionMeta?.model, preferredModel.value, modelOptions.value.map((o) => o.value)),
  );

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

  const canPickDirectory = hasDesktopBridge();
  async function browseProjectRoot() {
    const dir = await pickDirectory();
    if (dir) newRoot.value = dir;
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

  async function navigateOpenSession(id: string) {
    await router.push({ path: '/', query: { session: id } });
  }

  async function openSession(id: string) {
    error.value = '';
    try {
      if (route.path === '/') {
        await chat.open(id);
        await router.replace({ path: '/', query: { ...route.query, session: id } });
      } else {
        await navigateOpenSession(id);
      }
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

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
      await navigateOpenSession(s.id);
      return s.id;
    } catch (e) {
      error.value = (e as Error).message;
      return null;
    }
  }

  function isSessionRunning(id: string): boolean {
    return ws.runningIds.includes(id);
  }

  async function pauseSession(id: string) {
    error.value = '';
    try {
      await ws.pauseSession(id);
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  const projectMenuFor = ref('');
  const renamingProjectId = ref('');
  const renameProjectText = ref('');

  function toggleProjectMenu(id: string) {
    projectMenuFor.value = projectMenuFor.value === id ? '' : id;
    renamingProjectId.value = '';
  }

  async function revealProject(p: { id: string }) {
    projectMenuFor.value = '';
    try {
      await api.revealProject(p.id);
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  function copyText(text: string) {
    navigator.clipboard
      .writeText(text)
      .then(() => chat.notice('已复制到剪贴板'))
      .catch(() => chat.notice('✘ 复制失败'));
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

  function askRemoveProject(p: { id: string; name: string }) {
    projectMenuFor.value = '';
    removeTarget.value = { kind: 'project', id: p.id, name: p.name };
    removeConfirmName.value = '';
    showRemove.value = true;
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

  function onSidebarScroll() {
    const el = sidebarScrollEl.value;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) void ws.loadMoreSessions();
  }

  function onGlobalKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      showSearch.value = true;
    }
  }

  onMounted(async () => {
    window.addEventListener('keydown', onGlobalKeydown);
    try {
      await ws.ensureReady();
    } catch (e) {
      error.value = (e as Error).message;
    }
    void refreshTodayUsage();
    void refreshProviders();
  });

  onUnmounted(() => {
    window.removeEventListener('keydown', onGlobalKeydown);
  });

  return {
    ws,
    chat,
    expanded,
    newRoot,
    error,
    addError,
    showNewProject,
    showRemove,
    removeTarget,
    removeConfirmName,
    showSearch,
    sidebarScrollEl,
    todayLabel,
    todayPct,
    platform,
    canPickDirectory,
    projectMenuFor,
    renamingProjectId,
    renameProjectText,
    removeNeedsName,
    removeReady,
    openTrash,
    avatarTone,
    modeCls,
    modeShort,
    relTime,
    toggleExpand,
    selectProject,
    addProject,
    browseProjectRoot,
    newSession,
    openSession,
    isSessionRunning,
    pauseSession,
    toggleProjectMenu,
    revealProject,
    copyProjectPath,
    startRenameProject,
    saveRenameProject,
    askRemoveProject,
    askRemoveSession,
    doRemove,
    onSidebarScroll,
    MODES,
  };
}

export type SessionSidebarApi = ReturnType<typeof useSessionSidebar>;
