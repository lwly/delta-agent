<script setup lang="ts">
// 工具调用卡片：调用（assistant.toolCalls）与结果（role:'tool' 消息）按 callId 合并渲染。
// 状态徽章 / 耗时 / 步骤序号 / 主参数摘要 / 结果摘要-全文切换 / 复制（含 1.5s「已复制 ✓」局部反馈）。
// 诚实性口径：耗时为本地计时（store pendingCalls startedAt 差值）；序号为本地递增计数；不做伪造。
import { computed, ref } from 'vue';

type ToolStatus = 'running' | 'ok' | 'fail';

interface Props {
  name: string;
  argsJson: string;
  status: ToolStatus;
  /** 结果内容（运行中为空） */
  content?: string;
  /** 本地计时耗时（ms） */
  durationMs?: number | null;
  /** 本地步骤序号（第 N 步） */
  seq?: number | null;
  sandboxMeta?: { mode: string; network?: string; ms?: number; degraded?: boolean } | null;
}

const props = withDefaults(defineProps<Props>(), {
  content: '',
  durationMs: null,
  seq: null,
  sandboxMeta: null,
});

/** 展开态：默认展开显示结果摘要（全文 DOM 仍由 showAll v-if 控制，不渲染） */
const open = ref(true);
/** 结果全文展开开关（长输出默认只渲染摘要，性能红线） */
const showAll = ref(false);
/** 各复制按钮的局部成功反馈（1.5s 后还原，不用全局 notice） */
const copiedJson = ref(false);
const copiedOut = ref(false);

const SUMMARY_LINE_LIMIT = 8;
const SUMMARY_CHAR_LIMIT = 500;

// ── 工具图标映射 ─────────────────────────────────────────────
const icon = computed(() => {
  const n = props.name;
  if (n === 'run_command') return '⌘';
  if (n === 'write_file' || n === 'edit_file') return '✎';
  if (n === 'read_file') return '📄';
  if (n === 'grep' || n === 'glob') return '🔍';
  if (n === 'web_fetch') return '🌐';
  return '⚙';
});

const statusLabel = computed(
  () => ({ running: '运行中', ok: '成功', fail: '失败' })[props.status],
);

