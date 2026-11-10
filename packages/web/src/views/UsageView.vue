<script setup lang="ts">
// F-31 用量页（工作台子路由 /usage）：侧栏 rail 一级入口，主体复用 UsagePanel。
import UsagePanel from '../components/settings/UsagePanel.vue';
</script>

<template>
  <div class="page">
    <div class="head">
      <h2>用量</h2>
      <router-link class="btn" to="/">← 工作台</router-link>
    </div>
    <UsagePanel />
  </div>
</template>

<style scoped>
.page {
  color: var(--text);
  padding: 16px 24px 24px;
  max-width: 1320px;
  margin: 0 auto;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 4px; }
h2 { margin: 0; font-size: 13px; font-weight: 600; }
.btn {
  height: 28px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-elevated); color: var(--text-dim); font-size: 12px; cursor: pointer;
  text-decoration: none; display: inline-flex; align-items: center;
  transition: background 0.12s ease-out, color 0.12s ease-out, border-color 0.12s ease-out;
}
.btn:hover { background: var(--bg-elevated-2); color: var(--text); border-color: var(--border-strong); }
</style>
