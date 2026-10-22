<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useChatStore } from '../stores/chat';
import { renderMarkdown } from '../render';

const route = useRoute();
const store = useChatStore();
const input = ref('');
const listRef = ref<HTMLElement | null>(null);
const sessionId = computed(() => String(route.params.sessionId ?? ''));
const MODE_LABELS: Record<string, string> = {
  react: '⚡ ReAct',
  'plan-execute': '📋 Plan',
  'multi-agent': '🤖 Multi-Agent',
};
const modeBadge = computed(() => {
  const s = store.sessionMeta?.mode;
  return s ? (MODE_LABELS[s] ?? s) : '';
});

onMounted(() => {
  if (sessionId.value) void store.open(sessionId.value);
});
watch(sessionId, (id) => {
  if (id) void store.open(id);
});
watch(
  () => [store.messages.length, store.streamingText],
  async () => {
    await nextTick();
    listRef.value?.scrollTo({ top: listRef.value.scrollHeight });
  },
);

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

async function submit() {
  const text = input.value.trim();
  if (!text || store.running) return;
  input.value = '';
  await store.send(text);
}
</script>

<template>
  <div class="chat">
    <div v-if="store.sessionMeta" class="head">
      <span class="title">{{ store.sessionMeta.title }}</span>
      <span v-if="modeBadge" class="mode">{{ modeBadge }}</span>
      <span class="muted">{{ store.sessionMeta.model || '默认模型' }}</span>
      <router-link class="replay-link" :to="`/replay/${sessionId}`">🎬 回放</router-link>
    </div>
    <div ref="listRef" class="msgs">
      <template v-for="(m, i) in store.messages" :key="i">
        <!-- 用户消息 -->
        <div v-if="m.role === 'user'" class="msg user">
          <div class="bubble">{{ m.content }}</div>
        </div>

        <!-- 工具调用卡片 -->
        <div v-else-if="m.role === 'tool'" class="msg tool">
          <details>
            <summary>
              <span class="tag">工具</span>
              <code>call {{ (m.toolCallId ?? '').slice(0, 8) }}</code>
              <span class="muted">{{ m.content.length }} 字符</span>
            </summary>
            <pre class="result">{{ m.content }}</pre>
          </details>
        </div>

        <!-- 助手消息（含工具调用则展示调用参数） -->
        <div v-else-if="m.role === 'assistant'" class="msg assistant">
          <div v-if="m.content" class="bubble md" v-html="md(m.content)"></div>
          <div v-for="(c, ci) in m.toolCalls ?? []" :key="ci" class="toolcall">
            <span class="tag">调用</span>
            <code>{{ c.name }}</code>
            <pre>{{ argsPretty(c.argsJson) }}</pre>
          </div>
        </div>
      </template>

      <!-- 流式中的助手输出 -->
      <div v-if="store.streamingText" class="msg assistant streaming">
        <div class="bubble md" v-html="md(store.streamingText)"></div>
        <span class="cursor">▍</span>
      </div>

      <div v-if="store.messages.length === 0 && !store.streamingText" class="empty">
        发送第一条消息开始对话
      </div>
    </div>

    <!-- 确认卡 -->
    <div v-if="store.pendingConfirm" class="card confirm">
      <div class="title">⚠ 需要确认：{{ store.pendingConfirm.tool }}</div>
      <div class="reason">{{ store.pendingConfirm.reason }}</div>
      <pre>{{ argsPretty(JSON.stringify(store.pendingConfirm.args)) }}</pre>
      <div class="actions">
        <button class="primary" @click="store.decideConfirm({ kind: 'allow' })">允许</button>
        <button class="danger" @click="store.decideConfirm({ kind: 'reject' })">拒绝</button>
      </div>
    </div>

    <!-- F-14 计划审批卡：可编辑 goal / 删除节点 / 调整依赖 -->
    <div v-if="store.pendingPlan" class="card plan">
      <div class="title">
        📋 计划审批（rev {{ store.pendingPlan.plan.revision }} · {{ store.pendingPlan.plan.nodes.length }} 节点）
      </div>
      <div class="plan-goal">总目标：{{ store.pendingPlan.plan.goal }}</div>
      <div v-for="(n, i) in store.pendingPlan.plan.nodes" :key="n.id" class="plan-node">
        <code class="nid">{{ n.id }}</code>
        <input class="goal" v-model="n.goal" placeholder="子任务目标" />
        <input
          class="deps"
          :value="n.deps.join(',')"
          placeholder="依赖（逗号分隔）"
          @change="n.deps = ($event.target as HTMLInputElement).value.split(',').map(s => s.trim()).filter(Boolean)"
        />
        <label class="crit"><input type="checkbox" v-model="n.critical" />critical</label>
        <button class="danger sm" @click="store.pendingPlan?.plan.nodes.splice(i, 1)">删除</button>
      </div>
      <div class="actions">
        <button class="primary" @click="store.decidePlan({ kind: 'edit' })">按此计划执行</button>
        <button class="danger" @click="store.decidePlan({ kind: 'reject' })">跳过计划（直接执行）</button>
      </div>
    </div>

    <!-- 提问卡 -->
    <div v-if="store.pendingAsk" class="card ask">
      <div class="title">❓ {{ store.pendingAsk.question }}</div>
      <div v-if="store.pendingAsk.options?.length" class="actions">
        <button v-for="o in store.pendingAsk.options" :key="o" @click="store.answerAsk(o)">{{ o }}</button>
      </div>
      <input
        :placeholder="'输入回答后回车'"
        @keyup.enter="store.answerAsk(($event.target as HTMLInputElement).value); ($event.target as HTMLInputElement).value = ''"
      />
    </div>

    <!-- 通知 -->
    <div v-if="store.notices.length" class="notices">
      <span v-for="n in store.notices" :key="n.id" class="notice">{{ n.text }}</span>
    </div>

    <!-- 输入区 -->
    <div class="inputbar">
      <textarea
        v-model="input"
        rows="2"
        :disabled="store.running"
        :placeholder="store.running ? 'Agent 运行中…' : '输入消息（Markdown 语法直接生效）'"
        @keydown.enter.exact.prevent="submit"
      ></textarea>
      <button v-if="store.running" class="danger" @click="store.abort()">中止</button>
      <button v-else class="primary" :disabled="!input.trim()" @click="submit">发送</button>
    </div>
  </div>
