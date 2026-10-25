<script setup lang="ts">
// F-38 文件预览（PRD F-38-5，design D9/D10/D14 + §5.2）
// 头行 40px：文件名 + 📋 复制 + ⋯ 更多（复制相对路径 / 在文件管理器中显示）
// 正文四分流：Markdown（renderMarkdown）/ 代码（renderCode + 行号 gutter）/ 图片（<img :src>）/ 降级卡
// 安全边界：文件内容**绝不**直接交给 v-html；Markdown 与代码都走 render.ts 的 DOMPurify 链路；
//          图片只用 <img :src="data_url">，不解析任何 HTML。
import { computed, ref } from 'vue';
import { useFilePanelStore } from '../stores/filePanel';
import { renderCode, renderMarkdown } from '../render';

const props = defineProps<{ path: string }>();

const panel = useFilePanelStore();

const preview = computed(() => panel.previews[props.path]);
const loading = computed(() => panel.previewLoading[props.path] === true);
const error = computed(() => panel.previewError[props.path] ?? '');

/** 高亮上限：超大文本只做转义展示，避免 hljs 在 1MB 文件上阻塞 UI（1MB 仍是硬上限） */
const HIGHLIGHT_MAX_CHARS = 200_000;

const markdownHtml = computed(() => {
  const p = preview.value;
  if (!p || p.kind !== 'markdown' || !p.content) return '';
  return renderMarkdown(p.content);
});

const codeHtml = computed(() => {
  const p = preview.value;
  if (!p || p.kind !== 'text' || p.content === undefined) return '';
  const lang = p.content.length <= HIGHLIGHT_MAX_CHARS ? p.language : undefined;
  return renderCode(p.content, lang);
});

/** 行号 gutter（代码只读 <pre> 内的行数） */
const lineNumbers = computed<number[]>(() => {
  const p = preview.value;
  if (!p || p.kind !== 'text' || p.content === undefined) return [];
  const count = p.content.split('\n').length;
  return Array.from({ length: count }, (_, i) => i + 1);
});

/** 人类可读文件大小（降级卡展示） */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const copied = ref(false);
const menuOpen = ref(false);

/** 复制：文本类复制原文（Markdown 亦复制原文）；图片 / 降级态复制相对路径 */
async function copyContent(): Promise<void> {
  const p = preview.value;
  if (!p) return;
  const text = p.kind === 'markdown' || p.kind === 'text' ? (p.content ?? p.path) : p.path;
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1500);
  } catch {
    copied.value = false;
  }
}

async function copyPath(): Promise<void> {
  menuOpen.value = false;
  try {
    await navigator.clipboard.writeText(props.path);
  } catch {
    // 剪贴板不可用时静默（不打断阅读）
  }
}

/** ⋯ 菜单第二项：在系统文件管理器中显示（走 reveal 端点，只调 OS，不写文件） */
function revealInFileManager(): void {
  menuOpen.value = false;
  void panel.reveal(props.path);
}

function retry(): void {
  void panel.loadPreview(props.path, true);
}
</script>

<template>
  <div class="preview">
    <!-- 预览头 40px -->
    <div class="pv-head">
      <span class="pv-name" :title="path">{{ preview?.name ?? path }}</span>
      <button class="pv-op" type="button" title="复制文件内容" :disabled="!preview" @click="copyContent">
        {{ copied ? '✓ 已复制' : '📋 复制' }}
      </button>
      <div class="pv-more-wrap">
        <button class="pv-op ico" type="button" title="更多操作" @click="menuOpen = !menuOpen">⋯</button>
        <!-- 点击外部关闭层 -->
        <div v-if="menuOpen" class="pv-menu-overlay" @click="menuOpen = false" />
        <div v-if="menuOpen" class="pv-menu">
          <button class="pv-menu-item" type="button" @click="copyPath">
            <span class="pv-mi">📋</span>复制相对路径
          </button>
          <button class="pv-menu-item" type="button" @click="revealInFileManager">
            <span class="pv-mi">📂</span>在文件管理器中显示
          </button>
        </div>
      </div>
    </div>

    <div class="pv-body">
      <!-- 加载态 -->
      <div v-if="loading && !preview" class="pv-state">加载中…</div>

      <!-- 错误态：内联卡片；文件被删除时给出「关闭该标签」出口 -->
      <div v-else-if="error" class="pv-state error">
        <p class="pv-state-text">✘ {{ error }}</p>
        <div class="pv-err-ops">
          <button class="pv-state-btn" type="button" @click="retry">加载失败，点击重试</button>
          <button class="pv-state-btn" type="button" @click="panel.closeTab(`file:${path}`)">关闭该标签</button>
        </div>
      </div>

      <template v-else-if="preview">
        <!-- Markdown -->
        <div v-if="preview.kind === 'markdown'" class="pv-md md" v-html="markdownHtml" />

        <!-- 代码：行号 gutter + hljs 高亮（只读 <pre>，不换行，横向滚动） -->
        <div v-else-if="preview.kind === 'text'" class="pv-code">
          <div class="code-gutter" aria-hidden="true">
            <span v-for="n in lineNumbers" :key="n" class="code-no">{{ n }}</span>
          </div>
          <pre class="code-pre"><code class="hljs" v-html="codeHtml" /></pre>
        </div>

        <!-- 图片：直接 <img :src>，绝不 v-html -->
        <div v-else-if="preview.kind === 'image'" class="pv-image">
          <img :src="preview.data_url" :alt="preview.name" />
          <p class="pv-image-meta">{{ preview.mime }} · {{ formatSize(preview.size) }}</p>
        </div>

        <!-- 二进制 / 超大：降级卡（服务端 reason 原样展示，不做下载） -->
        <div v-else class="pv-state degrade">
          <p class="pv-degrade-title">{{ preview.kind === 'oversize' ? '该文件无法预览' : '二进制文件' }}</p>
          <p class="pv-state-text">{{ preview.reason }}</p>
          <p class="pv-meta-line">大小：{{ formatSize(preview.size) }}</p>
          <p class="pv-meta-line path">{{ preview.path }}</p>
        </div>
      </template>

      <div v-else class="pv-state">加载中…</div>
    </div>
  </div>
