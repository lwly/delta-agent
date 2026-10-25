import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';
import 'highlight.js/styles/github-dark.css'; // 深色主题，与工作台设计系统一致

/** 输入端隐形 Markdown 支持（technical-design §3.5）：渲染端 markdown-it + highlight.js + DOMPurify */
const md = new MarkdownIt({
  html: false, // DOMPurify 前禁用内嵌 HTML，防注入
  linkify: true,
  breaks: true,
  highlight(code: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre><code class="hljs language-${lang}">${hljs.highlight(code, { language: lang }).value}</code></pre>`;
      } catch {
        // fallthrough
      }
    }
    return `<pre><code class="hljs">${md.utils.escapeHtml(code)}</code></pre>`;
  },
});

/** 消息内容 → 消毒后的 HTML */
export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(md.render(text));
}

/**
 * F-38 文件预览：代码文本 → 高亮后的 HTML 片段（与消息流同一条 DOMPurify 消毒链路）。
 *
 * - 语言标识不合法 / hljs 未收录 → 纯转义文本（仍走消毒，绝不直出原文）
 * - 返回的是 `<span class="hljs-…">` 片段，**不含** `<pre>` / `<code>`：
 *   包裹层与行号 gutter 由 FilePreview.vue 负责（保证只读、可横向滚动的排版）
 * - 调用方必须用 `v-html` 渲染本函数的结果，且**不得**把文件原文直接交给 v-html
 */
export function renderCode(text: string, lang?: string): string {
  const language = lang && hljs.getLanguage(lang) ? lang : '';
  let escaped: string;
  if (!language) {
    escaped = md.utils.escapeHtml(text);
  } else {
    try {
      escaped = hljs.highlight(text, { language }).value;
    } catch {
      escaped = md.utils.escapeHtml(text);
    }
  }
  return DOMPurify.sanitize(escaped);
}
