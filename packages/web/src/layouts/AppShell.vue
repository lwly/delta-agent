<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import TrashModal from '../components/TrashModal.vue';
import { api } from '../api/client';
import { useChatStore } from '../stores/chat';
import { useWorkspaceStore } from '../stores/workspace';

const RUN_POLL_MS = 5000;

const route = useRoute();
const router = useRouter();
const chat = useChatStore();

const showTrash = ref(false);
provide('openTrash', () => {
  showTrash.value = true;
});

const memoryPendingCount = ref(0);
async function refreshMemoryBadge() {
  try {
    const res = await api.listMemory(undefined, undefined, 'pending');
    memoryPendingCount.value = res.items.length;
  } catch {
    /* ignore */
  }
}

const ws = useWorkspaceStore();
let runPollTimer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  void refreshMemoryBadge();
  try {
    await ws.ensureReady();
  } catch {
    /* 项目列表不可用时不阻塞壳 */
  }
  void ws.refreshRunning();
  runPollTimer = setInterval(() => void ws.refreshRunning(), RUN_POLL_MS);
});
onUnmounted(() => {
  if (runPollTimer) clearInterval(runPollTimer);
});
watch(
  () => chat.running,
  (running, prev) => {
    if (prev === true && running === false) void refreshMemoryBadge();
  },
);

const isWorkbench = computed(() => route.path === '/' || route.path === '');
const isTasks = computed(() => route.path.startsWith('/tasks'));
const isSettings = computed(() => route.path.startsWith('/settings'));
</script>

<template>
  <div class="shell">
    <nav class="rail">
      <span class="rail__logo" title="Delta-Agent">Δ</span>
      <router-link
        class="rail__btn"
        to="/"
        title="工作台（对话）"
        :class="{ 'rail__btn--on': isWorkbench }"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-2.9-.36-4.1-1L3 20l1.1-5.2A8.5 8.5 0 1 1 21 11.5Z" /></svg>
      </router-link>
      <router-link
        class="rail__btn"
        to="/tasks"
        title="委派任务"
        :class="{ 'rail__btn--on': isTasks }"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 8v8l8 5 8-5V8Z" /><path d="m4 8 8 5 8-5" /><path d="M12 13v8" /></svg>
      </router-link>
      <router-link class="rail__btn" to="/cron" title="定时任务">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
      </router-link>
      <router-link class="rail__btn" to="/usage" title="用量">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 20V10" /><path d="M12 20V4" /><path d="M18 20v-6" /></svg>
      </router-link>
      <span class="rail__spacer" />
      <button class="rail__btn" type="button" title="回收站" @click="showTrash = true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="m6 7 .9 12.1A2 2 0 0 0 8.9 21h6.2a2 2 0 0 0 2-1.9L18 7" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
      </button>
      <router-link
        class="rail__btn"
        to="/settings"
        title="设置（含待确认记忆角标）"
        :class="{ 'rail__btn--on': isSettings }"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2" /><path d="M12 2.5v3" /><path d="M12 18.5v3" /><path d="m5.3 5.3 2.1 2.1" /><path d="m16.6 16.6 2.1 2.1" /><path d="M2.5 12h3" /><path d="M18.5 12h3" /><path d="m5.3 18.7 2.1-2.1" /><path d="m16.6 7.4 2.1-2.1" /></svg>
        <span v-if="memoryPendingCount > 0" class="rail__badge">{{ memoryPendingCount > 99 ? '99+' : memoryPendingCount }}</span>
      </router-link>
    </nav>

    <div class="shell-content">
      <slot />
    </div>

    <nav class="dock">
      <button
        class="dock__btn"
        type="button"
        title="工作台"
        :class="{ 'dock__btn--on': isWorkbench }"
        @click="router.push('/')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-2.9-.36-4.1-1L3 20l1.1-5.2A8.5 8.5 0 1 1 21 11.5Z" /></svg>
      </button>
      <router-link class="dock__btn" to="/tasks" title="委派任务">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 8v8l8 5 8-5V8Z" /><path d="m4 8 8 5 8-5" /><path d="M12 13v8" /></svg>
      </router-link>
      <router-link class="dock__btn" to="/cron" title="定时任务">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
      </router-link>
      <router-link class="dock__btn" to="/usage" title="用量">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 20V10" /><path d="M12 20V4" /><path d="M18 20v-6" /></svg>
      </router-link>
      <router-link class="dock__btn" to="/settings" title="设置">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2" /><path d="M12 2.5v3" /><path d="M12 18.5v3" /><path d="m5.3 5.3 2.1 2.1" /><path d="m16.6 16.6 2.1 2.1" /><path d="M2.5 12h3" /><path d="M18.5 12h3" /><path d="m5.3 18.7 2.1-2.1" /><path d="m16.6 7.4 2.1-2.1" /></svg>
      </router-link>
    </nav>

    <TrashModal v-if="showTrash" @close="showTrash = false" />
  </div>
</template>

<style scoped>
.shell { display: flex; height: 100vh; position: relative; width: 100%; }
.shell-content {
  flex: 1; min-width: 0; min-height: 0;
  display: flex; flex-direction: column; overflow: hidden;
}
.rail {
  width: 48px; min-width: 48px; flex-shrink: 0;
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
.dock { display: none; }
@media (max-width: 767px) {
  .rail { display: none; }
  .shell { height: calc(100vh - 48px); }
  .dock {
    display: flex; position: fixed; left: 0; right: 0; bottom: 0; z-index: 60;
    height: 48px; background: var(--bg-chrome); border-top: 1px solid var(--border);
    align-items: center; justify-content: space-around; padding: 0 4px;
  }
  .dock__btn {
    width: 36px; height: 36px; border: none; border-radius: var(--radius-md);
    background: transparent; color: #8a8a8a; cursor: pointer; text-decoration: none;
    display: flex; align-items: center; justify-content: center;
  }
  .dock__btn svg { width: 20px; height: 20px; }
  .dock__btn:hover, .dock__btn.router-link-active, .dock__btn--on { color: var(--text); }
  .dock__btn.router-link-active::before, .dock__btn--on::before {
    content: ''; position: absolute; top: 2px; left: 7px; right: 7px; height: 2px;
    border-radius: 1px; background: var(--accent);
  }
  .dock__btn { position: relative; }
}
</style>
