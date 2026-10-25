<script setup lang="ts">
// 检索弹窗（F-17）：会话标题命中 + 历史消息命中（全文/语义混合），点击命中跳转会话
import { ref } from 'vue';
import { api, type MessageHit, type SessionRow } from '../api/client';
import ModalShell from './ModalShell.vue';

const emit = defineEmits<{ close: []; openSession: [sessionId: string] }>();

const q = ref('');
const sessionHits = ref<SessionRow[]>([]);
const messageHits = ref<MessageHit[]>([]);
const searched = ref(false);
const error = ref('');

const VIA_LABEL: Record<string, string> = { fulltext: '全文', semantic: '语义', hybrid: '混合' };
const ROLE_LABEL: Record<string, string> = { user: '用户', assistant: '助手' };

async function run() {
  const query = q.value.trim();
  if (!query) return;
  error.value = '';
  try {
    const [sessions, messages] = await Promise.all([
      api.search(query),
      api.searchMessages(query).catch(() => [] as MessageHit[]),
    ]);
    sessionHits.value = sessions;
    messageHits.value = messages;
    searched.value = true;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function open(sessionId: string) {
  emit('openSession', sessionId);
  emit('close');
}
</script>

<template>
  <ModalShell title="检索会话与消息" icon="🔍" :width="620" @close="emit('close')">
    <div class="searchbar">
      <input
        v-model="q"
        placeholder="搜索对话标题 / 历史消息（全文 + 语义），回车检索"
        autofocus
        @keyup.enter="run"
      />
      <button class="btn primary" @click="run">搜索</button>
    </div>
    <p v-if="error" class="error">✘ {{ error }}</p>

    <template v-if="searched">
      <!-- 搜索空态：有输入但无命中时的引导 -->
      <div v-if="sessionHits.length === 0 && messageHits.length === 0" class="empty">
        <div class="empty-ico">🔍</div>
        <div class="empty-text">未找到相关会话</div>
        <div class="empty-hint">换个关键词试试，或检查项目是否已注册</div>
      </div>

      <template v-if="sessionHits.length">
        <div class="group-title">会话命中（{{ sessionHits.length }}）</div>
        <div v-for="r in sessionHits" :key="r.id" class="row" @click="open(r.id)">
          <span class="kind">会话</span>
          <span class="content">{{ r.title }}</span>
        </div>
      </template>

      <template v-if="messageHits.length">
        <div class="group-title">消息命中（{{ messageHits.length }}）</div>
        <div v-for="h in messageHits" :key="h.messageId" class="row" @click="open(h.sessionId)">
          <span class="kind msg">{{ ROLE_LABEL[h.role] || h.role }}</span>
          <span class="info">
            <span class="title">{{ h.sessionTitle }} · {{ VIA_LABEL[h.via] }}命中 · score {{ h.score.toFixed(2) }}</span>
            <span class="snippet">{{ h.snippet }}</span>
          </span>
        </div>
      </template>
    </template>
  </ModalShell>
</template>

<style scoped>
.searchbar { display: flex; gap: 8px; margin-bottom: 10px; }
.searchbar input { flex: 1; }
.error { color: var(--red); font-size: 13px; margin-bottom: 8px; }
.empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 28px 20px; }
.empty-ico { font-size: 24px; opacity: 0.6; }
.empty-text { color: var(--text-dim); font-size: 13px; font-weight: 500; }
.empty-hint { color: var(--text-faint); font-size: 11.5px; }
.group-title { font-size: 12px; color: var(--text-dim); font-weight: 600; margin: 10px 0 6px; }
.row {
  display: flex; align-items: flex-start; gap: 10px;
  background: var(--bg-panel); border: 1px solid var(--border);
  border-radius: 10px; padding: 9px 13px; margin-bottom: 6px; cursor: pointer;
  transition: all 0.15s;
}
.row:hover { background: var(--bg-hover); border-color: var(--accent-border); }
.row:active { background: var(--bg-active); }
.kind {
  font-size: 10px; font-family: var(--mono); padding: 2px 7px; border-radius: 4px;
  background: var(--accent-soft); color: var(--accent); flex-shrink: 0; margin-top: 1px;
}
.kind.msg { background: var(--bg-elevated); color: var(--text-dim); border: 1px solid var(--border); }
.content { font-size: 12.5px; }
.info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.title { font-size: 12px; color: var(--text-dim); }
.snippet { font-size: 12px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
