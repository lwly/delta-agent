<script setup lang="ts">
// 任务详情右滑面板：Worker 任务 = 独立 Worker 会话（design-f58 §5.1「Worker = 会话」），
// 本面板是对 worker_session_id 会话的轻量视图 —— 复用既有会话 API（零新通道）：
//   历史 = GET /api/sessions/:id/messages（F-53 分页端点，只拉最近一屏）
//   实时 = GET /api/sessions/:id/events（SSE，经 useSessionTranscript 订阅）
//   续发消息 = POST /api/sessions/:id/messages（hub 单槽：运行中 409，输入区禁用兜底）
// 数据源任务行 = tasks store（2s 轮询），状态 chip / result_summary 随轮询自动更新。
// 步骤摘要「N 个步骤 · X 秒」= 本会话工具调用计数 + task.started_at..finished_at 现算。
//
// 架构收口 T9（判据 1）：自建的 msgs/toolCards/streamingText 状态与 SSE 六类事件
// 分支全部删除，收敛到 composables/useSessionTranscript（历史拉取 + SSE 增量 +
// pairToolCards 单一配对来源）。判据 3：confirm_request / plan_approval_request
// 不再静默吞掉——pendingDecisions 计数上浮，渲染统一禁用提示（本面板不做交互回填）。
import { computed, onUnmounted, ref } from 'vue';
import { api } from '../api/client';
import { useTasksStore } from '../stores/tasks';
import ToolCallCard from './ToolCallCard.vue';
import { useSessionTranscript } from '../composables/useSessionTranscript';
import { WORKER_TASK_STATUS_LABEL, workerTaskCanCancel } from '../utils/workerTaskLabels';

const tasks = useTasksStore();

const task = computed(() => tasks.openTask);
const panelOpen = computed(() => tasks.openTaskId != null);

// ── Worker 会话消息流（T9：状态与 SSE 全部由 composable 承担，切任务自动重置）──
const tr = useSessionTranscript({
  sessionId: () => task.value?.worker_session_id ?? null,
});
const msgs = tr.messages;
const toolCards = tr.toolCards;
const streamingText = tr.streamingText;
const running = tr.running;
const loading = tr.loading;
const loadFailed = tr.loadFailed;

// 判据 3：待决策计数（确认 / 计划审批 / 提问）——统一禁用提示的数据源
const pendingDecisions = tr.pendingDecisions;

const input = ref('');
const sending = ref(false);
const sendError = ref('');
const canceling = ref(false);

const statusLabel = computed(() => {
  const s = task.value?.status;
  return s ? WORKER_TASK_STATUS_LABEL[s] : '';
});

const canCancel = computed(() => (task.value ? workerTaskCanCancel(task.value.status) : false));

/** 继续发消息可用性：会话运行中不可插入指令（hub 单槽 409，§2.2） */
const canSend = computed(() => !!task.value?.worker_session_id && !running.value && !sending.value);

/** 步骤摘要：N 个步骤 · X 秒（运行中实时累计到当前时刻） */
const stepsSummary = computed(() => {
  const t = task.value;
  if (!t) return '';
  const n = toolCards.value.length;
  const start = t.started_at;
  if (start == null) return '';
  const end = t.finished_at ?? Date.now();
  const sec = Math.max(1, Math.round((end - start) / 1000));
  return `${n} 个步骤 · ${sec} 秒`;
});

/** 派单原文折叠条（goal 全文，默认折叠只留摘要行） */
const goalOneLine = computed(() => {
  const g = task.value?.goal ?? '';
  const first = g.split('\n')[0]!.trim();
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
});

// ── 续发消息（会话空闲时直发；运行中被禁用） ───────────────────
async function send() {
  const t = task.value;
  const sid = t?.worker_session_id;
  const text = input.value.trim();
  if (!sid || !text || running.value || sending.value) return;
  sending.value = true;
  sendError.value = '';
  input.value = '';
  tr.pushLocalUser(text);
  try {
    await api.send(sid, text);
  } catch (e) {
    sendError.value = (e as Error).message;
    // 409 = 会话正被占用（轮询间隙状态漂移）：本地回滚并提示
    tr.rollbackLocalUser(text);
  } finally {
    sending.value = false;
  }
}

async function cancelTask() {
  const id = task.value?.id;
  if (!id || canceling.value) return;
  canceling.value = true;
  try {
    await tasks.cancel(id);
  } finally {
    canceling.value = false;
  }
}

onUnmounted(() => tr.dispose());
</script>

