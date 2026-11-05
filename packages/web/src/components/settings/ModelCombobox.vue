<script setup lang="ts">
// 外部 Agent「模型」组合框（F-56 增补样式优化）：
// 替换原生 <datalist>（原生下拉不可定制、暗色主题下样式割裂）。
// 行为：聚焦展开候选 → 输入即过滤（子串匹配）→ 点击选中；候选中等值项标「当前」；
// 自由输入不受限（清单是建议不是校验）；Esc/点外部关闭；加载态在面板内提示。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    /** v-model：当前输入/选中值（空串 = 用 CLI 默认模型） */
    modelValue: string;
    /** 候选模型清单（动态探测 + 静态合并后的结果） */
    options: string[];
    /** 候选加载中（下拉内提示，不弹错误） */
    loading?: boolean;
    /** 原生 input id（label for 关联） */
    inputId?: string;
    placeholder?: string;
  }>(),
  { loading: false, inputId: undefined, placeholder: '留空 = 恢复 CLI 默认模型' },
);

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const open = ref(false);
const root = ref<HTMLDivElement | null>(null);

/** 过滤：输入非空时按子串匹配（大小写不敏感）；空 = 全量候选 */
const filtered = computed(() => {
  const q = props.modelValue.trim().toLowerCase();
  if (q === '') return props.options;
  return props.options.filter((m) => m.toLowerCase().includes(q));
});

function select(m: string) {
  emit('update:modelValue', m);
  open.value = false;
}

function onInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).value);
  open.value = true;
}

function onOutside(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false;
}
onMounted(() => document.addEventListener('mousedown', onOutside));
onBeforeUnmount(() => document.removeEventListener('mousedown', onOutside));
</script>

<template>
  <div ref="root" class="cb">
    <input
      :id="inputId"
      class="cb-input mono"
      type="text"
      :value="modelValue"
      :placeholder="placeholder"
      maxlength="100"
      autocomplete="off"
      @focus="open = true"
      @input="onInput"
      @keydown.esc="open = false"
    />
    <div v-if="open" class="cb-panel">
      <p v-if="loading" class="cb-hint-row">正在自动获取模型清单…</p>
      <template v-else-if="filtered.length > 0">
        <button
          v-for="m in filtered"
          :key="m"
          type="button"
          class="cb-opt"
          :class="{ cur: m === modelValue.trim() }"
          @mousedown.prevent="select(m)"
        >
          <code class="mono cb-opt-id">{{ m }}</code>
          <span v-if="m === modelValue.trim()" class="cb-cur">✓ 当前</span>
        </button>
      </template>
      <p v-else class="cb-hint-row">无匹配候选——直接输入任意模型 ID 即可使用</p>
    </div>
  </div>
</template>

<style scoped>
.cb { position: relative; }
.cb-input {
  width: 100%;
  border: 1px solid var(--border); border-radius: 8px; background: var(--bg);
  color: var(--text); padding: 7px 10px; font-size: 12.5px;
}
.cb-input:focus { outline: none; border-color: var(--accent); }
.mono { font-family: var(--mono); }

.cb-panel {
  position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 30;
  background: var(--bg-elevated); border: 1px solid var(--border-strong);
  border-radius: 10px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  max-height: 240px; overflow-y: auto; padding: 4px;
}
.cb-opt {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  width: 100%; text-align: left;
  background: transparent; border: 0; border-radius: 6px;
  color: var(--text); padding: 7px 10px; cursor: pointer; font-size: 12px;
}
.cb-opt:hover { background: var(--bg-hover); }
.cb-opt.cur { color: var(--accent); }
.cb-opt-id { font-size: 12px; }
.cb-cur { font-size: 10px; color: var(--accent); flex-shrink: 0; }
.cb-hint-row { font-size: 11.5px; color: var(--text-faint); padding: 8px 10px; margin: 0; }
</style>
