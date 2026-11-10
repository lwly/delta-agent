<script setup lang="ts">
// 委派任务页：原 WorkbenchView hero-home（输入即派任务 + 分组任务列表）
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import { useTasksStore } from '../stores/tasks';
import { api, apiFetch, type ExternalAgentInfo, type WorkerTaskView } from '../api/client';
import TaskDetailPanel from '../components/TaskDetailPanel.vue';

const ws = useWorkspaceStore();
const tasksStore = useTasksStore();
const error = ref('');
const homeInput = ref('');
const homeExecutor = ref('');
const delegating = ref(false);
const externalAgents = ref<ExternalAgentInfo[]>([]);

/** 等 workspace 就绪后再订阅任务列表，避免进页时 immediate 用空 projectId 清掉轮询 */
watch(
  () => [ws.ready, ws.activeProjectId] as const,
  ([ready, id]) => {
    if (!ready) return;
    tasksStore.watch(id || null);
  },
  { immediate: true },
);
onUnmounted(() => tasksStore.watch(null));

onMounted(async () => {
  try {
    await ws.ensureReady();
    if (ws.activeProjectId) tasksStore.watch(ws.activeProjectId);
  } catch (e) {
    error.value = (e as Error).message;
  }
  try {
    const res = await apiFetch('/api/providers');
    void res;
    externalAgents.value = (await api.externalAgents()).agents;
  } catch {
    externalAgents.value = [];
  }
});

const homeTaskGroups = computed(() =>
  [
    { key: 'needYou', label: '需要你', items: tasksStore.groups.needYou },
    { key: 'active', label: '处理中', items: tasksStore.groups.active },
    { key: 'finished', label: '已完成', items: tasksStore.groups.finished },
  ].filter((g) => g.items.length > 0),
);

const hasTaskHistory = computed(() => homeTaskGroups.value.length > 0);

const HOME_STATUS_LABEL: Record<string, string> = {
  draft: '草稿', queued: '排队中', preflight: '准备中', running: '处理中',
  needs_decision: '等待你', done: '已完成', failed: '失败', canceled: '已取消',
};
function taskStatusShort(status: string): string {
  return HOME_STATUS_LABEL[status] ?? status;
}

function assistantName(executor: string | null | undefined): string {
  if (!executor) return '内置助手';
  const a = externalAgents.value.find((x) => x.id === executor);
  return a ? a.displayName || a.label || a.id : executor;
}

const delegateToast = ref<{ assistant: string; title: string; task: WorkerTaskView } | null>(null);
let delegateToastTimer: ReturnType<typeof setTimeout> | null = null;
onUnmounted(() => {
  if (delegateToastTimer) clearTimeout(delegateToastTimer);
});

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
    delegateToast.value = { assistant: assistantName(task.executor), title: task.title, task };
    if (delegateToastTimer) clearTimeout(delegateToastTimer);
    delegateToastTimer = setTimeout(() => (delegateToast.value = null), 8000);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    delegating.value = false;
  }
}

function openDelegated() {
  const hint = delegateToast.value;
  if (!hint) return;
  delegateToast.value = null;
  if (delegateToastTimer) clearTimeout(delegateToastTimer);
  tasksStore.openTaskPanel(hint.task.id, hint.task);
}
</script>

<template>
  <div class="tasks-page">
    <p v-if="error" class="error">✘ {{ error }}</p>
    <div class="hero hero-home" :class="{ 'hero-home--with-tasks': hasTaskHistory }">
      <h1 class="home-slogan">
        把工作交出去。<br />
        回来就能看到<span class="home-slogan-accent">答案</span>。
      </h1>
      <p class="home-sub">你的助手会接管并处理任务，每个答案都会在这里等你。</p>

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
        <p v-if="!homeTaskGroups.length" class="home-sub home-tasks-empty">暂无委派记录，在上方输入即可派新任务</p>
      </template>
      <p v-else class="home-sub">请先在「项目管理」注册一个项目，就可以委派任务了。</p>
    </div>

    <div v-if="delegateToast" class="delegate-toast">
      <span class="dt-avatar">Δ</span>
      <span class="dt-text"><b>{{ delegateToast.assistant }}</b> 接手了“{{ delegateToast.title }}”</span>
      <button class="dt-open" type="button" @click="openDelegated">打开</button>
      <button class="dt-close" type="button" title="关闭提示" @click="delegateToast = null">×</button>
    </div>

    <TaskDetailPanel />
  </div>
</template>

<style scoped>
.tasks-page {
  flex: 1; min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column; position: relative;
}
.error { color: var(--red); font-size: 12.5px; padding: 8px 16px; margin: 0; }
.hero {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; padding: 24px; overflow-y: auto;
}
.hero-home { gap: 10px; max-width: 672px; margin: 0 auto; width: 100%; }
.hero-home--with-tasks {
  flex: none;
  justify-content: flex-start;
  padding-top: 32px;
  padding-bottom: 32px;
}
.home-tasks-empty { margin-top: 4px; }
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
.delegate-toast {
  position: fixed; left: 50%; bottom: 72px; transform: translateX(-50%);
  z-index: 70;
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; border-radius: 10px;
  background: var(--bg-elevated); border: 1px solid var(--border-strong);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
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
.dt-close {
  flex: none; width: 20px; height: 20px;
  border: none; background: transparent; color: var(--text-faint);
  font-size: 14px; cursor: pointer;
}
</style>
