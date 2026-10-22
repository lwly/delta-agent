<script setup lang="ts">
// 记忆面板（F-06a）：L2 动态记忆管理 —— 列表/编辑/停用/回收站/待确认队列/召回预览
import { computed, onMounted, ref } from 'vue';
import { api, type MemoryItem } from '../api/client';

interface MemoryRow extends MemoryItem {
  editing?: boolean;
}

const items = ref<MemoryRow[]>([]);
const pending = ref<MemoryRow[]>([]);
const trash = ref<MemoryRow[]>([]);
const usage = ref<{ count: number; tokens: number } | undefined>();
const scopeFilter = ref('');
const kindFilter = ref('');
const loading = ref(false);
const error = ref('');

const previewQuery = ref('');
const previewHits = ref<MemoryItem[]>([]);

const KINDS = ['preference', 'fact', 'decision', 'pitfall', 'workflow'];

const shown = computed(() =>
  items.value.filter(
    (m) =>
      (!kindFilter.value || m.kind === kindFilter.value) &&
      (!scopeFilter.value || m.scope === scopeFilter.value),
  ),
);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [list, pend, trashList] = await Promise.all([
      api.listMemory(undefined, undefined, 'confirmed'),
      api.listMemory(undefined, undefined, 'pending'),
      api.listMemoryTrash(),
    ]);
    items.value = list.items;
    usage.value = list.usage;
    pending.value = pend.items;
    trash.value = trashList;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

async function toggleDisable(m: MemoryRow) {
  await api.removeMemory(m.id);
  await load();
}

async function restore(m: MemoryRow) {
  await api.restoreMemory(m.id);
  await load();
}

async function approve(m: MemoryRow) {
  await api.approveMemory(m.id);
  await load();
}

async function reject(m: MemoryRow) {
  await api.rejectMemory(m.id);
  await load();
}

async function bumpImportance(m: MemoryRow, v: number) {
  await api.updateMemory(m.id, { importance: Math.max(0, Math.min(1, m.importance + v)) });
  await load();
}

async function saveEdit(m: MemoryRow) {
  await api.updateMemory(m.id, { content: m.content, kind: m.kind });
  m.editing = false;
  await load();
}

async function runPreview() {
  if (!previewQuery.value.trim()) return;
  previewHits.value = await api.previewRecall(previewQuery.value, ['global']);
}

onMounted(load);
</script>

<template>
  <div class="page">
    <h2>记忆面板</h2>
    <p class="sub">
      L2 长期动态记忆（用户私有 / 项目隔离）。共 {{ usage?.count ?? 0 }} 条 ·
      约 {{ usage?.tokens ?? 0 }} tokens · 配额 512 条
    </p>
    <p v-if="error" class="error">✘ {{ error }}</p>

    <!-- 待确认队列（自动提炼候选） -->
    <section v-if="pending.length > 0" class="card pending">
      <h3>待确认（自动提炼 {{ pending.length }} 条）</h3>
      <div v-for="m in pending" :key="m.id" class="row">
        <span class="kind">{{ m.kind }}</span>
        <span class="content">{{ m.content }}</span>
        <span class="actions">
          <button class="btn ok" @click="approve(m)">采纳</button>
          <button class="btn" @click="reject(m)">拒绝</button>
        </span>
      </div>
    </section>

    <!-- 过滤 -->
    <div class="filters">
      <select v-model="kindFilter">
        <option value="">全部类型</option>
        <option v-for="k in KINDS" :key="k" :value="k">{{ k }}</option>
      </select>
      <input v-model="scopeFilter" placeholder="scope（如 project:<id> / global）" />
      <button class="btn" @click="load">刷新</button>
    </div>

    <!-- 记忆列表 -->
    <section class="card">
      <div v-if="shown.length === 0 && !loading" class="empty">（暂无记忆条目）</div>
      <div v-for="m in shown" :key="m.id" class="row">
        <template v-if="!m.editing">
          <span class="kind">{{ m.kind }}</span>
          <span class="content" :class="{ superseded: m.superseded_by }">{{ m.content }}</span>
          <span class="meta">imp {{ m.importance.toFixed(2) }} · conf {{ m.confidence.toFixed(2) }} · 召回 {{ m.access_count }} 次</span>
          <span class="actions">
            <button class="btn" @click="bumpImportance(m, 0.1)">↑ 重要</button>
            <button class="btn" @click="m.editing = true">编辑</button>
            <button class="btn warn" @click="toggleDisable(m)">停用</button>
          </span>
        </template>
        <template v-else>
          <select v-model="m.kind" class="kind-select">
            <option v-for="k in KINDS" :key="k" :value="k">{{ k }}</option>
          </select>
          <input v-model="m.content" class="content-input" />
          <span class="actions">
            <button class="btn ok" @click="saveEdit(m)">保存</button>
            <button class="btn" @click="m.editing = false">取消</button>
          </span>
        </template>
      </div>
    </section>

    <!-- 召回预览 -->
    <section class="card">
      <h3>召回预览</h3>
      <div class="filters">
        <input v-model="previewQuery" placeholder="输入查询，预览评分召回（阈值 0.25，Top-10）" @keyup.enter="runPreview" />
        <button class="btn" @click="runPreview">预览</button>
      </div>
      <div v-for="h in previewHits" :key="h.id" class="row">
        <span class="kind">score {{ h.score?.toFixed(2) }}</span>
        <span class="content">{{ h.content }}</span>
      </div>
      <p v-if="previewQuery && previewHits.length === 0" class="empty">（无命中）</p>
    </section>

    <!-- 回收站 -->
    <section v-if="trash.length > 0" class="card">
      <h3>回收站（30 天后清除）</h3>
      <div v-for="m in trash" :key="m.id" class="row">
        <span class="kind">{{ m.kind }}</span>
        <span class="content">{{ m.content }}</span>
        <span class="actions"><button class="btn" @click="restore(m)">恢复</button></span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page { color: #c9d1d9; padding: 24px 32px; }
h2 { color: #e6edf3; margin-bottom: 4px; }
.sub { color: #8b949e; font-size: 13px; margin-top: 0; }
.error { color: #f85149; }
.card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px 16px; margin: 16px 0; }
.card.pending { border-color: #d29922; }
.row { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid #21262d; flex-wrap: wrap; }
.kind { color: #58a6ff; font-size: 12px; min-width: 76px; }
.content { flex: 1; min-width: 200px; }
.content.superseded { color: #8b949e; text-decoration: line-through; }
.meta { color: #8b949e; font-size: 12px; }
.actions { display: flex; gap: 6px; }
.btn { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 2px 10px; cursor: pointer; font-size: 12px; }
.btn.ok { border-color: #238636; color: #3fb950; }
.btn.warn { border-color: #da3633; color: #f85149; }
.filters { display: flex; gap: 8px; margin: 10px 0; }
.filters input, .filters select { background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 4px 8px; }
.filters input { flex: 1; }
.empty { color: #8b949e; text-align: center; padding: 18px; }
.content-input { flex: 1; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 4px 8px; }
.kind-select { background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; }
</style>
