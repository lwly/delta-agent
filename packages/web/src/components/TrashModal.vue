<script setup lang="ts">
// 回收站弹窗：项目/会话软删除条目的恢复与彻底清除（30 天后自动清除）
// 支持勾选 + 批量彻底删除（批量属危险操作，需 confirm 二次确认）
import { computed, onMounted, ref } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import ModalShell from './ModalShell.vue';

type TrashKind = 'project' | 'session';

const emit = defineEmits<{ close: [] }>();
const store = useWorkspaceStore();
const error = ref('');
/** 勾选状态（key = kind:id），批量清除成功后清空 */
const selected = ref(new Set<string>());
const batchRunning = ref(false);

const keyOf = (kind: string, id: string): string => `${kind}:${id}`;
const allSelected = computed(
  () => store.trash.length > 0 && store.trash.every((t) => selected.value.has(keyOf(t.kind, t.id))),
);
const selectedItems = computed(() =>
  store.trash
    .filter((t) => selected.value.has(keyOf(t.kind, t.id)))
    .map((t) => ({ kind: t.kind as TrashKind, id: t.id })),
);

function toggle(kind: TrashKind, id: string): void {
  const k = keyOf(kind, id);
  const next = new Set(selected.value);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  selected.value = next;
}
function toggleAll(): void {
  selected.value = allSelected.value ? new Set<string>() : new Set(store.trash.map((t) => keyOf(t.kind, t.id)));
}

onMounted(() => store.refreshTrash().catch((e) => (error.value = (e as Error).message)));

async function restore(kind: TrashKind, id: string) {
  error.value = '';
  try {
    await store.restore(kind, id);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function purge(kind: TrashKind, id: string) {
  error.value = '';
  try {
    await store.purge(kind, id);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function purgeBatch() {
  const items = selectedItems.value;
  if (items.length === 0) return;
  if (!window.confirm(`将不可恢复地彻底删除选中的 ${items.length} 条条目，确定继续？`)) return;
  error.value = '';
  batchRunning.value = true;
  try {
    await store.purgeBatch(items);
    selected.value = new Set<string>();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    batchRunning.value = false;
  }
}
</script>

<template>
  <ModalShell title="回收站" icon="🗑" :width="560" @close="emit('close')">
    <p class="sub">软删除的项目与会话，30 天后自动清除</p>
    <p v-if="error" class="error">✘ {{ error }}</p>
    <div class="toolbar">
      <label class="checkall">
        <input
          type="checkbox"
          :checked="allSelected"
          :disabled="store.trash.length === 0"
          @change="toggleAll"
        />
        全选
      </label>
      <button
        class="op del"
        :disabled="selectedItems.length === 0 || batchRunning"
        @click="purgeBatch"
      >
        批量彻底删除{{ selectedItems.length ? `（${selectedItems.length}）` : '' }}
      </button>
    </div>
    <div v-if="store.trash.length === 0" class="empty">（空）</div>
    <div v-for="t in store.trash" :key="t.kind + t.id" class="row">
      <input
        type="checkbox"
        class="pick"
        :checked="selected.has(keyOf(t.kind, t.id))"
        @change="toggle(t.kind, t.id)"
      />
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
.toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.checkall { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-dim); cursor: pointer; user-select: none; }
.checkall input, .pick { cursor: pointer; accent-color: var(--accent); }
.checkall input:disabled { cursor: not-allowed; }
.pick { flex-shrink: 0; }
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
.op:disabled { opacity: 0.45; cursor: not-allowed; }
.op.del { color: var(--red); }
.op.del:hover { background: var(--red-soft); }
</style>
