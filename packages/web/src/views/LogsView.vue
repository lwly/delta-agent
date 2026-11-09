<script setup lang="ts">
// F-41 运行日志页（路由 /logs）：进入拉取尾部（GET /api/logs）+ SSE 实时追加（/api/logs/stream）。
// 级别过滤 / 文本过滤 / 自动滚动开关 / 复制；SSE 断线由 EventSource 自动重连（不补拉，
// 窗口期日志靠重新进入页面时的 tail 兜底）。数据源为 serve 内存环形缓冲（最近 1000 条）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api, type LogEntryView } from '../api/client';
import { subscribeLogs } from '../api/sse';
import { useWorkspaceStore } from '../stores/workspace';
import { logEntryInProject } from '../utils/scope';

type LevelFilter = 'all' | 'debug' | 'info' | 'warn' | 'error';

// ── F-59 项目作用域：默认只显示当前项目会话产生的日志（LogEntry.sessionId 归属过滤，
//    F-41 D10：sessionId 本就为 Web 过滤设计），无 sessionId 的 serve/cron 级全局条目在作用域下隐藏 ──
const ws = useWorkspaceStore();
const projectScoped = ref(true);
const activeProjectName = computed(() => ws.projects.find((p) => p.id === ws.activeProjectId)?.name ?? '');
const activeRoot = computed(() => ws.projects.find((p) => p.id === ws.activeProjectId)?.root_path ?? '');
/** 当前项目的会话 id 集合（一次拉 500 条做归属映射；环形缓冲仅 1000 条，覆盖足够） */
const projectSessionIds = ref<Set<string>>(new Set());

async function loadProjectSessions(): Promise<void> {
  const pid = ws.activeProjectId;
  if (!pid) {
    projectSessionIds.value = new Set();
    return;
  }
  try {
    const r = await api.listSessionsPage(pid, { limit: 500 });
    // 项目已切走：丢弃过期响应
    if (ws.activeProjectId === pid) projectSessionIds.value = new Set(r.sessions.map((s) => s.id));
  } catch {
    /* 瞬时失败保持现状（作用域过滤退化为空集时用户可切「全部」） */
  }
}

watch(
  () => [ws.activeProjectId, projectScoped.value] as const,
  () => void loadProjectSessions(),
  { immediate: true },
);

const entries = ref<LogEntryView[]>([]);
const error = ref('');
const levelFilter = ref<LevelFilter>('all');
const textFilter = ref('');
const autoScroll = ref(true);
const paused = ref(false); // 暂停实时追加（流仍连着，暂停期间丢弃新条目）

let unsub: (() => void) | undefined;
const listEl = ref<HTMLElement | null>(null);

/** 项目作用域后的条目集（级别计数与列表同源，数字与所见一致） */
const scopedEntries = computed(() => {
  if (!projectScoped.value || !activeRoot.value) return entries.value;
  const ids = projectSessionIds.value;
  return entries.value.filter((e) => logEntryInProject(e.sessionId, ids));
});

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
      <h2>运行日志</h2>
      <div class="head-actions">
        <router-link class="btn-sm" to="/">← 工作台</router-link>
        <!-- F-59 项目作用域开关：跟随左侧选中的项目（会话归属过滤） -->
        <button
          v-if="activeRoot"
          class="btn-sm scope"
          :class="{ active: projectScoped }"
          :title="projectScoped ? `只显示 ${activeProjectName} 会话产生的日志，点击查看全部` : '显示全部日志，点击回到当前项目'"
          @click="projectScoped = !projectScoped"
        >{{ projectScoped ? `📁 ${activeProjectName}` : '全部日志' }}</button>
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
          v-for="(label, key) in { all: `全部 ${counts.all}`, debug: `debug ${counts.debug}`, info: `info ${counts.info}`, warn: `warn ${counts.warn}`, error: `error ${counts.error}` }"
          :key="key"
          class="chip"
          :class="{ active: levelFilter === key }"
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
/* 页面骨架：与 CronView 同规范（工作台子路由、撑满主区内部滚动、13px/600 标题） */
.page { color: var(--text); padding: 16px 24px 24px; max-width: 1100px; margin: 0 auto; flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h2 { margin: 0; font-size: 13px; font-weight: 600; }
.head-actions { display: flex; align-items: center; gap: 8px; }
/* 头部小按钮：28px 高静默钮（此前无样式，浏览器默认外观） */
.btn-sm {
  height: 28px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-elevated); color: var(--text-dim); font-size: 12px; cursor: pointer;
  transition: background 0.12s ease-out, color 0.12s ease-out, border-color 0.12s ease-out;
}
.btn-sm:hover { background: var(--bg-elevated-2); color: var(--text); border-color: var(--border-strong); }
a.btn-sm { text-decoration: none; }
/* 作用域开关：激活态提亮（与 chip.active 同口径）；关闭态为普通 btn-sm */
.btn-sm.scope { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn-sm.scope:not(:disabled) { color: var(--text-dim); }
.btn-sm.scope.active { background: var(--bg-active); color: var(--text); border-color: var(--border-strong); }
.chk { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-dim); cursor: pointer; }

.filters { display: flex; align-items: center; gap: 12px; margin: 10px 0 12px; flex-wrap: wrap; }
.levels { display: flex; gap: 6px; }
/* 级别筛选 chip：bg-elevated 药丸，激活 bg-active（不填充强调色底） */
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
  flex: 1; overflow-y: auto;
  background: var(--bg-elevated);
  border: 1px solid var(--border); border-radius: var(--radius-md);
  padding: 8px 0; font-family: var(--mono); font-size: 12px;
  line-height: 1.7; min-height: 0;
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
.error { color: var(--red); }
</style>
