import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';
import 'highlight.js/styles/github.css';

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
