<script setup lang="ts">
// F-58 任务台（侧栏）：当前项目的 Worker 任务列表。
// 每行 = 状态点 + 标题（role_label 仅作标签渲染，红线）+ 结论（result_summary / failure_kind）
// + 存疑角标（watchdog_flag==='suspect'，§10 只标记不纠偏）+ 已运行 X 分钟（§18-8 提示）
// + 裁决入口（needs_decision → TaskDecisionDialog）。
// 外部 Worker 的 permission_mode 文案写「已请求只读」（裁决 Q5，不写「只读」）。
// 数据源与轮询在 stores/tasks.ts（2s；watch 接线在 WorkbenchView，对齐 bgTasks 惯例）。
import { onUnmounted, ref, watch } from 'vue';
import { useTasksStore } from '../stores/tasks';
import type { FailureKind, WorkerTaskStatus, WorkerTaskView } from '../api/client';
import TaskDecisionDialog from './TaskDecisionDialog.vue';

const tasks = useTasksStore();

// 「已运行 X 分钟」现算：仅存在运行中任务时开表（与 BackgroundTasksBar 同手法）
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;
watch(
  () => tasks.tasks.some((t) => t.status === 'running' || t.status === 'preflight'),
  (active) => {
    if (active && !ticker) {
      now.value = Date.now();
      ticker = setInterval(() => (now.value = Date.now()), 30_000);
    } else if (!active && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  },
  { immediate: true },
);
onUnmounted(() => {
  if (ticker) clearInterval(ticker);
});

/** 状态点颜色（各状态一色；语义色仅用于运行/危险/待决策，对齐 theme.css 口径） */
function dotCls(status: WorkerTaskStatus): string {
  switch (status) {
    case 'running':
      return 'dot-running';
    case 'preflight':
      return 'dot-preflight';
    case 'needs_decision':
      return 'dot-decision';
    case 'done':
      return 'dot-done';
    case 'failed':
      return 'dot-failed';
    default: // draft / queued / canceled → 弱化灰
      return 'dot-idle';
  }
}

const STATUS_LABEL: Record<WorkerTaskStatus, string> = {
  draft: '草稿',
  queued: '排队中',
  preflight: '预检中',
  running: '运行中',
  needs_decision: '待裁决',
  done: '已完成',
  failed: '失败',
  canceled: '已取消',
};

const FAILURE_LABEL: Record<FailureKind, string> = {
  preflight: '预检失败',
  runtime: '运行失败',
  watchdog_l2: '越界终止',
  aborted: '已中止',
  canceled: '已取消',
};

/** 运行时长（分钟向上取整；§18-8 已知限制：>30min 会被既有僵尸回收，仅作提示） */
function elapsedMin(t: WorkerTaskView): number {
  if (t.started_at == null) return 0;
  const end = t.finished_at ?? now.value;
  return Math.max(1, Math.round((end - t.started_at) / 60_000));
}

/** 外部 Worker 且请求了 plan 档 → 「已请求只读」（裁决 Q5） */
function readOnlyTag(t: WorkerTaskView): boolean {
  return t.executor !== null && t.permission_mode === 'plan';
}

// 裁决弹窗：当前待裁决任务（弹窗内动作成功后经 store.refresh 对齐服务端真值）
const deciding = ref<WorkerTaskView | null>(null);
</script>

<template>
  <div class="task-board">
    <div class="tb-head">
      <span class="tb-title">任务台</span>
      <span v-if="tasks.interruptCount > 0" class="tb-red-dot" :title="`${tasks.interruptCount} 条需要你注意（待裁决 / 被终止）`">
        {{ tasks.interruptCount }}
      </span>
    </div>
    <div class="tb-list">
      <div v-for="t in tasks.tasks" :key="t.id" class="tb-row" :title="t.goal">
        <span class="tb-dot" :class="dotCls(t.status)" />
        <span class="tb-main">
          <span class="tb-title-line">
            <span class="tb-name">{{ t.title }}</span>
            <span v-if="t.role_label" class="tb-role">{{ t.role_label }}</span>
            <span v-if="readOnlyTag(t)" class="tb-readonly" title="外部 agent 的工具集无法收窄，已请求其以只读档运行">已请求只读</span>
            <span v-if="t.watchdog_flag === 'suspect'" class="tb-suspect" title="看门狗 L3 粗筛标记：疑似越界，只标记不纠偏（§9.1）">存疑</span>
          </span>
          <span class="tb-sub">
            <span class="tb-status">{{ STATUS_LABEL[t.status] }}</span>
            <span v-if="t.status === 'running' || t.status === 'preflight'" class="tb-elapsed">已运行 {{ elapsedMin(t) }} 分钟</span>
            <span v-else-if="t.status === 'failed'" class="tb-failure" :title="t.result_summary ?? undefined">
              {{ FAILURE_LABEL[t.failure_kind ?? 'runtime'] }}
            </span>
            <span v-else-if="t.status === 'done' && t.result_summary" class="tb-result" :title="t.result_summary">{{ t.result_summary }}</span>
          </span>
        </span>
        <button v-if="t.status === 'needs_decision'" class="tb-decide" type="button" title="人工裁决：重试 / 取消 / 接受" @click="deciding = t">
          裁决
        </button>
      </div>
      <div v-if="tasks.tasks.length === 0" class="tb-empty">（无任务记录）</div>
    </div>

    <TaskDecisionDialog v-if="deciding" :task="deciding" @close="deciding = null" />
  </div>
</template>

<style scoped>
.task-board {
  border-top: 1px solid var(--border);
  padding: 10px 8px 6px;
  font-size: 12px;
}
.tb-head {
  display: flex; align-items: center; gap: 6px;
  padding: 0 4px 6px;
}
.tb-title {
  font-size: 11px; font-weight: 600; color: var(--text-dim); letter-spacing: 0.04em;
}
/* 红点：未送达 interrupt 计数（needs_decision / L2 kill，§10） */
.tb-red-dot {
  min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px;
  background: var(--red); color: #fff;
  font-size: 10px; line-height: 16px; text-align: center;
}
.tb-list { max-height: 180px; overflow-y: auto; }
.tb-row {
  display: flex; align-items: flex-start; gap: 7px;
  padding: 4px; border-radius: 6px;
}
.tb-row:hover { background: var(--bg-hover); }
.tb-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; margin-top: 5px; }
.dot-idle { background: var(--text-faint); }
.dot-preflight { background: var(--accent); }
.dot-running { background: var(--green); animation: tb-breathe 1.4s ease-in-out infinite; }
@keyframes tb-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.dot-decision { background: var(--orange); }
.dot-done { background: var(--green); }
.dot-failed { background: var(--red); }
.tb-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.tb-title-line { display: flex; align-items: center; gap: 5px; min-width: 0; }
.tb-name {
  font-size: 12px; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* role_label 仅作标签渲染（红线，§1.4：不进 prompt） */
.tb-role {
  flex: none; font-size: 9.5px; padding: 1px 5px; border-radius: 4px;
  background: var(--accent-soft); color: var(--accent);
}
.tb-readonly {
  flex: none; font-size: 9.5px; padding: 1px 5px; border-radius: 4px;
  background: var(--bg-hover); color: var(--text-dim);
}
.tb-suspect {
  flex: none; font-size: 9.5px; padding: 1px 5px; border-radius: 4px;
  background: var(--orange-soft); color: var(--orange);
}
.tb-sub { display: flex; align-items: center; gap: 6px; min-width: 0; }
.tb-status { flex: none; font-size: 11px; color: var(--text-dim); }
.tb-elapsed, .tb-failure, .tb-result {
  font-size: 11px; color: var(--text-faint);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tb-failure { color: var(--red); }
.tb-decide {
  flex: none; height: 20px; padding: 0 8px; border-radius: 5px;
  border: 1px solid var(--orange); background: transparent; color: var(--orange);
  font-size: 10.5px; cursor: pointer;
}
.tb-decide:hover { background: var(--orange-soft); }
.tb-empty { padding: 4px; font-size: 11px; color: var(--text-faint); }
</style>