</template>

<style scoped>
.preview { flex: 1; min-height: 0; display: flex; flex-direction: column; }

/* 预览头 40px（PRD §5.6） */
.pv-head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  min-height: 40px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
}
.pv-name {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pv-op {
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-dim);
  font-size: 11.5px;
  padding: 3px 8px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.pv-op:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }
.pv-op:disabled { opacity: 0.45; cursor: not-allowed; }
.pv-op.ico { font-size: 13px; padding: 2px 7px; }
.pv-more-wrap { position: relative; }
.pv-menu-overlay { position: fixed; inset: 0; z-index: 70; }
.pv-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 71;
  min-width: 176px;
  padding: 4px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}
.pv-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.pv-menu-item:hover { background: var(--bg-hover); color: var(--text); }
.pv-mi { font-size: 12px; }

.pv-body { flex: 1; min-height: 0; overflow: auto; }

/* Markdown 正文：与消息流同口径（markdown-it + DOMPurify），单独控制内边距 */
.pv-md { padding: 12px 14px; font-size: 13px; line-height: 1.65; color: var(--text); }
.pv-md :deep(h1), .pv-md :deep(h2), .pv-md :deep(h3) { margin: 14px 0 8px; line-height: 1.35; }
.pv-md :deep(h1) { font-size: 19px; }
.pv-md :deep(h2) { font-size: 16px; }
.pv-md :deep(h3) { font-size: 14px; }
.pv-md :deep(p) { margin: 8px 0; }
.pv-md :deep(ul), .pv-md :deep(ol) { margin: 8px 0 8px 20px; }
.pv-md :deep(code) {
  font-family: var(--mono);
  font-size: 12px;
  background: var(--bg-elevated);
  padding: 1px 5px;
  border-radius: 4px;
}
.pv-md :deep(pre) {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  overflow-x: auto;
  margin: 10px 0;
}
.pv-md :deep(pre code) { background: transparent; padding: 0; }
.pv-md :deep(table) { border-collapse: collapse; margin: 10px 0; font-size: 12px; }
.pv-md :deep(th), .pv-md :deep(td) { border: 1px solid var(--border); padding: 5px 9px; }
.pv-md :deep(th) { background: var(--bg-elevated); }
.pv-md :deep(blockquote) {
  border-left: 3px solid var(--border-strong);
  padding-left: 10px;
  margin: 10px 0;
  color: var(--text-dim);
}
.pv-md :deep(a) { color: var(--accent); }

/* 代码：行号 gutter 40px + 等宽 12px；不换行，横向滚动由 .pv-body 承担 */
.pv-code { display: flex; align-items: flex-start; min-height: 100%; }
.code-gutter {
  position: sticky;
  left: 0;
  display: flex;
  flex-direction: column;
  min-width: 40px;
  padding: 10px 6px 10px 0;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  text-align: right;
  user-select: none;
}
.code-no {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 20px;
  color: var(--text-faint);
}
.code-pre {
  flex: 1;
  margin: 0;
  padding: 10px 12px;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 20px;
  color: var(--text);
  white-space: pre;
}
.code-pre code { font-family: inherit; }

/* 图片 */
.pv-image { padding: 14px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.pv-image img {
  max-width: 100%;
  height: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elevated);
}
.pv-image-meta { font-size: 11px; color: var(--text-faint); font-family: var(--mono); }

/* 状态卡（加载 / 错误 / 降级） */
.pv-state { padding: 20px 16px; text-align: center; font-size: 12px; color: var(--text-faint); }
.pv-state.error .pv-state-text { color: var(--red); }
.pv-state-text { margin: 6px 0; line-height: 1.6; word-break: break-all; }
.pv-err-ops { display: flex; gap: 8px; justify-content: center; margin-top: 10px; }
.pv-state-btn {
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elevated);
  color: var(--text-dim);
  font-size: 11.5px;
  cursor: pointer;
}
.pv-state-btn:hover { background: var(--bg-hover); color: var(--text); }
.pv-degrade-title { font-size: 13px; font-weight: 600; color: var(--text-dim); margin-bottom: 6px; }
.pv-meta-line { font-size: 11.5px; color: var(--text-faint); margin-top: 4px; }
.pv-meta-line.path { font-family: var(--mono); word-break: break-all; }
</style>