<template>
  <aside v-if="panelOpen" class="tdp">
  <template v-if="task">
    <!-- 头部：标题 + 状态 chip + 关闭 -->
    <header class="tdp-head">
      <span class="tdp-title" :title="task.title">{{ task.title }}</span>
      <span class="tdp-status" :class="`tdp-status--${task.status}`">{{ statusLabel }}</span>
      <button class="tdp-close" type="button" title="关闭面板" @click="tasks.openTaskPanel(null)">×</button>
    </header>

    <!-- 结论 / 失败原因 / 裁决提示 -->
    <div v-if="task.result_summary" class="tdp-summary" :class="{ fail: task.status === 'failed' }">
      {{ task.result_summary }}
    </div>

    <!-- T9 判据 3：待决策统一禁用提示（confirm/plan/ask 不静默吞掉；本面板不做交互回填） -->
    <div v-if="pendingDecisions.total > 0" class="tdp-decision-hint">
      ⚠ 本会话有 {{ pendingDecisions.total }} 项待处理决策（确认 {{ pendingDecisions.confirms.length }} /
      计划审批 {{ pendingDecisions.plans.length }} / 提问 {{ pendingDecisions.asks.length }}）——
      请到主对话页处理，本面板不做交互回填
    </div>

    <!-- 派单原文 + 步骤摘要（折叠条） -->
    <details v-if="stepsSummary || task.goal" class="tdp-steps" :open="task.status === 'running'">
      <summary>
        <span class="tdp-steps-count">{{ stepsSummary || '派单详情' }}</span>
        <span v-if="running" class="tdp-thinking">正在思考思路…</span>
      </summary>
      <div class="tdp-goal">{{ task.goal }}</div>
      <div v-if="task.acceptance" class="tdp-acceptance">验收：{{ task.acceptance }}</div>
    </details>

    <!-- 尚未创建执行会话（draft/queued/preflight 阶段） -->
    <div v-if="!task.worker_session_id" class="tdp-empty">
      <p>任务{{ statusLabel }}，执行会话尚未创建…</p>
      <button
        v-if="canCancel"
        class="tdp-stop"
        type="button"
        :disabled="canceling"
        @click="cancelTask"
      >{{ canceling ? '停止中…' : '停止' }}</button>
    </div>
    <div v-else-if="loading" class="tdp-empty">加载会话记录…</div>
    <div v-else-if="loadFailed" class="tdp-empty">会话记录加载失败（该任务可能由外部 agent 执行）</div>

    <!-- 会话流：工具卡 + 助手文本 + 用户消息 -->
    <div v-else class="tdp-scroll">
      <div v-for="(m, i) in msgs" :key="m.seq ?? `local-${i}`" class="tdp-msg" :class="`tdp-msg--${m.role}`">
        <span class="tdp-role">{{ m.role === 'user' ? '你' : m.role === 'assistant' ? '助手' : '工具' }}</span>
        <div class="tdp-bubble">{{ m.content }}</div>
      </div>
      <ToolCallCard
        v-for="c in toolCards"
        :key="c.callId"
        :name="c.name"
        :args-json="c.argsJson"
        :status="c.status"
        :content="c.content"
        :duration-ms="c.durationMs"
        :seq="c.seq"
      />
      <div v-if="streamingText" class="tdp-msg tdp-msg--assistant">
        <span class="tdp-role">助手</span>
        <div class="tdp-bubble streaming">{{ streamingText }}▍</div>
      </div>
      <div v-if="!msgs.length && !toolCards.length && !streamingText && running" class="tdp-empty">正在思考思路…</div>
    </div>

    <!-- 底部续发消息 / 运行中停止 -->
    <footer class="tdp-composer" :title="running ? '任务执行中，输入暂不可用（会话单槽）' : ''">
      <div v-if="canCancel && task.worker_session_id" class="tdp-cancel-row">
        <button class="tdp-stop" type="button" :disabled="canceling" @click="cancelTask">
          {{ canceling ? '停止中…' : '停止任务' }}
        </button>
      </div>
      <div v-if="sendError" class="tdp-send-error">{{ sendError }}</div>
      <div class="tdp-input-row">
        <input
          v-model="input"
          class="tdp-input"
          :disabled="!canSend"
          :placeholder="canSend ? `在「${task.title}」中给助手发消息` : running ? '任务执行中，暂不可发消息' : '等待任务启动…'"
          @keyup.enter="send"
        />
        <button class="tdp-send" type="button" :disabled="!canSend || !input.trim()" @click="send">↑</button>
      </div>
    </footer>
  </template>
  <div v-else class="tdp-loading">
    <header class="tdp-head">
      <span class="tdp-title">加载任务…</span>
      <button class="tdp-close" type="button" title="关闭面板" @click="tasks.openTaskPanel(null)">×</button>
    </header>
  </div>
  </aside>
