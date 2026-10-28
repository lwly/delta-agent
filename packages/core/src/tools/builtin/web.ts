import { ok, fail, type AgentTool } from '../types.js';

// ── web_fetch ──────────────────────────────────────────────────────────────

/** Very small HTML -> text conversion (M1 scope; markdown conversion in M2+). */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const webFetchTool: AgentTool = {
  name: 'web_fetch',
  description: 'Fetch a web page over HTTP(S) and return its textual content.',
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
    },
    required: ['url'],
  },
  danger: 'safe',
  async execute(args, ctx) {
    const url = String(args.url ?? '');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return fail(`invalid url: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return fail(`unsupported protocol: ${parsed.protocol}`);
    }
    try {
      const res = await fetch(parsed, {
        signal: ctx.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'delta-agent/0.1' },
      });
      const contentType = res.headers.get('content-type') ?? '';
      const text = await res.text();
      if (!res.ok) return fail(`http ${res.status}: ${text.slice(0, 500)}`);
      const body = contentType.includes('html') ? htmlToText(text) : text;
      // E-3：抓取正文截断收紧（30k → 15k 字符），降低回灌上下文的 token 体积
      const capped = body.length > 15_000 ? body.slice(0, 15_000) + '\n...[truncated]' : body;
      return ok(`[${res.status} ${contentType}]\n${capped}`);
    } catch (e) {
      return fail(String((e as Error).message));
    }
  },
};

// ── todo_write ─────────────────────────────────────────────────────────────

export const todoWriteTool: AgentTool = {
  name: 'todo_write',
  description:
    'Maintain the task checklist for the current task. Pass the full list each time; statuses: pending/in_progress/done.',
  schema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  danger: 'safe',
  async execute(args, ctx) {
    const todos = args.todos;
    if (!Array.isArray(todos)) return fail('todos must be an array');
    ctx.todos.length = 0;
    for (const t of todos as Array<{ content: string; status: string }>) {
      const status = t.status === 'done' || t.status === 'in_progress' ? t.status : 'pending';
      ctx.todos.push({ content: String(t.content), status });
    }
    const lines = ctx.todos.map((t) => `- [${t.status === 'done' ? 'x' : ' '}] (${t.status}) ${t.content}`);
    return ok(lines.join('\n'));
  },
};

// ── ask_user ───────────────────────────────────────────────────────────────

export const askUserTool: AgentTool = {
  name: 'ask_user',
  description: 'Ask the user a clarifying question and block until they answer. Use sparingly.',
  schema: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' } },
    },
    required: ['question'],
  },
  danger: 'safe',
  async execute(args, ctx) {
    const question = String(args.question ?? '');
    if (!question) return fail('question is empty');
    const options = Array.isArray(args.options) ? (args.options as string[]).map(String) : undefined;
    try {
      const answer = await ctx.askUser(question, options);
      return ok(answer);
    } catch (e) {
      return fail(`ask_user failed: ${(e as Error).message}`);
    }
  },
};