// ── 主参数摘要行 ─────────────────────────────────────────────
function parseArgs(): Record<string, unknown> {
  try {
    const v = JSON.parse(props.argsJson || '{}');
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function fmtBytes(n: number): string {
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

/** 主参数摘要：run_command 直接展示命令文本；其他工具展示关键参数一行 */
const cmdSummary = computed(() => {
  const args = parseArgs();
  if (props.name === 'run_command') {
    const cmd = String(args.command ?? '');
    return cmd || '（无命令）';
  }
  if (props.name === 'read_file') return String(args.path ?? '');
  if (props.name === 'write_file' || props.name === 'edit_file') {
    const path = String(args.path ?? '');
    const size = typeof args.content === 'string' ? ` · ${fmtBytes(args.content.length)}` : '';
    return `${path}${size}`;
  }
  if (props.name === 'grep' || props.name === 'glob') {
    const base = String(args.pattern ?? '');
    const path = args.path ? ` in ${String(args.path)}` : '';
    return `${base}${path}`;
  }
  if (props.name === 'web_fetch') return String(args.url ?? '');
  // 兜底：单行截断的完整参数
  let pretty = '';
  try {
    pretty = JSON.stringify(JSON.parse(props.argsJson || '{}'), null, 2).replace(/\s+/g, ' ');
  } catch {
    pretty = props.argsJson;
  }
  return pretty.length > 72 ? `${pretty.slice(0, 72)}…` : pretty;
});

// ── 失败原因摘要（可读化，原文仍可展开） ────────────────────
const failureReason = computed(() => {
  if (props.status !== 'fail') return '';
  const firstLine = props.content.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const exit = /\[exit code:\s*(\d+)\]/.exec(firstLine) ?? /\[exit code:\s*(\d+)\]/.exec(props.content.slice(0, 300));
  if (exit) return `命令退出码 ${exit[1]}`;
  if (/rejected_by_user/i.test(firstLine)) return '用户拒绝执行';
  if (/^error\b/i.test(firstLine)) return firstLine.slice(0, 120);
  return '执行失败';
});

// ── 结果摘要 / 全文 ─────────────────────────────────────────
const truncated = computed(() => props.content.length > SUMMARY_CHAR_LIMIT || props.content.split('\n').length > SUMMARY_LINE_LIMIT);

const resultSummary = computed(() => {
  const lines = props.content.split('\n');
  let text = lines.slice(0, SUMMARY_LINE_LIMIT).join('\n');
  if (text.length > SUMMARY_CHAR_LIMIT) text = text.slice(0, SUMMARY_CHAR_LIMIT);
  return text;
});

const durationLabel = computed(() => {
  if (props.durationMs == null) return '';
  return props.durationMs < 1000 ? `${props.durationMs}ms` : `${(props.durationMs / 1000).toFixed(1)}s`;
});

const argsPretty = computed(() => {
  try {
    return JSON.stringify(JSON.parse(props.argsJson || '{}'), null, 2);
  } catch {
    return props.argsJson;
  }
});

function copyText(text: string, flag: (v: boolean) => void) {
  navigator.clipboard
    .writeText(text)
    .then(() => {
      flag(true);
      window.setTimeout(() => flag(false), 1500);
    })
    .catch(() => flag(false));
}
function copyJson() {
  copyText(argsPretty.value, (v) => (copiedJson.value = v));
}
function copyOut() {
  copyText(props.content, (v) => (copiedOut.value = v));
}
</script>

<template>
  <div class="tcard" :class="[`st-${status}`, { open }]">
    <!-- 首行：图标 + 工具名 + 状态徽章 + 耗时 + 步骤序号 + 折叠/复制 -->
    <div class="tcard-head" role="button" tabindex="0" :title="open ? '点击折叠' : '点击展开'" @click="open = !open" @keydown.enter.prevent="open = !open">
      <span class="tcard-ico">{{ icon }}</span>
      <span class="tcard-name">{{ name }}</span>
      <span class="tbadge" :class="`b-${status}`">{{ statusLabel }}</span>
      <span v-if="durationLabel" class="tcard-dur">{{ durationLabel }}</span>
      <span v-if="seq != null" class="tcard-seq">第 {{ seq }} 步</span>
      <span
        v-if="sandboxMeta"
        class="sandbox-badge"
        :title="`沙箱后端 ${sandboxMeta.mode}${sandboxMeta.degraded ? '（已降级）' : ''}`"
      >🛡 {{ sandboxMeta.mode }}{{ sandboxMeta.ms != null ? ` · ${sandboxMeta.ms}ms` : '' }}</span>
      <span class="tcard-spring" />
      <button class="tcopy" type="button" :title="`复制 ${name} 参数 JSON`" @click.stop="copyJson">
        {{ copiedJson ? '已复制 ✓' : '复制 JSON' }}
      </button>
      <span class="tcard-caret" :class="{ rot: open }" aria-hidden="true">▶</span>
    </div>

    <!-- 命令区：折叠态也保持可见的主参数摘要（run_command = 可读命令文本） -->
    <div class="tcard-cmd" :class="{ mono: name === 'run_command' }" :title="cmdSummary">{{ cmdSummary }}</div>

    <!-- 卡片正文：折叠态不渲染（长列表性能红线） -->
    <div v-if="open" class="tcard-body">
      <template v-if="status === 'running'">
        <div class="tcard-hint"><span class="mini-dot" />工具执行中，等待结果返回…</div>
      </template>
      <template v-else-if="content">
        <div v-if="failureReason" class="tcard-fail">✘ {{ failureReason }}</div>
        <!-- 全文仅在 showAll 时渲染；摘要态末尾标注总字符数 -->
        <pre v-if="showAll" class="tcard-out full">{{ content }}</pre>
        <pre v-else class="tcard-out">{{ resultSummary }}<span v-if="truncated" class="tcard-ellipsis">…
… 共 {{ content.length }} 字符</span></pre>
        <div class="tcard-ops">
          <button v-if="truncated" class="tmini" type="button" @click="showAll = !showAll">
            {{ showAll ? '收起' : '展开全部' }}
          </button>
          <button class="tmini" type="button" @click="copyOut">{{ copiedOut ? '已复制 ✓' : '复制输出' }}</button>
        </div>
      </template>
      <!-- 完整参数 JSON 折叠进「详情」子折叠区（默认收起），不再平铺 -->
      <details class="tcard-details">
        <summary>详情 · 参数 JSON</summary>
        <pre>{{ argsPretty }}</pre>
      </details>
    </div>
  </div>
</template>

<style scoped>
/* 卡片容器：--bg-elevated 底、1px 边框、10px 圆角，与正文气泡拉开层次 */
.tcard {
  border: 1px solid var(--border); border-radius: 10px;
  background: var(--bg-elevated); margin: 8px 0; overflow: hidden;
  animation: fadeIn 0.25s ease;
  min-width: 0;
}
.tcard.st-fail { border-color: rgba(248, 81, 73, 0.45); }
.tcard.st-running { border-color: rgba(210, 153, 34, 0.35); }

/* 头部：8px 12px padding，hover --bg-hover */
.tcard-head {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; cursor: pointer; user-select: none;
  transition: background 0.12s;
}
.tcard-head:hover { background: var(--bg-hover); }
.tcard-ico { font-size: 13px; flex: none; width: 18px; text-align: center; }
.tcard-name { font-family: var(--mono); font-size: 12.5px; font-weight: 600; color: var(--accent); white-space: nowrap; }
.tcard-dur { font-family: var(--mono); font-size: 11px; color: var(--text-dim); white-space: nowrap; }
.tcard-seq { font-size: 11px; color: var(--text-dim); white-space: nowrap; }
.tcard-spring { flex: 1; min-width: 0; }
.tcard-caret { color: var(--text-faint); font-size: 10px; transition: transform 0.15s; flex: none; }
.tcard-caret.rot { transform: rotate(90deg); }

/* 状态徽章：11px / padding 1px 8px / 圆角 999px / 字重 600（G 规范） */
.tbadge {
  flex: none; font-size: 11px; line-height: 1.4; padding: 1px 8px;
  border-radius: 999px; font-weight: 600; white-space: nowrap;
}
.tbadge.b-running { color: var(--orange); background: var(--orange-soft); animation: badge-breathe 1.6s ease-in-out infinite; }
.tbadge.b-ok { color: var(--green); background: var(--green-soft); }
.tbadge.b-fail { color: var(--red); background: var(--red-soft); }
@keyframes badge-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }

.sandbox-badge {
  flex: none; font-size: 11px; color: var(--green); background: var(--green-soft);
  border-radius: 4px; padding: 1px 7px; font-family: var(--mono); white-space: nowrap;
}

/* 复制 JSON：头部紧凑按钮 */
.tcopy {
  flex: none; padding: 1px 7px; border-radius: 5px;
  border: 1px solid var(--border); background: transparent;
  color: var(--text-dim); font-size: 10.5px; cursor: pointer;
  transition: all 0.12s; white-space: nowrap;
}
.tcopy:hover { color: var(--accent); border-color: var(--accent-border); background: var(--accent-soft); }

/* 命令区：折叠/展开均可见的主参数摘要行 */
.tcard-cmd {
  padding: 6px 12px 8px; font-size: 12px; color: var(--text-dim);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  border-top: 1px solid var(--border); min-width: 0;
}
.tcard-cmd.mono { font-family: var(--mono); color: var(--text); font-size: 12px; }

/* 正文 */
.tcard-body { padding: 0 12px 10px; min-width: 0; }
.tcard-hint {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 0 2px; font-size: 12px; color: var(--text-dim);
}
.mini-dot {
  width: 7px; height: 7px; border-radius: 50%; background: var(--orange);
  animation: badge-breathe 1.2s ease-in-out infinite; flex: none;
}
.tcard-fail {
  margin-top: 8px; padding: 6px 10px; border-radius: 7px;
  background: var(--red-soft); color: var(--red); font-size: 12px;
}
/* 结果输出区：摘要态最多 8 行量级；全文态横向滚动 + 320px 内滚，不撑爆消息流 */
.tcard-out {
  margin: 8px 0 0; font-family: var(--mono); font-size: 12px; line-height: 1.6;
  padding: 8px 10px; background: var(--bg); border: 1px solid var(--border); border-radius: 7px;
  color: var(--text-dim); white-space: pre-wrap; word-break: break-word;
  overflow-x: auto; min-width: 0;
}
.tcard-out.full {
  white-space: pre; max-height: 320px; overflow: auto;
}
.tcard-ellipsis { color: var(--text-dim); }
.tcard-ops { display: flex; gap: 6px; margin-top: 6px; }
.tmini {
  padding: 2px 9px; border-radius: 6px; border: 1px solid var(--border);
  background: var(--bg-elevated); color: var(--text-faint); font-size: 11px; cursor: pointer;
  transition: all 0.12s;
}
.tmini:hover { color: var(--accent); border-color: var(--accent-border); background: var(--accent-soft); }

/* 详情子折叠区（参数 JSON，默认收起） */
.tcard-details { margin-top: 8px; }
.tcard-details summary {
  font-size: 11px; color: var(--text-dim); cursor: pointer; user-select: none;
  padding: 3px 0; list-style: none;
}
.tcard-details summary::-webkit-details-marker { display: none; }
.tcard-details summary::before { content: '▸ '; }
.tcard-details[open] summary::before { content: '▾ '; }
.tcard-details summary:hover { color: var(--text); }
.tcard-details pre {
  font-family: var(--mono); font-size: 11.5px; line-height: 1.6;
  background: var(--bg); border: 1px solid var(--border); border-radius: 7px;
  padding: 8px 10px; margin: 4px 0 0; color: var(--text-dim);
  white-space: pre-wrap; word-break: break-word;
  max-height: 240px; overflow: auto; min-width: 0;
}
</style>
