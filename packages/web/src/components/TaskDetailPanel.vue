<script setup lang="ts">
// 任务详情右滑面板：Worker 任务 = 独立 Worker 会话（design-f58 §5.1「Worker = 会话」），
// 本面板是对 worker_session_id 会话的轻量视图 —— 复用既有会话 API（零新通道）：
//   历史 = GET /api/sessions/:id/messages（F-53 分页端点，只拉最近一屏）
//   实时 = GET /api/sessions/:id/events（SSE，subscribeSession）
//   续发消息 = POST /api/sessions/:id/messages（hub 单槽：运行中 409，输入区禁用兜底）
// 数据源任务行 = tasks store（2s 轮询），状态 chip / result_summary 随轮询自动更新。
// 步骤摘要「N 个步骤 · X 秒」= 本会话工具调用计数 + task.started_at..finished_at 现算。
import { computed, onUnmounted, ref, watch } from 'vue';
import { api, type ChatMessage } from '../api/client';
import { subscribeSession } from '../api/sse';
import { useTasksStore } from '../stores/tasks';
import ToolCallCard from './ToolCallCard.vue';

const tasks = useTasksStore();

const task = computed(() => tasks.openTask);

// ── Worker 会话视图状态（会话作用域：切任务即重置） ─────────────
interface ToolCardView {
  callId: string;
  name: string;
  argsJson: string;
  status: 'running' | 'ok' | 'fail';
  content: string;
  durationMs: number | null;
  seq: number;
}
const msgs = ref<ChatMessage[]>([]);
const toolCards = ref<ToolCardView[]>([]); // 工具卡（callId 配对调用/结果）
const streamingText = ref('');
const running = ref(false);
const loading = ref(false);
const loadFailed = ref(false);
let unsub: (() => void) | null = null;
let boundSessionId = '';
let toolSeq = 0;

const input = ref('');
const sending = ref(false);
const sendError = ref('');

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

// ── 打开/关闭面板（含任务切换） ────────────────────────────────
watch(
  () => [tasks.openTaskId, task.value?.worker_session_id] as const,
  ([, sid], prev) => {
    const prevSid = prev?.[1];
    if (!tasks.openTaskId || !sid) {
      // 面板关闭 / 任务尚未创建执行会话（draft/queued 阶段）：停流
      closeStream();
      return;
    }
    if (sid !== prevSid || boundSessionId !== sid) openStream(sid);
  },
  { immediate: true },
);

function closeStream() {
  unsub?.();
  unsub = null;
  boundSessionId = '';
  msgs.value = [];
  toolCards.value = [];
  streamingText.value = '';
  running.value = false;
  loading.value = false;
  loadFailed.value = false;
  sendError.value = '';
}

async function openStream(sessionId: string) {
  closeStream();
  boundSessionId = sessionId;
  loading.value = true;
  try {
    const page = await api.getSessionMessages(sessionId, { limit: 50 });
    // await 期间面板可能已切走：过期响应丢弃
    if (boundSessionId !== sessionId) return;
    msgs.value = page.messages;
    // 历史工具消息重建卡片（SSE 实时卡与落库消息双轨：历史从消息流配对）
    rebuildCardsFromHistory(page.messages);
    loadFailed.value = false;
  } catch {
    if (boundSessionId === sessionId) loadFailed.value = true;
  } finally {
    if (boundSessionId === sessionId) loading.value = false;
  }
  unsub = subscribeSession(sessionId, onEvent);
}

/** 历史消息重建工具卡：调用信息来自 assistant.toolCalls，结果来自 role:'tool' 消息，按 callId 配对 */
function rebuildCardsFromHistory(list: ChatMessage[]) {
  const seqOf = new Map<string, number>();
  for (const m of list) {
    for (const call of m.toolCalls ?? []) {
      toolSeq += 1;
      seqOf.set(call.id, toolSeq);
      toolCards.value.push({
        callId: call.id,
        name: call.name,
        argsJson: call.argsJson,
        status: 'running',
        content: '',
        durationMs: null,
        seq: toolSeq,
      });
    }
    if (m.role === 'tool' && m.toolCallId) {
      const existing = toolCards.value.find((c) => c.callId === m.toolCallId);
      if (existing) {
        existing.status = m.ok === false ? 'fail' : 'ok';
        existing.content = m.content;
      } else {
        // 孤儿结果（调用消息被折叠窗口截掉）：兜底建卡
        toolSeq += 1;
        toolCards.value.push({
          callId: m.toolCallId,
          name: 'tool',
          argsJson: '',
          status: m.ok === false ? 'fail' : 'ok',
          content: m.content,
          durationMs: null,
          seq: m.toolSeq ?? toolSeq,
        });
      }
    }
  }
}

