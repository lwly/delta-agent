<script setup lang="ts">
// 设置页·功能面板：列出系统集成的全部 Function（内置工具 + 已接入 MCP 工具）。
// 只读清单：名称 / 描述 / 危险级徽标；支持关键字过滤。
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api/client';

type ToolRow = { name: string; description: string; danger: 'safe' | 'confirm' };

const items = ref<ToolRow[]>([]);
const loading = ref(false);
const error = ref('');
const keyword = ref('');

const BUILTIN_NAMES = new Set([
  'read_file', 'write_file', 'edit_file', 'list_dir', 'glob_search', 'grep_search',
  'run_command', 'run_tests', 'web_fetch', 'todo_write', 'ask_user',
  'load_skill', 'unload_skill', 'save_memory', 'recall_memory', 'task',
]);

const shown = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return items.value;
  return items.value.filter((t) => t.name.toLowerCase().includes(kw) || t.description.toLowerCase().includes(kw));
});

const source = (t: ToolRow): string => (BUILTIN_NAMES.has(t.name) ? '内置' : 'MCP/扩展');
const dangerLabel = (d: ToolRow['danger']): string => (d === 'confirm' ? '执行前确认' : '直接执行');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    items.value = (await api.toolList()).items;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>

<template>
  <section class="block">
    <h4>系统集成 Function（{{ items.length }}）</h4>
    <p class="meta">Agent 可用的全部工具：内置只读清单 + MCP 动态接入。「执行前确认」工具每次调用都会弹出确认卡。</p>
    <div class="filters">
      <input v-model="keyword" placeholder="按名称或描述过滤…" />
      <button class="btn" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
    </div>
    <p v-if="error" class="error">✘ {{ error }}</p>
    <div v-if="!error && shown.length === 0" class="empty">（无匹配工具）</div>
    <div v-for="t in shown" :key="t.name" class="row">
      <span class="tool-name">{{ t.name }}</span>
      <span class="body-col">
        <span class="desc">{{ t.description }}</span>
      </span>
      <span class="badges">
        <span class="badge src">{{ source(t) }}</span>
        <span class="badge" :class="t.danger === 'confirm' ? 'confirm' : 'safe'">{{ dangerLabel(t.danger) }}</span>
      </span>
    </div>
  </section>
</template>

<style scoped>
.block {
  background: var(--bg-panel); border: 1px solid var(--border);
  border-radius: 10px; padding: 12px 14px; margin-bottom: 14px;
}
h4 { font-size: 13.5px; margin-bottom: 6px; }
.meta { font-size: 11.5px; color: var(--text-faint); margin-bottom: 10px; }
.filters { display: flex; gap: 8px; margin: 8px 0 10px; }
.filters input { flex: 1; min-width: 0; padding: 6px 9px; }
.btn {
  padding: 5px 14px; border-radius: 7px; border: 1px solid var(--border);
  background: transparent; color: var(--text-dim); font-size: 12.5px; cursor: pointer;
}
.btn:hover { background: var(--bg-hover); color: var(--text); }
.error { color: var(--red); font-size: 13px; margin-bottom: 8px; }
.empty { color: var(--text-faint); text-align: center; padding: 16px; font-size: 12.5px; }
.row {
  display: flex; align-items: flex-start; gap: 11px;
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: 10px; padding: 10px 13px; margin-bottom: 8px;
}
.tool-name {
  flex: none; width: 130px; font-family: var(--mono); font-size: 12px;
  color: var(--accent); word-break: break-all;
}
.body-col { flex: 1; min-width: 0; }
.desc { font-size: 12px; line-height: 1.6; color: var(--text-dim); }
.badges { display: flex; flex-direction: column; gap: 4px; align-items: flex-end; flex-shrink: 0; }
.badge {
  font-size: 10.5px; padding: 2px 8px; border-radius: 999px; white-space: nowrap;
  border: 1px solid var(--border); color: var(--text-faint);
}
.badge.src { background: var(--bg-hover); }
.badge.safe { color: var(--green); border-color: rgba(63, 185, 80, 0.4); }
.badge.confirm { color: var(--orange); border-color: rgba(210, 153, 34, 0.45); }
</style>
