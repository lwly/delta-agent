<script setup lang="ts">
// F-58 needs_decision 裁决弹窗：preflight 失败 / 无只读档 / 登录态缺失 / 依赖任务失败后的人工介入。
// 三动作 retry / cancel / accept 调 POST /api/worker-tasks/:id/decision；
// 红线：无乐观更新——store.decide 端点成功后才 refresh；失败在弹窗内展示错误、列表不动。
import { computed, ref } from 'vue';
import ModalShell from './ModalShell.vue';
import { useTasksStore, type TaskDecision } from '../stores/tasks';
import type { WorkerTaskView } from '../api/client';

const props = defineProps<{ task: WorkerTaskView }>();
const emit = defineEmits<{ close: [] }>();

const store = useTasksStore();
const submitting = ref<'retry' | 'cancel' | 'accept' | null>(null);
const error = ref('');

/** decision_json 解析结果摘要（结构由裁决场景定义：preflight 失败带 reason/message） */
const decisionSummary = computed<string>(() => {
  const d = props.task.decision;
  if (d == null) return '';
  if (typeof d === 'object') {
    const o = d as Record<string, unknown>;
    const parts: string[] = [];
    if (o.reason) parts.push(`原因：${String(o.reason)}`);
    if (o.message) parts.push(String(o.message));
    if (parts.length > 0) return parts.join('\n');
  }
  try {
    return JSON.stringify(d, null, 2);
  } catch {
    return String(d);
  }
});

async function decide(decision: TaskDecision): Promise<void> {
  submitting.value = decision;
  error.value = '';
  try {
    await store.decide(props.task.id, decision);
    emit('close');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    submitting.value = null;
  }
}
</script>

<template>
  <ModalShell title="任务待裁决" :width="480" icon="⚖️" @close="emit('close')">
    <div class="decide">
      <div class="d-task">
        <div class="d-title">{{ task.title }}</div>
        <div class="d-goal">{{ task.goal }}</div>
        <div v-if="decisionSummary" class="d-reason">{{ decisionSummary }}</div>
        <div class="d-meta">第 {{ task.attempt + 1 }} 次尝试 · {{ task.executor ?? '内置引擎' }} · {{ task.permission_mode === 'plan' && task.executor ? '已请求只读' : task.permission_mode }}</div>
      </div>
      <p class="d-error" v-if="error">✘ {{ error }}</p>
      <div class="d-actions">
        <button class="btn" :disabled="submitting !== null" @click="decide('retry')">
          {{ submitting === 'retry' ? '提交中…' : '重试' }}
        </button>
        <button class="btn danger" :disabled="submitting !== null" @click="decide('cancel')">
          {{ submitting === 'cancel' ? '提交中…' : '取消任务' }}
        </button>
        <button class="btn" :disabled="submitting !== null" @click="decide('accept')">
          {{ submitting === 'accept' ? '提交中…' : '接受现状' }}
        </button>
      </div>
    </div>
  </ModalShell>
</template>

<style scoped>
.decide { display: flex; flex-direction: column; gap: 12px; }
.d-task { display: flex; flex-direction: column; gap: 6px; }
.d-title { font-size: 14px; font-weight: 600; color: var(--text); }
.d-goal {
  font-size: 12px; color: var(--text-dim); line-height: 1.5;
  max-height: 96px; overflow-y: auto;
  white-space: pre-wrap; word-break: break-word;
}
.d-reason {
  font-size: 12px; color: var(--orange); line-height: 1.5;
  background: var(--orange-soft); border-radius: 6px; padding: 8px 10px;
  white-space: pre-wrap; word-break: break-word;
}
.d-meta { font-size: 11px; color: var(--text-faint); }
.d-error { font-size: 12px; color: var(--red); }
.d-actions { display: flex; gap: 8px; justify-content: flex-end; }
.d-actions .btn { min-width: 76px; }
</style>
