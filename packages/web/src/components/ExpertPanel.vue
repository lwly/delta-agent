<script setup lang="ts">
// F-39 召唤面板：二级面板（入口解耦契约 §6.8.1）
// 红线：不做数据 fetching、不新建会话、不调 api.*、不写 chat store、不引 ModalShell / router。
// 触发方（WorkbenchView）负责 load 数据、处理 @select（新建会话）与 @more（跳设置）。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ExpertListItem } from '../api/client';
import { filterExperts, sortExperts } from '../utils/expertFilter';

const props = defineProps<{
  /** 触发元素引用，用于计算定位与「点外部关闭」判定；null = 尚未挂载（面板不渲染） */
  anchor: HTMLElement | null;
  /** 当前会话已绑定的专家 name（绿 ✓ 与「再次点击 = 只关闭」判定） */
  selected: string | null;
  list: ExpertListItem[];
  loading: boolean;
  error: string;
  errors: string[];
}>();

const emit = defineEmits<{
  select: [expert: ExpertListItem];
  close: [];
  more: [];
  /** P0 契约扩展：查看专家详情（容器负责打开弹层） */
  detail: [expert: ExpertListItem];
}>();

const query = ref('');
const debounced = ref('');
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
watch(query, (v) => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => (debounced.value = v), 120);
});

const filtered = computed(() => sortExperts(filterExperts(props.list, debounced.value)));
const activeIdx = ref(-1);

watch(filtered, () => (activeIdx.value = -1));

function choose(e: ExpertListItem) {
  emit('select', e);
}

function onKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Escape') {
    emit('close');
    return;
  }
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    if (filtered.value.length === 0) return;
    activeIdx.value = (activeIdx.value + (ev.key === 'ArrowDown' ? 1 : filtered.value.length - 1)) % filtered.value.length;
    return;
  }
  if (ev.key === 'Enter') {
    ev.preventDefault();
    const item = filtered.value[activeIdx.value];
    if (item) choose(item);
  }
}

/** 点外部关闭（面板与触发元素之外） */
function onDocMousedown(ev: MouseEvent) {
  const t = ev.target as Node;
  if (props.anchor?.contains(t)) return;
  if (panelRef.value?.contains(t)) return;
  emit('close');
}

const panelRef = ref<HTMLElement | null>(null);

onMounted(() => document.addEventListener('mousedown', onDocMousedown));
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMousedown);
  clearTimeout(debounceTimer);
});

function layerLabel(layer: string): string {
  return layer === 'builtin' ? '内置' : layer === 'user' ? '用户级' : '项目级';
}
</script>

<template>
  <div ref="panelRef" class="expert-panel" tabindex="-1" @keydown="onKeydown">
    <div class="xp-head">
      <input
        v-model="query"
        class="xp-search"
        type="text"
        placeholder="搜索专家（名称 / 职业 / 关键词）"
        @mousedown.stop
      />
    </div>

    <div class="xp-list">
      <div v-if="loading" class="xp-state">加载中…</div>
      <div v-else-if="error" class="xp-state">
        <span>专家库加载失败：{{ error }}</span>
        <button class="xp-retry" type="button" @mousedown.prevent @click="query = query">重试</button>
      </div>
      <div v-else-if="list.length === 0" class="xp-state">
        <p>本地专家库为空</p>
        <button class="xp-retry" type="button" @mousedown.prevent @click="emit('more')">打开专家库目录</button>
      </div>
      <div v-else-if="filtered.length === 0" class="xp-state">
        <p>没有匹配「{{ debounced }}」的专家</p>
        <button class="xp-retry" type="button" @mousedown.prevent @click="emit('more')">试试导入一个专家包</button>
      </div>
      <template v-else>
        <button
          v-for="(e, i) in filtered"
          :key="e.name"
          class="xp-item"
          :class="{ active: i === activeIdx, selected: e.name === selected }"
          type="button"
          @mousedown.prevent
          @mouseenter="activeIdx = i"
          @click="choose(e)"
        >
          <span class="xp-ico" :class="e.expertType">{{ e.expertType === 'team' ? '▣' : '◆' }}</span>
          <span class="xp-main">
            <span class="xp-name">{{ e.displayName.zh || e.displayName.en }}</span>
            <span class="xp-sub">{{ e.profession.zh || e.profession.en }} · {{ layerLabel(e.layer) }}<template v-if="e.expertType === 'team'"> · {{ e.memberCount }}人</template></span>
          </span>
          <span v-if="e.missingMcp.length" class="xp-warn" title="该专家声明了未启用的 MCP 依赖（仍可召唤）">⚠ 缺 MCP 依赖</span>
          <button class="xp-info" type="button" title="查看详情" @mousedown.prevent @click.stop="emit('detail', e)">ⓘ</button>
          <span v-if="e.name === selected" class="xp-check">✓</span>
        </button>
      </template>
    </div>

    <div v-if="errors.length" class="xp-errors" title="部分专家包解析失败（不影响其他包）">⚠ {{ errors[0] }}{{ errors.length > 1 ? ` 等 ${errors.length} 条` : '' }}</div>
    <button class="xp-more" type="button" @mousedown.prevent @click="emit('more')">↗ 召唤更多专家</button>
  </div>
</template>

<style scoped>
/* 定位与视觉令牌对齐 .ac-panel（PRD §8.2：max-height 360） */
.expert-panel {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 10px;
  right: 10px;
  z-index: 30;
  display: flex;
  flex-direction: column;
  max-height: 360px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}
.xp-head { padding: 8px; border-bottom: 1px solid var(--border); background: var(--bg-panel); }
.xp-search {
  width: 100%; height: 32px; padding: 0 10px; box-sizing: border-box;
  background: var(--bg-input, var(--bg-panel)); color: var(--text);
  border: 1px solid var(--border); border-radius: 8px; outline: none; font-size: 12px;
}
.xp-search:focus { border-color: var(--accent-border, var(--accent, #4a9eff)); }
.xp-list { flex: 1; overflow-y: auto; padding: 4px; }
.xp-state { padding: 18px 12px; text-align: center; color: var(--text-dim); font-size: 12px; display: flex; flex-direction: column; gap: 8px; align-items: center; }
.xp-state p { margin: 0; }
.xp-retry { background: none; border: 1px solid var(--border); color: var(--text-dim); border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
.xp-item {
  display: flex; align-items: center; gap: 10px; width: 100%;
  min-height: 36px; padding: 4px 10px; box-sizing: border-box;
  background: none; border: 0; border-radius: 8px; cursor: pointer;
  color: var(--text); text-align: left; font-size: 13px;
}
.xp-item.active, .xp-item:hover { background: var(--bg-hover); }
.xp-ico { width: 16px; text-align: center; }
.xp-ico.team { color: var(--accent, #4a9eff); }
.xp-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.xp-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.xp-sub { font-size: 11px; color: var(--text-dim); }
.xp-warn { font-size: 11px; color: var(--orange, #d29922); white-space: nowrap; }
.xp-check { color: var(--green, #3fb950); font-weight: 700; }
.xp-info { background: none; border: 0; color: var(--text-faint); cursor: pointer; font-size: 12px; padding: 2px; }
.xp-info:hover { color: var(--text); }
.xp-errors { padding: 4px 12px; font-size: 11px; color: var(--orange, #d29922); border-top: 1px solid var(--border); }
.xp-more {
  height: 32px; border: 0; border-top: 1px solid var(--border);
  background: none; color: var(--text-dim); cursor: pointer; font-size: 12px;
}
.xp-more:hover { color: var(--text); }
</style>
