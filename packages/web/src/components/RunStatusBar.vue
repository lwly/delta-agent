<script setup lang="ts">
// 运行状态条：topbar 与消息流之间的固定条。
// 三态：运行中（呼吸点 + 当前步骤 + 最近工具 + 已执行步数）/ 已暂停 / 已停止（本地 UI 态）。
// 控制按钮：暂停（描边中性）/ 停止（实心危险红）/ 继续（绿描边，聚焦输入区提示发送续跑）。
// Token 小字口径：今日用量来自 usageSummary（进入会话/运行结束时刷新）+ 上一次 done 的任务用量，
// 协议无增量事件，不做假实时。
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api/client';
import { useChatStore } from '../stores/chat';
import { toolLabel } from '../utils/toolNames';

const emit = defineEmits<{ (e: 'resume'): void }>();
const chat = useChatStore();

/** 三态推导：运行中 > 已停止（本地标志）> 已暂停；空闲不渲染状态条 */
const state = computed<'running' | 'stopped' | 'paused' | null>(() => {
  if (chat.running) return 'running';
  if (chat.stopped) return 'stopped';
  if (chat.paused) return 'paused';
  return null;
});

/** 当前（最新一次）工具调用：步骤序号 + 名称（本地计数口径） */
const latestCall = computed(() => {
  let best: { name: string; seq: number } | null = null;
  for (const pc of Object.values(chat.pendingCalls)) {
    if (!best || pc.seq > best.seq) best = { name: pc.name, seq: pc.seq };
  }
  return best;
});

/** 已执行步数：最后一次用户消息之后的 tool 结果条数（本次运行内口径） */
const executedSteps = computed(() => {
  let lastUserIdx = -1;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    if (chat.messages[i]!.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  let n = 0;
  for (let i = lastUserIdx + 1; i < chat.messages.length; i++) {
    if (chat.messages[i]!.role === 'tool') n += 1;
  }
  return n;
});

// ── 今日 token 小字（usageSummary 口径；取不到就隐藏该段） ──
const todayTokens = ref<number | null>(null);
function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
async function refreshToday() {
  try {
    const s = await api.usageSummary('today');
    todayTokens.value = s.totals.input_tokens + s.totals.output_tokens;
  } catch {
    todayTokens.value = null; // 用量接口不可用 → 隐藏该段，不阻塞状态条
  }
}
onMounted(refreshToday);
watch(
  () => chat.running,
  (running, prev) => {
    if (prev === true && running === false) void refreshToday();
  },
);

function onResume() {
  emit('resume');
}
</script>

<template>
  <div v-if="state" class="runbar" :class="state" role="status">
    <span class="runbar-stripe" aria-hidden="true" />
    <span v-if="state === 'running'" class="run-dot" aria-hidden="true" />
    <span class="runbar-text">
      <template v-if="state === 'running'">Agent 运行中<template v-if="latestCall"> · 正在执行第 {{ latestCall.seq }} 步 · 最近工具：{{ toolLabel(latestCall.name) }}</template> · 已执行 {{ executedSteps }} 步工具调用</template>
      <template v-else-if="state === 'paused'">⏸ 已暂停 · 发送消息以继续</template>
      <template v-else>■ 已停止 · 可重新发送任务或从停止点继续（直接输入即可）</template>
    </span>
    <!-- token 口径小字：任一数据源缺失则整段隐藏；胶囊样式与左侧运行状态区隔，避免误读为本轮开销 -->
    <span
      v-if="todayTokens != null || chat.lastUsage"
      class="runbar-tok"
      title="口径：今日累计 = 当日全部会话合计（usage summary，非本轮开销）；上次任务 = 最近一次 done 事件（无实时增量）"
    >
      <template v-if="todayTokens != null">今日累计 {{ fmtTok(todayTokens) }} tok</template>
      <template v-if="todayTokens != null && chat.lastUsage"> · </template>
      <template v-if="chat.lastUsage">上次任务 +{{ fmtTok(chat.lastUsage.inputTokens) }}/+{{ fmtTok(chat.lastUsage.outputTokens) }}</template>
    </span>
    <span class="runbar-spring" />
    <button v-if="state === 'running'" class="ctrl pause" type="button" title="暂停执行（发送消息可恢复）" @click="chat.pause()">⏸ 暂停</button>
    <button v-if="state === 'running'" class="ctrl stop" type="button" title="停止执行（停止后可直接继续输入）" @click="chat.abort()">■ 停止</button>
    <button v-if="state === 'paused'" class="ctrl resume" type="button" title="聚焦输入区，发送消息即继续执行" @click="onResume">▶ 继续</button>
  </div>
</template>

<style scoped>
/* 状态条：高 36px、--bg-panel 底、底部 1px 边框、左侧 8px 状态色竖条（G 规范） */
.runbar {
  display: flex; align-items: center; gap: 10px;
  min-height: 36px; padding: 0 16px 0 0;
  background: var(--bg-panel); border-bottom: 1px solid var(--border);
  position: relative; overflow: hidden;
  animation: fadeIn 0.2s ease;
}
.runbar-stripe { width: 8px; align-self: stretch; flex: none; }
.runbar.running .runbar-stripe { background: var(--green); }
.runbar.paused .runbar-stripe { background: var(--orange); }
.runbar.stopped .runbar-stripe { background: var(--red); }
.runbar-text { font-size: 12px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
/* token 小字：胶囊化与运行状态文案区隔（反馈：紧贴「运行中」易被误读为本轮开销） */
.runbar-tok {
  font-size: 11px; color: var(--text-dim); font-family: var(--mono); white-space: nowrap; flex: none;
  padding: 3px 10px; border-radius: 999px;
  background: var(--bg-hover); border: 1px solid var(--border);
}
.runbar-spring { flex: 1; min-width: 0; }

/* 呼吸圆点 */
.run-dot {
  width: 8px; height: 8px; border-radius: 50%; background: var(--green);
  flex: none; animation: dot-breathe 1.4s ease-in-out infinite;
}
@keyframes dot-breathe { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.3; transform: scale(0.7); } }

/* 控制按钮：30px 高、8px 圆角、hover 加深一档（G 规范） */
.ctrl {
  height: 30px; padding: 0 14px; border-radius: 8px;
  font-size: 12px; font-weight: 600; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px; flex: none;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
/* 暂停：1px 描边中性 */
.ctrl.pause { border: 1px solid var(--border-strong); background: transparent; color: var(--text-dim); }
.ctrl.pause:hover { background: var(--bg-hover); color: var(--text); border-color: var(--text-faint); }
.ctrl.pause:active { background: var(--bg-active); }
/* 停止：实心危险红 */
.ctrl.stop { border: 1px solid var(--red); background: var(--red); color: #fff; }
.ctrl.stop:hover { background: rgba(248, 81, 73, 0.85); }
.ctrl.stop:active { background: rgba(248, 81, 73, 0.7); }
/* 继续：绿色描边 */
.ctrl.resume { border: 1px solid var(--green); background: transparent; color: var(--green); }
.ctrl.resume:hover { background: var(--green-soft); }
.ctrl.resume:active { background: rgba(63, 185, 80, 0.2); }
</style>
