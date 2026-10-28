<script setup lang="ts">
// F-41 运行日志页（路由 /logs）：进入拉取尾部（GET /api/logs）+ SSE 实时追加（/api/logs/stream）。
// 级别过滤 / 文本过滤 / 自动滚动开关 / 复制；SSE 断线由 EventSource 自动重连（不补拉，
// 窗口期日志靠重新进入页面时的 tail 兜底）。数据源为 serve 内存环形缓冲（最近 1000 条）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api, type LogEntryView } from '../api/client';
import { subscribeLogs } from '../api/sse';

type LevelFilter = 'all' | 'info' | 'warn' | 'error';

const entries = ref<LogEntryView[]>([]);
const error = ref('');
const levelFilter = ref<LevelFilter>('all');
const textFilter = ref('');
const autoScroll = ref(true);
const paused = ref(false); // 暂停实时追加（流仍连着，暂停期间丢弃新条目）

let unsub: (() => void) | undefined;
const listEl = ref<HTMLElement | null>(null);

const filtered = computed(() => {
  const needle = textFilter.value.trim().toLowerCase();
  return entries.value.filter((e) => {
    if (levelFilter.value !== 'all' && e.level !== levelFilter.value) return false;
    if (needle) {
      const hay = `${e.source} ${e.sessionId ?? ''} ${e.message}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
});

const counts = computed(() => ({
  all: entries.value.length,
  info: entries.value.filter((e) => e.level === 'info').length,
  warn: entries.value.filter((e) => e.level === 'warn').length,
  error: entries.value.filter((e) => e.level === 'error').length,
}));

async function load(): Promise<void> {
  try {
    const r = await api.logsTail(500);
    entries.value = r.items;
    error.value = '';
    scrollToBottom();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function onEntry(e: LogEntryView): void {
  if (paused.value) return;
  entries.value.push(e);
  // 与服务端环形缓冲同口径：只保留最近 1000 条，防长开页面内存膨胀
  if (entries.value.length > 1000) entries.value.splice(0, entries.value.length - 1000);
  scrollToBottom();
}

function scrollToBottom(): void {
  if (!autoScroll.value) return;
  void nextTick(() => {
    const el = listEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

// 用户手动上滚时自动关掉自动滚动（简单启发：离开底部 40px 以上）
function onScroll(): void {
  if (!autoScroll.value) return;
  const el = listEl.value;
  if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 40) autoScroll.value = false;
}

function copyAll(): void {
  const text = filtered.value
    .map((e) => `${e.ts} [${e.level.toUpperCase()}] [${e.source}]${e.sessionId ? ` [${e.sessionId}]` : ''} ${e.message}`)
    .join('\n');
  void navigator.clipboard.writeText(text);
}

function fmtTs(ts: string): string {
  return ts.slice(11, 23); // HH:mm:ss.mmm（ISO 去日期段）
}

function sessionIdShort(id: string): string {
  return id.slice(0, 8);
}

onMounted(() => {
  void load();
  unsub = subscribeLogs(onEntry);
});

onBeforeUnmount(() => {
  unsub?.();
});

// 过滤条件变化时回到底部
watch([levelFilter, textFilter], () => scrollToBottom());
</script>

<template>
  <div class="page">
    <div class="head">
      <h2>📜 运行日志</h2>
      <div class="head-actions">
        <label class="chk"><input v-model="autoScroll" type="checkbox" /> 自动滚动</label>
        <button class="btn-sm" @click="paused = !paused">{{ paused ? '▶ 恢复' : '⏸ 暂停' }}</button>
        <button class="btn-sm" @click="load()">刷新</button>
        <button class="btn-sm" @click="copyAll()">复制</button>
      </div>
    </div>

    <p v-if="error" class="error">✘ {{ error }}</p>

    <div class="filters">
      <div class="levels">
        <button
          v-for="(label, key) in { all: `全部 ${counts.all}`, info: `info ${counts.info}`, warn: `warn ${counts.warn}`, error: `error ${counts.error}` }"
          :key="key"
          class="chip"
          :class="{ active: levelFilter === key }"
          @click="levelFilter = key as LevelFilter"
        >{{ label }}</button>
      </div>
      <input v-model="textFilter" class="text-filter" placeholder="过滤：来源 / 会话 / 内容…" />
    </div>

    <div ref="listEl" class="log-list" @scroll="onScroll">
      <p v-if="filtered.length === 0" class="empty">暂无日志（serve 运行期间的任务开始 / 工具调用 / 异常都会出现在这里）</p>
      <div
        v-for="(e, i) in filtered"
        :key="i"
        class="log-line"
        :class="e.level"
      >
        <span class="l-ts">{{ fmtTs(e.ts) }}</span>
        <span class="l-badge" :class="e.level">{{ e.level }}</span>
        <span class="l-src">{{ e.source }}</span>
        <span v-if="e.sessionId" class="l-sid" :title="e.sessionId">{{ sessionIdShort(e.sessionId) }}</span>
        <span class="l-msg">{{ e.message }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.head-actions { display: flex; align-items: center; gap: 8px; }
.chk { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-dim, #888); cursor: pointer; }

.filters { display: flex; align-items: center; gap: 12px; margin: 8px 0 12px; flex-wrap: wrap; }
.levels { display: flex; gap: 6px; }
.chip {
  border: 1px solid var(--border, #333); background: transparent; color: var(--text-dim, #999);
  border-radius: 999px; padding: 3px 12px; font-size: 12px; cursor: pointer;
}
.chip.active { background: var(--bg-active, #2a2a2a); color: var(--text, #eee); border-color: var(--text-dim, #666); }
.text-filter {
  flex: 1; min-width: 200px; max-width: 420px;
  background: var(--bg-input, #1b1b1b); border: 1px solid var(--border, #333);
  border-radius: 6px; color: var(--text, #eee); padding: 6px 10px; font-size: 13px;
}

.log-list {
  flex: 1; overflow-y: auto;
  background: var(--bg-input, #141414);
  border: 1px solid var(--border, #2a2a2a); border-radius: 8px;
  padding: 8px 0; font-family: ui-monospace, 'SF Mono', Consolas, monospace; font-size: 12px;
  line-height: 1.7; min-height: 0;
}
.log-line { display: flex; gap: 8px; padding: 0 12px; align-items: baseline; }
.log-line:hover { background: var(--bg-hover, #1d1d1d); }
.log-line.error .l-msg { color: var(--danger, #f66); }
.log-line.warn .l-msg { color: var(--warning, #eb5); }
.l-ts { color: var(--text-dim, #777); flex: none; }
.l-badge { flex: none; width: 40px; text-align: center; border-radius: 4px; font-size: 10px; padding: 0 2px; }
.l-badge.info { color: var(--text-dim, #999); }
.l-badge.warn { color: var(--warning, #eb5); }
.l-badge.error { color: var(--danger, #f66); }
.l-src { color: var(--primary, #7ab); flex: none; width: 44px; }
.l-sid { color: var(--text-dim, #888); flex: none; }
.l-msg { white-space: pre-wrap; word-break: break-all; color: var(--text, #ddd); }
.empty { color: var(--text-dim, #888); padding: 16px 12px; font-size: 13px; }
.error { color: var(--danger, #f66); }
</style>
