<script setup lang="ts">
// 设置页·记忆面板（F-06a 内容区）：L2 动态记忆管理 —— 全部/待确认/回收站三个 tab + 召回预览
// 从 MemoryModal 抽取主体内容，弹窗壳保留在 MemoryModal.vue 中复用
import { computed, onMounted, ref } from 'vue';
import { api, type MemoryItem } from '../../api/client';

interface MemoryRow extends MemoryItem {
  editing?: boolean;
}

const tab = ref<'all' | 'pending' | 'trash'>('all');
const items = ref<MemoryRow[]>([]);
const pending = ref<MemoryRow[]>([]);
const trash = ref<MemoryRow[]>([]);
const usage = ref<{ count: number; tokens: number } | undefined>();
const scopeFilter = ref('');
const kindFilter = ref('');
const error = ref('');

const previewQuery = ref('');
const previewHits = ref<MemoryItem[]>([]);

/** 记忆类型枚举：value 为后端存储值，label 为界面中文显示名 */
const KINDS = [
  { value: 'preference', label: '偏好' },
  { value: 'fact', label: '事实' },
  { value: 'decision', label: '决策' },
  { value: 'pitfall', label: '避坑' },
  { value: 'workflow', label: '工作流' },
];
/** 类型枚举 → 中文名（未匹配时原样返回） */
function kindLabel(kind: string): string {
  return KINDS.find((k) => k.value === kind)?.label ?? kind;
}

const shown = computed(() =>
  items.value.filter(
    (m) =>
      (!kindFilter.value || m.kind === kindFilter.value) &&
      (!scopeFilter.value || m.scope === scopeFilter.value),
  ),
);

async function load() {
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
  }
}
onMounted(load);

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
</script>

<template>
  <div class="tabs">
    <button class="tab" :class="{ on: tab === 'all' }" @click="tab = 'all'">全部<span class="n">{{ items.length }}</span></button>
    <button class="tab" :class="{ on: tab === 'pending' }" @click="tab = 'pending'">待确认<span class="n">{{ pending.length }}</span></button>
    <button class="tab" :class="{ on: tab === 'trash' }" @click="tab = 'trash'">回收站<span class="n">{{ trash.length }}</span></button>
  </div>

  <p v-if="error" class="error">✘ {{ error }}</p>
  <p class="quota-line">
    共 {{ usage?.count ?? 0 }} 条 · 约 {{ usage?.tokens ?? 0 }} tokens · 配额 512 条
  </p>

  <!-- 全部 -->
  <template v-if="tab === 'all'">
    <div class="filters">
      <select v-model="kindFilter">
        <option value="">全部类型</option>
        <option v-for="k in KINDS" :key="k.value" :value="k.value">{{ k.label }}</option>
      </select>
      <input v-model="scopeFilter" placeholder="scope（如 project:<id> / global）" />
      <button class="btn" @click="load">刷新</button>
    </div>
    <div v-if="shown.length === 0" class="empty">（暂无记忆条目）</div>
    <div v-for="m in shown" :key="m.id" class="row">
      <template v-if="!m.editing">
        <span class="mem-kind" :class="m.kind">{{ kindLabel(m.kind) }}</span>
        <span class="body-col">
          <span class="content" :class="{ superseded: m.superseded_by }">{{ m.content }}</span>
          <span class="stats">imp {{ m.importance.toFixed(2) }} · conf {{ m.confidence.toFixed(2) }} · 召回 {{ m.access_count }} 次</span>
        </span>
        <span class="ops">
          <button class="op" @click="bumpImportance(m, 0.1)">↑ 重要</button>
          <button class="op" @click="m.editing = true">编辑</button>
          <button class="op warn" @click="toggleDisable(m)">停用</button>
        </span>
      </template>
      <template v-else>
        <select v-model="m.kind" class="kind-select">
          <option v-for="k in KINDS" :key="k.value" :value="k.value">{{ k.label }}</option>
        </select>
        <input v-model="m.content" class="content-input" />
        <span class="ops">
          <button class="op ok" @click="saveEdit(m)">保存</button>
          <button class="op" @click="m.editing = false">取消</button>
        </span>
      </template>
    </div>

    <div class="recall">
      <div class="recall-head">召回预览</div>
      <div class="filters">
        <input v-model="previewQuery" placeholder="输入查询，预览评分召回（阈值 0.25，Top-10）" @keyup.enter="runPreview" />
        <button class="btn" @click="runPreview">预览</button>
      </div>
      <div v-for="h in previewHits" :key="h.id" class="row">
        <span class="mem-kind fact">score {{ h.score?.toFixed(2) }}</span>
        <span class="body-col"><span class="content">{{ h.content }}</span></span>
      </div>
      <p v-if="previewQuery && previewHits.length === 0" class="empty">（无命中）</p>
    </div>
  </template>

  <!-- 待确认 -->
  <template v-else-if="tab === 'pending'">
    <div v-if="pending.length === 0" class="empty">（没有待确认的自动提炼候选）</div>
    <div v-for="m in pending" :key="m.id" class="row pending">
      <span class="mem-kind" :class="m.kind">{{ kindLabel(m.kind) }}</span>
      <span class="body-col"><span class="content">{{ m.content }}</span></span>
      <span class="ops">
        <button class="op ok" @click="approve(m)">采纳</button>
        <button class="op" @click="reject(m)">拒绝</button>
      </span>
    </div>
  </template>

  <!-- 回收站 -->
  <template v-else>
    <div v-if="trash.length === 0" class="empty">（回收站为空，30 天后自动清除）</div>
    <div v-for="m in trash" :key="m.id" class="row">
      <span class="mem-kind" :class="m.kind">{{ kindLabel(m.kind) }}</span>
      <span class="body-col"><span class="content superseded">{{ m.content }}</span></span>
      <span class="ops"><button class="op" @click="restore(m)">恢复</button></span>
    </div>
  </template>