// ── SSE 事件（面板只关心的最小子集；完整口径见 stores/chat.ts） ──
function onEvent(ev: { type: string; [k: string]: unknown }) {
  switch (ev.type) {
    case 'state':
      running.value = ev.running === true;
      break;
    case 'text_delta':
      streamingText.value += String(ev.text ?? '');
      break;
    case 'tool_call_start': {
      const call = ev.call as { id: string; name: string; argsJson: string };
      if (streamingText.value) {
        msgs.value.push({ role: 'assistant', content: streamingText.value, ts: Date.now() });
        streamingText.value = '';
      }
      toolSeq += 1;
      toolCards.value.push({
        callId: call.id,
        name: call.name,
        argsJson: call.argsJson,
        status: 'running',
        content: '',
        durationMs: null,
        seq: toolSeq,
      });
      break;
    }
    case 'tool_result': {
      const r = ev.result as { callId: string; ok: boolean; content: string };
      const card = toolCards.value.find((c) => c.callId === r.callId);
      if (card) {
        card.status = r.ok ? 'ok' : 'fail';
        card.content = r.content;
        card.durationMs = null;
      } else {
        // 孤儿结果（历史已含调用但结果刚到）：兜底建卡
        toolCards.value.push({
          callId: r.callId,
          name: 'tool',
          argsJson: '',
          status: r.ok ? 'ok' : 'fail',
          content: r.content,
          durationMs: null,
          seq: ++toolSeq,
        });
      }
      break;
    }
    case 'ask_user':
      // 澄清问答：渲染为助手消息卡（用户在输入框回答，走普通消息通道）
      msgs.value.push({ role: 'assistant', content: `❓ ${String(ev.question)}`, ts: Date.now() });
      break;
    case 'done': {
      if (streamingText.value) {
        msgs.value.push({ role: 'assistant', content: streamingText.value, ts: Date.now() });
        streamingText.value = '';
      }
      void refetchAfterDone();
      break;
    }
    default:
      break;
  }
}

/** done 后增量重拉（after 游标），保证本地视图与落库一致（对齐 chat store done 分支口径的简化版） */
async function refetchAfterDone() {
  const sid = boundSessionId;
  if (!sid) return;
  try {
    const lastSeq = [...msgs.value].reverse().find((m) => m.seq != null)?.seq ?? 0;
    const fetched: ChatMessage[] = [];
    let after = lastSeq;
    for (let guard = 0; guard < 20; guard++) {
      const r = await api.getSessionMessages(sid, { after, limit: 500 });
      fetched.push(...r.messages);
      if (!r.has_more || r.messages.length === 0) break;
      after = r.messages[r.messages.length - 1]!.seq ?? after;
    }
    if (boundSessionId !== sid) return;
    if (fetched.length > 0) msgs.value.push(...fetched);
  } catch {
    /* 瞬时失败：下轮 done/重开面板兜底 */
  }
}

// ── 续发消息（会话空闲时直发；运行中被禁用） ───────────────────
async function send() {
  const t = task.value;
  const sid = t?.worker_session_id;
  const text = input.value.trim();
  if (!sid || !text || running.value || sending.value) return;
  sending.value = true;
  sendError.value = '';
  input.value = '';
  msgs.value.push({ role: 'user', content: text, ts: Date.now() });
  try {
    await api.send(sid, text);
  } catch (e) {
    sendError.value = (e as Error).message;
    // 409 = 会话正被占用（轮询间隙状态漂移）：本地回滚并提示
    const idx = msgs.value.findIndex((m) => m.role === 'user' && m.content === text);
    if (idx !== -1) msgs.value.splice(idx, 1);
  } finally {
    sending.value = false;
  }
}

onUnmounted(closeStream);
</script>

<template>
  <aside v-if="task" class="tdp">
    <!-- 头部：标题 + 状态 chip + 关闭 -->
    <header class="tdp-head">
      <span class="tdp-title" :title="task.title">{{ task.title }}</span>
      <span class="tdp-status" :class="`tdp-status--${task.status}`">{{ task.status }}</span>
      <button class="tdp-close" type="button" title="关闭面板" @click="tasks.openTaskPanel(null)">×</button>
    </header>

    <!-- 结论 / 失败原因 / 裁决提示 -->
    <div v-if="task.result_summary" class="tdp-summary" :class="{ fail: task.status === 'failed' }">
      {{ task.result_summary }}
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
      任务{{ task.status === 'queued' ? '排队中' : '准备中' }}，执行会话尚未创建…
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

    <!-- 底部续发消息 -->
    <footer class="tdp-composer" :title="running ? '任务执行中，输入暂不可用（会话单槽）' : ''">
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
.tdp-status--running, .tdp-status--preflight { background: var(--green-soft, var(--bg-hover)); color: var(--green); }
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
.tdp-empty { padding: 20px 14px; font-size: 12px; color: var(--text-faint); text-align: center; }
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
