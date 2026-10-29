<script setup lang="ts">
// F-54 后台任务条：输入区上方的固定提示。
// 有运行中后台任务时显示胶囊（⏱ N 个后台任务运行中），点击展开任务面板：
// 每行 = 描述 + 已运行时长（1s 节流现算）+ 停止按钮（垃圾桶，终止并从列表移除），右上角 × 收起。
// 数据源与轮询在 stores/bgTasks.ts（2s 轮询；无增量事件不做假实时）。
import { computed, onUnmounted, ref, watch } from 'vue';
import { useBgTasksStore } from '../stores/bgTasks';
import type { BackgroundTaskView } from '../api/client';

const bg = useBgTasksStore();

// 已运行时长现算：每秒更新一次 now（仅胶囊可见时开表，隐藏即停）
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;
watch(
  () => bg.runningCount > 0,
  (visible) => {
    if (visible && !ticker) {
      now.value = Date.now();
      ticker = setInterval(() => (now.value = Date.now()), 1_000);
    } else if (!visible && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  },
  { immediate: true },
);
onUnmounted(() => {
  if (ticker) clearInterval(ticker);
});

const running = computed(() => bg.tasks.filter((t) => t.status === 'running'));

/** 已运行时长：42s / 7m19s / 1h02m（与截图口径一致） */
function elapsed(t: BackgroundTaskView): string {
  const end = t.finished_at ?? now.value;
  let s = Math.max(0, Math.floor((end - t.started_at) / 1000));
  const h = Math.floor(s / 3600);
  s %= 3600;
  const m = Math.floor(s / 60);
  s %= 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
</script>

<template>
  <div v-if="bg.runningCount > 0" class="bgtasks">
    <!-- 胶囊：点击展开/收起 -->
    <button class="bg-pill" type="button" :title="bg.expanded ? '收起后台任务面板' : '查看后台任务'" @click="bg.toggle()">
      <span class="bg-dot" aria-hidden="true" />
      {{ bg.runningCount }} 个后台任务运行中
      <span class="bg-caret" aria-hidden="true">{{ bg.expanded ? '▾' : '▸' }}</span>
    </button>

    <!-- 展开面板 -->
    <div v-if="bg.expanded" class="bg-panel">
      <div class="bg-head">
        <span class="bg-title">后台任务</span>
        <button class="bg-close" type="button" title="收起" @click="bg.expanded = false">×</button>
      </div>
      <div v-for="t in running" :key="t.id" class="bg-row" :title="t.command">
        <span class="bg-desc">{{ t.description }}</span>
        <span class="bg-elapsed">已运行 {{ elapsed(t) }}</span>
        <button
          class="bg-kill"
          type="button"
          title="停止并删除该后台任务"
          @click="bg.kill(t.id)"
        >
          🗑
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 容器：输入区上方一条，与 composer-wrap 同宽 */
.bgtasks {
  padding: 6px 16px 0;
}

/* 胶囊：与 RunStatusBar token 小字同族（11px mono + 999px 圆角） */
.bg-pill {
  display: inline-flex; align-items: center; gap: 7px;
  height: 26px; padding: 0 12px; border-radius: 999px;
  font-size: 11px; color: var(--text-dim); cursor: pointer;
  background: var(--bg-hover); border: 1px solid var(--border);
  transition: color 0.15s, border-color 0.15s;
}
.bg-pill:hover { color: var(--text); border-color: var(--text-faint); }
.bg-dot {
  width: 7px; height: 7px; border-radius: 50%; background: var(--green); flex: none;
  animation: bg-breathe 1.4s ease-in-out infinite;
}
@keyframes bg-breathe { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.3; transform: scale(0.7); } }
.bg-caret { font-size: 9px; color: var(--text-faint); }

/* 面板：胶囊正下方卡片，行内 = 描述 ｜ 时长 ｜ 停止 */
.bg-panel {
  margin-top: 6px;
  border: 1px solid var(--border); border-radius: 10px;
  background: var(--bg-panel);
  padding: 8px 10px;
  animation: bg-fade 0.2s ease;
  max-width: 560px;
}
@keyframes bg-fade { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
.bg-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.bg-title { font-size: 11px; font-weight: 600; color: var(--text-dim); letter-spacing: 0.04em; }
.bg-close {
  width: 20px; height: 20px; border: none; background: transparent; border-radius: 6px;
  color: var(--text-faint); font-size: 14px; line-height: 1; cursor: pointer;
}
.bg-close:hover { background: var(--bg-hover); color: var(--text); }

.bg-row {
  display: flex; align-items: center; gap: 10px;
  padding: 5px 4px; border-radius: 6px;
}
.bg-row + .bg-row { border-top: 1px solid var(--border); }
.bg-row:hover { background: var(--bg-hover); }
.bg-desc {
  flex: 1; min-width: 0;
  font-size: 12px; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.bg-elapsed {
  flex: none; font-size: 11px; color: var(--text-dim);
  font-family: var(--mono); font-variant-numeric: tabular-nums;
}
/* 停止按钮：垃圾桶图标位，hover 危险红 */
.bg-kill {
  flex: none; width: 24px; height: 24px;
  border: none; background: transparent; border-radius: 6px;
  font-size: 12px; line-height: 1; cursor: pointer;
  opacity: 0.45;
  transition: opacity 0.15s, background 0.15s;
}
.bg-row:hover .bg-kill { opacity: 1; }
.bg-kill:hover { background: var(--red-soft); }
</style>