</template>

<style scoped>
.tabs { display: flex; gap: 6px; margin: 8px 0 10px; }
.tab {
  padding: 5px 14px; border-radius: 7px; border: 1px solid var(--border);
  background: transparent; color: var(--text-dim); font-size: 12.5px; cursor: pointer;
}
.tab.on { background: var(--accent-soft); border-color: rgba(88, 166, 255, 0.4); color: var(--accent); font-weight: 600; }
.tab .n { font-family: var(--mono); font-size: 10.5px; opacity: 0.8; margin-left: 3px; }
.quota-line { font-size: 11px; color: var(--text-faint); font-family: var(--mono); margin-bottom: 10px; }
.error { color: var(--red); font-size: 13px; margin-bottom: 8px; }
.filters { display: flex; gap: 8px; margin: 8px 0; }
.filters input, .filters select { flex: 1; min-width: 0; padding: 6px 9px; }
.row {
  display: flex; align-items: flex-start; gap: 11px;
  background: var(--bg-panel); border: 1px solid var(--border);
  border-radius: 10px; padding: 10px 13px; margin-bottom: 8px;
}
.row.pending { border-color: rgba(210, 153, 34, 0.4); background: var(--orange-soft); }
.body-col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.content { font-size: 12.5px; line-height: 1.6; color: var(--text); }
.content.superseded { text-decoration: line-through; color: var(--text-faint); }
.stats { font-size: 10.5px; color: var(--text-faint); font-family: var(--mono); }
.ops { display: flex; gap: 6px; flex-shrink: 0; flex-wrap: wrap; }
.op {
  padding: 3px 10px; border-radius: 6px; border: 1px solid var(--border);
  background: transparent; color: var(--text-dim); font-size: 11.5px; cursor: pointer;
}
.op:hover { background: var(--bg-hover); color: var(--text); }
.op.ok { color: var(--green); border-color: rgba(63, 185, 80, 0.4); }
.op.warn { color: var(--red); border-color: rgba(248, 81, 73, 0.4); }
.kind-select { padding: 4px 8px; font-size: 12px; }
.content-input { flex: 1; min-width: 0; padding: 5px 9px; font-size: 12.5px; }
.recall { margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--border); }
.recall-head { font-size: 13px; font-weight: 600; color: var(--text-dim); margin-bottom: 4px; }
.empty { color: var(--text-faint); text-align: center; padding: 16px; font-size: 12.5px; }
</style>