</template>

<style scoped>
/* 右滑面板：固定右侧非模态（不挡侧栏/主区点击），380px；入场滑入 */
.tdp {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 380px;
  z-index: 60;
  display: flex;
  flex-direction: column;
  background: var(--bg-chrome);
  border-left: 1px solid var(--border);
  animation: tdp-slide 0.18s ease-out;
}
@keyframes tdp-slide {
  from { transform: translateX(30px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
.tdp-loading { flex: 1; display: flex; flex-direction: column; }
.tdp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.tdp-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tdp-status {
  flex: none;
  font-size: 10px;
  padding: 2px 8px;
  border-radius: var(--radius-pill, 999px);
  background: var(--bg-hover);
  color: var(--text-dim);
}
.tdp-status--queued, .tdp-status--preflight { background: var(--accent-soft, var(--bg-hover)); color: var(--accent); }
.tdp-status--running { background: var(--green-soft, var(--bg-hover)); color: var(--green); }
.tdp-status--needs_decision { background: var(--orange-soft); color: var(--orange); }
.tdp-status--done { background: var(--bg-hover); color: var(--green); }
.tdp-status--failed { background: var(--red-soft, var(--bg-hover)); color: var(--red); }
.tdp-close {
  flex: none;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--radius-sm, 6px);
  background: transparent;
  color: var(--text-dim);
  font-size: 16px;
  cursor: pointer;
}
.tdp-close:hover { background: var(--bg-hover); color: var(--text); }
.tdp-summary {
  margin: 10px 14px 0;
  padding: 8px 10px;
  border-radius: var(--radius-sm, 8px);
  background: var(--bg-hover);
  font-size: 12px;
  color: var(--text);
  white-space: pre-wrap;
}
.tdp-summary.fail { color: var(--red); }
/* T9 判据 3：待决策统一禁用提示（不静默吞掉 confirm/plan 事件） */
.tdp-decision-hint {
  margin: 10px 14px 0;
  padding: 8px 10px;
  border: 1px solid var(--orange);
  background: var(--orange-soft);
  border-radius: var(--radius-sm, 8px);
  color: var(--text-dim);
  font-size: 12px;
}
.tdp-steps { margin: 8px 14px 0; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius-sm, 8px); }
.tdp-steps summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 0;
  cursor: pointer;
  font-size: 11.5px;
  color: var(--text-dim);
  list-style: none;
}
.tdp-steps summary::-webkit-details-marker { display: none; }
.tdp-steps-count { flex: 1; }
.tdp-thinking { color: var(--accent); }
.tdp-goal, .tdp-acceptance { padding: 4px 0 8px; font-size: 11.5px; color: var(--text-faint); white-space: pre-wrap; }
.tdp-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tdp-msg { display: flex; flex-direction: column; gap: 3px; }
.tdp-msg--user .tdp-role { color: var(--text-faint); }
.tdp-role { font-size: 10px; color: var(--text-faint); }
.tdp-bubble {
  padding: 7px 10px;
  border-radius: 8px;
  background: var(--bg-hover);
  font-size: 12px;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}
.tdp-msg--user .tdp-bubble { background: var(--accent-soft); }
.tdp-bubble.streaming { color: var(--text-dim); }
.tdp-empty {
  padding: 20px 14px;
  font-size: 12px;
  color: var(--text-faint);
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.tdp-empty p { margin: 0; }
.tdp-stop {
  height: 28px;
  padding: 0 14px;
  border: 1px solid var(--red);
  border-radius: var(--radius-pill, 999px);
  background: transparent;
  color: var(--red);
  font-size: 12px;
  cursor: pointer;
}
.tdp-stop:hover:not(:disabled) { background: var(--red-soft, rgba(248, 81, 73, 0.12)); }
.tdp-stop:disabled { opacity: 0.5; cursor: not-allowed; }
.tdp-cancel-row { padding-bottom: 8px; }
.tdp-composer { border-top: 1px solid var(--border); padding: 10px 14px; }
.tdp-send-error { font-size: 11px; color: var(--red); padding-bottom: 6px; }
.tdp-input-row { display: flex; gap: 8px; }
.tdp-input {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill, 999px);
  background: var(--bg-hover);
  color: var(--text);
  font-size: 12px;
  outline: none;
}
.tdp-input:focus { border-color: var(--accent); }
.tdp-input:disabled { opacity: 0.5; cursor: not-allowed; }
.tdp-send {
  flex: none;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  font-size: 14px;
  cursor: pointer;
}
.tdp-send:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