</template>

<style scoped>
.chat { display: flex; flex-direction: column; height: 100%; max-width: 920px; margin: 0 auto; }
.head { display: flex; align-items: center; gap: 10px; padding: 4px 2px; border-bottom: 1px solid #d0d7de; }
.head .title { font-weight: 600; font-size: 14px; }
.head .mode { background: #ddf4ff; color: #0969da; font-size: 12px; border-radius: 4px; padding: 1px 7px; }
.head .muted { color: #8b949e; font-size: 12px; }
.head .replay-link { margin-left: auto; font-size: 12px; color: #0969da; text-decoration: none; }
.msgs { flex: 1; overflow-y: auto; padding: 8px 4px; }
.msg { margin: 10px 0; }
.msg.user { display: flex; justify-content: flex-end; }
.msg.user .bubble { background: #1f883d; color: #fff; border-radius: 12px 12px 2px 12px; padding: 8px 12px; max-width: 75%; white-space: pre-wrap; }
.msg.assistant .bubble { background: #fff; border: 1px solid #d0d7de; border-radius: 12px 12px 12px 2px; padding: 10px 14px; max-width: 85%; }
.md :deep(p) { margin: 6px 0; }
.md :deep(pre) { background: #f6f8fa; padding: 10px; border-radius: 6px; overflow-x: auto; }
.md :deep(code) { font-size: 13px; }
.md :deep(table) { border-collapse: collapse; }
.md :deep(th), .md :deep(td) { border: 1px solid #d0d7de; padding: 4px 8px; }
.cursor { color: #1f883d; animation: blink 1s step-start infinite; }
@keyframes blink { 50% { opacity: 0; } }
.toolcall, .msg.tool { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; margin-top: 6px; padding: 8px 10px; font-size: 13px; }
.toolcall pre, pre.result { background: #f6f8fa; padding: 8px; border-radius: 6px; max-height: 220px; overflow: auto; margin: 6px 0 0; white-space: pre-wrap; }
.tag { background: #ddf4ff; color: #0969da; border-radius: 4px; padding: 1px 6px; font-size: 12px; margin-right: 6px; }
.muted { color: #8b949e; font-size: 12px; margin-left: 8px; }
summary { cursor: pointer; }
.card { background: #fff8c5; border: 1px solid #d4a72c; border-radius: 8px; padding: 10px 14px; margin: 8px 0; }
.card.ask { background: #ddf4ff; border-color: #0969da; }
.card.plan { background: #f0fff4; border-color: #1a7f37; }
.card.plan .plan-goal { font-size: 13px; color: #57606a; margin: 4px 0 8px; }
.plan-node { display: flex; align-items: center; gap: 8px; margin: 6px 0; flex-wrap: wrap; }
.plan-node .nid { background: #eaeef2; border-radius: 4px; padding: 2px 6px; font-size: 12px; min-width: 30px; }
.plan-node .goal { flex: 1; min-width: 220px; border: 1px solid #d0d7de; border-radius: 6px; padding: 4px 8px; }
.plan-node .deps { width: 150px; border: 1px solid #d0d7de; border-radius: 6px; padding: 4px 8px; font-size: 12px; }
.plan-node .crit { font-size: 12px; color: #57606a; display: flex; align-items: center; gap: 3px; }
.plan-node .sm { font-size: 12px; }
.card .title { font-weight: 600; }
.card .reason { font-size: 13px; color: #57606a; margin: 4px 0; }
.card pre { font-size: 12px; background: #f6f8fa; padding: 6px; border-radius: 6px; max-height: 150px; overflow: auto; }
.actions { display: flex; gap: 8px; margin: 8px 0; }
.notices { display: flex; flex-direction: column; gap: 2px; padding: 4px 0; }
.notice { font-size: 12px; color: #57606a; }
.inputbar { display: flex; gap: 8px; padding: 10px 0; }
.inputbar textarea { flex: 1; resize: none; font-family: inherit; font-size: 14px; padding: 10px; border: 1px solid #d0d7de; border-radius: 8px; }
.inputbar button { padding: 0 18px; border-radius: 8px; border: 1px solid #d0d7de; background: #fff; }
button.primary { background: #1f883d; color: #fff; border-color: #1f883d; }
button.danger { color: #cf222e; }
.empty { text-align: center; color: #8b949e; padding: 60px 0; }
input { padding: 8px 10px; border: 1px solid #d0d7de; border-radius: 6px; flex: 1; }
</style>
