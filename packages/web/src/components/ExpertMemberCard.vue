<script setup lang="ts">
// F-39 专家团成员卡：48px 行 + 状态徽标（running 脉冲 / ok / failed / canceled / 只读降级）
// 数据源 = chat.delegations（实时 SSE；不落库，回放由 tool 消息 content 的 [expert:<id>] 前缀渲染角标）。
defineProps<{
  card: {
    memberId: string;
    memberName: string;
    profession: string;
    role: 'lead' | 'member';
    goal: string;
    status: 'running' | 'ok' | 'failed' | 'canceled';
    startedAt: number;
    ms?: number;
    summary?: string;
    readonlyDegraded?: boolean;
  };
}>();

import { ref } from 'vue';
const expanded = ref(false);
const STATUS_LABEL: Record<string, string> = { running: '运行中', ok: '完成', failed: '失败', canceled: '已取消' };
</script>

<template>
  <div class="member-card" :class="card.status">
    <div class="row">
      <span class="pulse" />
      <span class="name">{{ card.memberName }}</span>
      <span class="prof">{{ card.profession }}</span>
      <span v-if="card.role === 'lead'" class="lead-badge">主理人</span>
      <span class="spacer" />
      <span v-if="card.readonlyDegraded" class="ro" title="父会话为 plan 模式，成员自动只读降级">只读降级</span>
      <span v-if="card.status === 'running'" class="status running">{{ STATUS_LABEL[card.status] }}</span>
      <span v-else class="status" :class="card.status">
        {{ STATUS_LABEL[card.status] }}<template v-if="card.ms !== undefined"> · {{ (card.ms / 1000).toFixed(1) }}s</template>
      </span>
    </div>
    <div class="goal">{{ card.goal }}</div>
    <div
      v-if="card.summary"
      class="summary"
      :class="{ clamp: !expanded }"
      @click="expanded = !expanded"
    >{{ card.summary }}</div>
  </div>
</template>

<style scoped>
.member-card {
  border: 1px solid var(--border); border-radius: 10px;
  padding: 8px 12px; margin: 4px 0; font-size: 12px;
  background: var(--bg-panel);
}
.member-card.running .pulse {
  width: 8px; height: 8px; border-radius: 50%; background: var(--accent, #4a9eff);
  animation: mc-pulse 1.2s ease-in-out infinite;
}
@keyframes mc-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
.member-card:not(.running) .pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--border); }
.member-card.failed .pulse { background: var(--red, #f85149); }
.member-card.canceled .pulse { background: var(--orange, #d29922); }
.row { display: flex; align-items: center; gap: 8px; }
.name { font-weight: 600; }
.prof { color: var(--text-dim); }
.lead-badge { font-size: 11px; color: var(--accent, #4a9eff); }
.spacer { flex: 1; }
.ro { font-size: 11px; color: var(--orange, #d29922); border: 1px solid var(--orange, #d29922); border-radius: 6px; padding: 0 6px; }
.status { color: var(--text-dim); }
.status.failed { color: var(--red, #f85149); }
.status.canceled { color: var(--orange, #d29922); }
.goal { margin-top: 4px; color: var(--text-dim); }
.summary { margin-top: 4px; color: var(--text); white-space: pre-wrap; }
.summary.clamp {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; cursor: pointer;
}
</style>
