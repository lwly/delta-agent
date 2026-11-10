<script setup lang="ts">
// 设置页·运行日志面板（F-41）：尾读 + SSE 实时追加；级别/文本过滤与 CronView 同 T6 作用域口径。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api, type LogEntryView } from '../../api/client';
import { subscribeLogs } from '../../api/sse';
import { useWorkspaceStore } from '../../stores/workspace';

type LevelFilter = 'all' | 'debug' | 'info' | 'warn' | 'error';

const ws = useWorkspaceStore();
const projectScoped = ref(true);
const activeProjectName = computed(() => ws.projects.find((p) => p.id === ws.activeProjectId)?.name ?? '');
const activeRoot = computed(() => ws.projects.find((p) => p.id === ws.activeProjectId)?.root_path ?? '');
const scopedProjectId = computed(() => (projectScoped.value ? ws.activeProjectId || undefined : undefined));

const entries = ref<LogEntryView[]>([]);
const error = ref('');
const levelFilter = ref<LevelFilter>('all');
const textFilter = ref('');
const autoScroll = ref(true);
const paused = ref(false);

let unsub: (() => void) | undefined;
const listEl = ref<HTMLElement | null>(null);

const scopedEntries = computed(() => entries.value);

const filtered = computed(() => {
  const needle = textFilter.value.trim().toLowerCase();
  return scopedEntries.value.filter((e) => {
    if (levelFilter.value !== 'all' && e.level !== levelFilter.value) return false;
    if (needle) {
      const hay = `${e.source} ${e.sessionId ?? ''} ${e.message}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
});

const counts = computed(() => ({
  all: scopedEntries.value.length,
  debug: scopedEntries.value.filter((e) => e.level === 'debug').length,
  info: scopedEntries.value.filter((e) => e.level === 'info').length,
  warn: scopedEntries.value.filter((e) => e.level === 'warn').length,
  error: scopedEntries.value.filter((e) => e.level === 'error').length,
}));

async function load(): Promise<void> {
  try {
    const r = await api.logsTail(500, scopedProjectId.value ? { projectId: scopedProjectId.value } : undefined);
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
  if (entries.value.length > 1000) entries.value.splice(0, entries.value.length - 1000);
  scrollToBottom();
}

function connectStream(): void {
  unsub?.();
  unsub = subscribeLogs(onEntry, scopedProjectId.value ? { projectId: scopedProjectId.value } : undefined);
}

function scrollToBottom(): void {
  if (!autoScroll.value) return;
  void nextTick(() => {
    const el = listEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

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
  return ts.slice(11, 23);
}

function sessionIdShort(id: string): string {
  return id.slice(0, 8);
}

onMounted(() => {
  void load();
  connectStream();
});

onBeforeUnmount(() => {
  unsub?.();
});

watch(
  [() => ws.activeProjectId, projectScoped] as const,
  () => {
    void load();
    connectStream();
  },
);

watch([levelFilter, textFilter], () => scrollToBottom());
</script>

<template>
  <div class="logs-panel">
    <p class="sub">serve 内存环形缓冲（最近 1000 条）+ SSE 实时追加；落盘见 <code>~/.delta/logs/</code></p>
    <div class="toolbar">
      <button
        v-if="activeRoot"
        class="btn-sm scope"
        :class="{ active: projectScoped }"
        :title="projectScoped ? `只显示 ${activeProjectName} 的日志（会话与定时任务，服务端过滤）` : '显示全部日志，点击回到当前项目'"
        @click="projectScoped = !projectScoped"
      >{{ projectScoped ? `📁 ${activeProjectName}` : '全部日志' }}</button>
      <label class="chk"><input v-model="autoScroll" type="checkbox" /> 自动滚动</label>
      <button class="btn-sm" type="button" @click="paused = !paused">{{ paused ? '▶ 恢复' : '⏸ 暂停' }}</button>
      <button class="btn-sm" type="button" @click="load()">刷新</button>
      <button class="btn-sm" type="button" @click="copyAll()">复制</button>
    </div>

    <p v-if="error" class="error">✘ {{ error }}</p>

    <div class="filters">
      <div class="levels">
        <button
          v-for="(label, key) in { all: `全部 ${counts.all}`, debug: `debug ${counts.debug}`, info: `info ${counts.info}`, warn: `warn ${counts.warn}`, error: `error ${counts.error}` }"
          :key="key"
          class="chip"
          :class="{ active: levelFilter === key }"
          type="button"
          @click="levelFilter = key as LevelFilter"
        >{{ label }}</button>
      </div>
      <input v-model="textFilter" class="text-filter" placeholder="过滤：来源 / 会话 / 内容…" />
    </div>

    <div ref="listEl" class="log-list" @scroll="onScroll">
      <p v-if="filtered.length === 0" class="empty">
        {{ projectScoped && activeRoot && entries.length > 0
          ? '当前项目的会话暂无日志——点「全部日志」查看其它日志，或回工作台运行一个任务'
          : '暂无日志（serve 运行期间的任务开始 / 工具调用 / 异常都会出现在这里）' }}
      </p>
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
.logs-panel { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
.sub { margin: 0; font-size: 12.5px; color: var(--text-dim); line-height: 1.5; }
.toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.btn-sm {
  height: 28px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-elevated); color: var(--text-dim); font-size: 12px; cursor: pointer;
  transition: background 0.12s ease-out, color 0.12s ease-out, border-color 0.12s ease-out;
}
.btn-sm:hover { background: var(--bg-elevated-2); color: var(--text); border-color: var(--border-strong); }
.btn-sm.scope { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn-sm.scope.active { background: var(--bg-active); color: var(--text); border-color: var(--border-strong); }
.chk { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-dim); cursor: pointer; }

.filters { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.levels { display: flex; gap: 6px; flex-wrap: wrap; }
.chip {
  border: 1px solid var(--border); background: var(--bg-elevated); color: var(--text-dim);
  border-radius: var(--radius-sm); padding: 4px 12px; font-size: 12px; cursor: pointer;
  transition: background 0.12s ease-out, color 0.12s ease-out;
}
.chip:hover { color: var(--text); }
.chip.active { background: var(--bg-active); color: var(--text); border-color: var(--border-strong); }
.text-filter {
  flex: 1; min-width: 200px; max-width: 420px; height: 30px;
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: var(--radius-sm); color: var(--text); padding: 0 10px; font-size: 12px;
}
.text-filter:focus { border-color: var(--border-strong); }

.log-list {
  min-height: 420px; max-height: min(70vh, 720px); overflow-y: auto;
  background: var(--bg-elevated);
  border: 1px solid var(--border); border-radius: var(--radius-md);
  padding: 8px 0; font-family: var(--mono); font-size: 12px;
  line-height: 1.7;
}
.log-line { display: flex; gap: 8px; padding: 0 12px; align-items: baseline; }
.log-line:hover { background: var(--bg-hover); }
.log-line.error .l-msg { color: var(--red); }
.log-line.warn .l-msg { color: var(--orange); }
.l-ts { color: var(--text-faint); flex: none; }
.l-badge { flex: none; width: 40px; text-align: center; border-radius: 4px; font-size: 10px; padding: 0 2px; }
.l-badge.debug { color: var(--text-faint); }
.l-badge.info { color: var(--text-dim); }
.l-badge.warn { color: var(--orange); }
.l-badge.error { color: var(--red); }
.l-src { color: var(--text-dim); flex: none; width: 44px; }
.l-sid { color: var(--text-faint); flex: none; }
.l-msg { white-space: pre-wrap; word-break: break-all; color: var(--text); }
.empty { color: var(--text-faint); padding: 16px 12px; font-size: 13px; }
.error { color: var(--red); margin: 0; }
</style>
