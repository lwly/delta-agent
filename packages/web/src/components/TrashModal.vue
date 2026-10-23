<script setup lang="ts">
// 回收站弹窗：项目/会话软删除条目的恢复与彻底清除（30 天后自动清除）
import { onMounted, ref } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import ModalShell from './ModalShell.vue';

const emit = defineEmits<{ close: [] }>();
const store = useWorkspaceStore();
const error = ref('');

onMounted(() => store.refreshTrash().catch((e) => (error.value = (e as Error).message)));

async function restore(kind: 'project' | 'session', id: string) {
  error.value = '';
  try {
    await store.restore(kind, id);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function purge(kind: 'project' | 'session', id: string) {
  error.value = '';
  try {
    await store.purge(kind, id);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
</script>

<template>
  <ModalShell title="回收站" icon="🗑" :width="560" @close="emit('close')">
    <p class="sub">软删除的项目与会话，30 天后自动清除</p>
    <p v-if="error" class="error">✘ {{ error }}</p>
    <div v-if="store.trash.length === 0" class="empty">（空）</div>
    <div v-for="t in store.trash" :key="t.kind + t.id" class="row">
      <span class="kind" :class="t.kind">{{ t.kind === 'project' ? '项目' : '会话' }}</span>
      <span class="info">
        <span class="name">{{ t.name }}</span>
        <span class="meta">{{ new Date(t.deleted_at).toLocaleString('zh-CN') }}</span>
      </span>
      <span class="ops">
        <button class="op" @click="restore(t.kind, t.id)">恢复</button>
        <button class="op del" @click="purge(t.kind, t.id)">彻底清除</button>
      </span>
    </div>
  </ModalShell>
</template>

<style scoped>
.sub { color: var(--text-dim); font-size: 12px; margin-bottom: 10px; }
.error { color: var(--red); font-size: 13px; margin-bottom: 8px; }
.empty { color: var(--text-faint); text-align: center; padding: 20px; font-size: 12.5px; }
.row {
  display: flex; align-items: center; gap: 11px;
  background: var(--bg-panel); border: 1px solid var(--border);
  border-radius: 10px; padding: 10px 13px; margin-bottom: 8px;
}
.kind { font-size: 10px; font-family: var(--mono); padding: 2px 7px; border-radius: 4px; flex-shrink: 0; }
.kind.project { background: var(--accent-soft); color: var(--accent); }
.kind.session { background: var(--purple-soft); color: var(--purple); }
.info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.name { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { font-size: 10.5px; color: var(--text-faint); font-family: var(--mono); }
.ops { display: flex; gap: 6px; flex-shrink: 0; }
.op {
  padding: 3px 10px; border-radius: 6px; border: 1px solid var(--border);
  background: transparent; color: var(--text-dim); font-size: 11.5px; cursor: pointer;
}
.op:hover { background: var(--bg-hover); color: var(--text); }
.op.del { color: var(--red); }
.op.del:hover { background: var(--red-soft); }
</style>
