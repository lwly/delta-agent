/**
 * F-49 会话分享导出：把会话导出为自包含只读 HTML 或 Markdown（纯本地生成，不联网）。
 *
 * - AC-49-1 HTML 单文件自包含：内联 CSS，无外链脚本/样式；
 * - AC-49-2 渲染口径与会话回放页一致：按 user 消息切任务边界（对齐 getRuns）、
 *   工具调用与结果按 callId 配对（对齐 getRunTimeline）、含 per-model 用量（对齐 F-31 口径）；
 * - AC-49-3 默认脱敏：导出前扫描配置类字段（API key / token / 私钥 / 环境变量凭证等），
 *   命中即替换为 [REDACTED] 并计数告警；不做网络请求；
 * - AC-49-5 消息按 seq 分页读取、按任务分块产出（write 回调逐块写出），
 *   内存中同时只驻留单个任务的步骤，大会话（>2000 消息）流式渲染不爆内存。
 *   （脱敏计数遍历后才知道，故告警注记放在文档尾部。）
 */
import type { ChatMessage } from '@delta/shared';
import type { SessionService, RunTimeline } from './service.js';
import type { SessionRow } from './store.js';

export type ExportFormat = 'html' | 'md';

/** 脱敏计数（按命中类别聚合，导出方据此告警） */
export interface ExportRedaction {
  kind: string;
  count: number;
}

export interface ExportMeta {
  session: SessionRow;
  /** 实际导出的消息条数 */
  messageCount: number;
  runCount: number;
  generatedAt: string;
  redactions: ExportRedaction[];
}

export interface ExportOptions {
  format: ExportFormat;
  /** 脱敏开关，默认 true（AC-49-3 默认脱敏） */
  redact?: boolean;
}

/** 每个任务（run）的导出中间态（步骤类型与 RunTimeline.steps 同构，内容已脱敏） */
interface ExportRun {
  index: number;
  startedAt: string;
  endedAt: string;
  steps: RunTimeline['steps'];
}

type ToolStep = Extract<RunTimeline['steps'][number], { type: 'tool_call' }>;

// ── 脱敏（AC-49-3）────────────────────────────────────────────────────────

/** JSON 对象/工具参数中按字段名判定的配置类键 */
const SENSITIVE_KEY_RE =
  /api[-_]?key|apikey|secret|token|password|passwd|authorization|credential|private[-_]?key|access[-_]?key/i;

const REDACTED = '[REDACTED]';

/** 自由文本中的凭证形态（命中即替换；sub 可保留变量名等局部结构） */
const TEXT_PATTERNS: Array<{
  kind: string;
  re: RegExp;
  sub?: (m: RegExpExecArray) => string;
}> = [
  { kind: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'API 密钥（sk-）', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'AWS AccessKeyId', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'GitHub Token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'Slack Token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'Bearer 凭证', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi },
  {
    kind: '环境变量凭证',
    re: /\b([A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS?))\s*[=:]\s*("[^"\n]*"|'[^'\n]*'|[^\s,;}"']+)/g,
    sub: (m) => `${m[1]}=[REDACTED]`,
  },
];

/** 对一段自由文本做模式脱敏，命中计数累入 counts */
function redactText(text: string, counts: Map<string, number>): string {
  let out = text;
  for (const { kind, re, sub } of TEXT_PATTERNS) {
    out = out.replace(re, (...args: unknown[]) => {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      return sub ? sub(args as unknown as RegExpExecArray) : REDACTED;
    });
  }
  return out;
}

/** 递归脱敏 JSON 值：敏感字段名的字符串值整体替换 */
function redactJson(value: unknown, key: string | null, counts: Map<string, number>): unknown {
  if (key !== null && SENSITIVE_KEY_RE.test(key) && typeof value === 'string' && value) {
    const kind = `配置字段（${key}）`;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    return REDACTED;
  }
  if (Array.isArray(value)) return value.map((v) => redactJson(v, null, counts));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactJson(v, k, counts);
    return out;
  }
  return value;
}

/**
 * 工具参数脱敏：可解析为 JSON 则走字段名判定后原样序列化（保留结构，渲染口径与回放页一致）；
 * 不可解析则退化为纯文本模式脱敏。
 */
function redactArgs(argsJson: string, counts: Map<string, number>): string {
  if (!argsJson.trim()) return argsJson;
  try {
    return JSON.stringify(redactJson(JSON.parse(argsJson), null, counts));
  } catch {
    return redactText(argsJson, counts);
  }
}

// ── 用量（对齐 F-31 口径：空 model 归「未知」，snake_case）────────────────

export interface ExportUsageRow {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  turns: number;
}

export interface ExportUsage {
  rows: ExportUsageRow[];
  totals: { input_tokens: number; output_tokens: number; cost_usd: number; turns: number };
}

function usageForSession(service: SessionService, sessionId: string): ExportUsage {
  const rows = service.store.db
    .prepare(
      `SELECT COALESCE(NULLIF(model, ''), '未知')      AS model,
              COALESCE(SUM(input_tokens), 0)          AS input_tokens,
              COALESCE(SUM(output_tokens), 0)         AS output_tokens,
              COALESCE(SUM(cost_usd), 0)              AS cost_usd,
              COUNT(*)                                AS turns
       FROM usage WHERE session_id = ? GROUP BY model ORDER BY cost_usd DESC`,
    )
    .all(sessionId) as ExportUsageRow[];
  const totals = rows.reduce(
    (acc, r) => ({
      input_tokens: acc.input_tokens + r.input_tokens,
      output_tokens: acc.output_tokens + r.output_tokens,
      cost_usd: acc.cost_usd + r.cost_usd,
      turns: acc.turns + r.turns,
    }),
    { input_tokens: 0, output_tokens: 0, cost_usd: 0, turns: 0 },
  );
  return { rows, totals };
}

// ── 分页遍历器（任务边界/时间线语义对齐 getRuns/getRunTimeline）──────────

/** 消息分页大小：导出器每次从 SQLite 取这么多条，逐任务消费 */
export const EXPORT_PAGE_SIZE = 200;

/**
 * 流式遍历会话消息，每当一个任务收口（下一条 user 消息出现或遍历结束）即回调 onRun。
 * 返回实际遍历的消息条数。内存中同时只驻留单个任务的步骤。
 */
function streamRuns(
  service: SessionService,
  sessionId: string,
  opts: { doRedact: boolean; counts: Map<string, number> },
  onRun: (run: ExportRun) => void,
): number {
  const { doRedact, counts } = opts;
  const text = (m: ChatMessage) => (doRedact ? redactText(m.content, counts) : m.content);
  const args = (a: string) => (doRedact ? redactArgs(a, counts) : a);

  let current: ExportRun | null = null;
  let runCount = 0;
  let pendingCalls = new Map<string, ToolStep>();
  let afterSeq = 0;
  let messageCount = 0;

  const flush = () => {
    if (current) onRun(current);
    current = null;
  };

  for (;;) {
    const page = service.store.getMessagesDetailedPage(sessionId, afterSeq, EXPORT_PAGE_SIZE);
    if (page.length === 0) break;
    for (const { seq, message: m, at } of page) {
      afterSeq = seq;
      messageCount++;
      if (m.role === 'user') {
        // 任务边界：每条 user 消息开启一次任务（对齐 getRuns）；前一个任务在此收口写出
        flush();
        current = { index: runCount++, startedAt: at, endedAt: at, steps: [] };
        pendingCalls = new Map();
        current.steps.push({ type: 'user', at, text: text(m) });
        continue;
      }
      if (!current) continue; // 无 user 开头的游离消息（不属任何任务，与 getRuns 口径一致）
      current.endedAt = at;
      if (m.role === 'assistant') {
        if (m.content.trim()) {
          current.steps.push({ type: 'assistant', at, text: text(m) });
        }
        for (const c of m.toolCalls ?? []) {
          const step: ToolStep = { type: 'tool_call', at, name: c.name, argsJson: args(c.argsJson) };
          current.steps.push(step);
          if (c.id) pendingCalls.set(c.id, step);
        }
      } else if (m.role === 'tool') {
        const call = m.toolCallId ? pendingCalls.get(m.toolCallId) : undefined;
        let ok = true;
        try {
          ok = (JSON.parse(m.content) as { ok?: boolean }).ok !== false;
        } catch {
          /* 非 JSON 结果默认 ok */
        }
        const result = { ok, content: text(m), at };
        if (call) call.result = result;
        else current.steps.push({ type: 'tool_call', at, name: 'tool', argsJson: '', result });
      }
    }
    if (page.length < EXPORT_PAGE_SIZE) break;
  }
  flush();
  return messageCount;
}

// ── 渲染辅助 ──────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function argsPretty(json: string): string {
  if (!json.trim()) return '';
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

/** Markdown 围栏：取正文中最长的反引号串 +1（下限 3），避免内容提前闭合围栏 */
function mdFence(text: string): string {
  let max = 0;
  for (const m of text.matchAll(/`+/g)) max = Math.max(max, m[0].length);
  return '`'.repeat(Math.max(3, max + 1));
}

function mdBlock(text: string): string {
  const f = mdFence(text);
  return `${f}\n${text}\n${f}`;
}

function num(x: number): string {
  return x.toLocaleString('en-US');
}

function redactionBanner(redactions: ExportRedaction[]): string {
  const total = redactions.reduce((s, r) => s + r.count, 0);
  return `剔除 ${total} 处配置类字段（${redactions.map((r) => `${r.kind}×${r.count}`).join('、')}）`;
}

// ── HTML 渲染（单文件自包含，AC-49-1）────────────────────────────────────

const HTML_STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         margin: 0 auto; max-width: 860px; padding: 24px 16px 64px; line-height: 1.6; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  h2 { font-size: 1.1rem; margin: 28px 0 8px; border-bottom: 1px solid #ddd6; padding-bottom: 4px; }
  .muted { color: #888; font-size: .85rem; }
  table { border-collapse: collapse; font-size: .85rem; margin: 8px 0; }
  th, td { border: 1px solid #ddd6; padding: 3px 10px; text-align: left; }
  .notice { background: #fff7e6; border: 1px solid #f0c060; border-radius: 6px;
            padding: 8px 12px; font-size: .85rem; margin: 12px 0; }
  .step { margin: 10px 0; }
  .who { font-weight: 600; margin-right: 8px; }
  .at { color: #999; font-size: .78rem; }
  pre { background: #f5f5f5; border-radius: 6px; padding: 10px 12px; overflow-x: auto;
        white-space: pre-wrap; word-break: break-word; margin: 6px 0; font-size: .84rem; }
  details.step { border: 1px solid #ddd6; border-radius: 6px; padding: 6px 10px; }
  details.step summary { cursor: pointer; font-weight: 600; }
  .step.user pre { background: #eef4ff; }
  .step.assistant pre { background: #f2fbf2; }
  .result.err pre { background: #fdeeee; }
  .run-meta { color: #999; font-size: .8rem; }
  footer { margin-top: 40px; color: #aaa; font-size: .78rem; }
  @media (prefers-color-scheme: dark) {
    pre { background: #1e1e1e; }
    .step.user pre { background: #1a2740; }
    .step.assistant pre { background: #17281c; }
    .result.err pre { background: #3a1d1d; }
    h2 { border-color: #5556; }
    th, td, details.step { border-color: #5556; }
    .notice { background: #3a2f10; border-color: #8a6d1a; }
  }
`;

function renderHtmlHeader(meta: ExportMeta, usage: ExportUsage): string {
  const s = meta.session;
  const usageRows = usage.rows
    .map(
      (r) =>
        `<tr><td>${esc(r.model)}</td><td>${num(r.input_tokens)}</td><td>${num(r.output_tokens)}</td><td>${r.cost_usd.toFixed(4)}</td><td>${r.turns}</td></tr>`,
    )
    .join('\n');
  const usageSection = usage.rows.length
    ? `<h2>用量（F-31 口径）</h2>
<table><tr><th>模型</th><th>输入 tokens</th><th>输出 tokens</th><th>费用 (USD)</th><th>轮次</th></tr>
${usageRows}
<tr><td><strong>合计</strong></td><td>${num(usage.totals.input_tokens)}</td><td>${num(usage.totals.output_tokens)}</td><td>${usage.totals.cost_usd.toFixed(4)}</td><td>${usage.totals.turns}</td></tr></table>`
    : '<p class="muted">（本会话无用量记录）</p>';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>会话导出：${esc(s.title)}</title>
<style>${HTML_STYLE}</style>
</head>
<body>
<h1>会话导出：${esc(s.title)}</h1>
<p class="muted">会话 ${esc(s.id)} · 模型 ${esc(s.model)} · 模式 ${esc(s.mode)} · ${meta.messageCount} 条消息 · ${meta.runCount} 个任务 · 导出于 ${esc(meta.generatedAt)}（只读快照，纯本地生成）</p>
${usageSection}
`;
}

function renderHtmlRun(run: ExportRun): string {
  const steps = run.steps
    .map((s) => {
      if (s.type === 'user') {
        return `<div class="step user"><span class="who">👤 用户</span><span class="at">${esc(s.at)}</span><pre>${esc(s.text)}</pre></div>`;
      }
      if (s.type === 'assistant') {
        return `<div class="step assistant"><span class="who">🤖 助手</span><span class="at">${esc(s.at)}</span><pre>${esc(s.text)}</pre></div>`;
      }
      const status = s.result ? (s.result.ok ? '✔' : '✘') : '…';
      const result = s.result
        ? `<div class="result ${s.result.ok ? 'ok' : 'err'}"><span class="muted">结果</span><pre>${esc(s.result.content)}</pre></div>`
        : '';
      return `<details class="step tool"><summary>🔧 ${esc(s.name)} ${status} <span class="at">${esc(s.at)}</span></summary><pre>${esc(argsPretty(s.argsJson))}</pre>${result}</details>`;
    })
    .join('\n');
  const first = run.steps[0]?.type === 'user' ? (run.steps[0] as { text: string }).text : '';
  return `<h2>任务 ${run.index + 1}：${esc(first.slice(0, 60)) || '（无用户输入）'}</h2>
<p class="run-meta">${esc(run.startedAt)} → ${esc(run.endedAt)}</p>
${steps}`;
}

function renderHtmlFooter(meta: ExportMeta): string {
  const notice = meta.redactions.length
    ? `<div class="notice">🔒 默认脱敏已启用：${esc(redactionBanner(meta.redactions))}。</div>\n`
    : '';
  return `\n${notice}<footer>由 delta export 生成 · ${esc(meta.generatedAt)} · 本文件自包含，可直接在浏览器打开（只读快照）</footer>\n</body>\n</html>\n`;
}

// ── Markdown 渲染 ────────────────────────────────────────────────────────

function renderMdHeader(meta: ExportMeta, usage: ExportUsage): string {
  const s = meta.session;
  const lines: string[] = [
    `# 会话导出：${s.title}`,
    '',
    `- 会话 ID：\`${s.id}\``,
    `- 模型：${s.model} · 模式：${s.mode}`,
    `- 消息 ${meta.messageCount} 条 · 任务 ${meta.runCount} 个`,
    `- 导出时间：${meta.generatedAt}（只读快照，纯本地生成）`,
    '',
  ];
  if (usage.rows.length) {
    lines.push(
      '## 用量（F-31 口径）',
      '',
      '| 模型 | 输入 tokens | 输出 tokens | 费用 (USD) | 轮次 |',
      '|---|---|---|---|---|',
    );
    for (const r of usage.rows) {
      lines.push(`| ${r.model} | ${r.input_tokens} | ${r.output_tokens} | ${r.cost_usd.toFixed(4)} | ${r.turns} |`);
    }
    lines.push(
      `| **合计** | ${usage.totals.input_tokens} | ${usage.totals.output_tokens} | ${usage.totals.cost_usd.toFixed(4)} | ${usage.totals.turns} |`,
      '',
    );
  }
  return lines.join('\n');
}

function renderMdRun(run: ExportRun): string {
  const first = run.steps[0]?.type === 'user' ? (run.steps[0] as { text: string }).text : '';
  const lines: string[] = [
    `## 任务 ${run.index + 1}：${(first.slice(0, 60) || '（无用户输入）').replace(/\n/g, ' ')}`,
    '',
    `_${run.startedAt} → ${run.endedAt}_`,
    '',
  ];
  for (const s of run.steps) {
    if (s.type === 'user') {
      lines.push(`**👤 用户** · ${s.at}`, '', mdBlock(s.text), '');
    } else if (s.type === 'assistant') {
      lines.push(`**🤖 助手** · ${s.at}`, '', mdBlock(s.text), '');
    } else {
      lines.push(`**🔧 ${s.name}** ${s.result ? (s.result.ok ? '✔' : '✘') : '…'} · ${s.at}`);
      if (s.argsJson.trim()) lines.push('', '参数：', mdBlock(argsPretty(s.argsJson)));
      if (s.result) lines.push('', `结果（${s.result.ok ? '成功' : '失败'}）：`, mdBlock(s.result.content));
      lines.push('');
    }
  }
  return lines.join('\n');
}

function renderMdFooter(meta: ExportMeta): string {
  const notice = meta.redactions.length
    ? `> 🔒 默认脱敏已启用：${redactionBanner(meta.redactions)}。\n`
    : '';
  return `\n${notice}\n---\n\n由 delta export 生成 · ${meta.generatedAt}\n`;
}

// ── 导出入口 ──────────────────────────────────────────────────────────────

/**
 * 导出会话：头部/用量 → 逐任务 → 尾部（含脱敏告警）按块写到 write 回调（流式，AC-49-5），
 * 完成后返回导出元数据（含脱敏告警，AC-49-3）。会话不存在时抛错。
 */
export async function exportSession(
  service: SessionService,
  sessionId: string,
  opts: ExportOptions,
  write: (chunk: string) => void,
): Promise<ExportMeta> {
  const session = service.getSession(sessionId);
  if (!session) throw new Error('session not found');

  // 预聚合计数（SQL 完成，不载入消息）：任务数 = user 消息数（对齐 getRuns：每条 user 消息开启一次任务）
  const c = service.store.db
    .prepare(`SELECT COUNT(*) AS messages, COALESCE(SUM(role = 'user'), 0) AS runs FROM messages WHERE session_id = ?`)
    .get(sessionId) as { messages: number; runs: number };
  const usage = usageForSession(service, sessionId);
  const meta: ExportMeta = {
    session,
    messageCount: c.messages,
    runCount: c.runs,
    generatedAt: new Date().toISOString(),
    redactions: [],
  };

  const counts = new Map<string, number>();
  const doRedact = opts.redact !== false;
  const onRun = opts.format === 'html' ? (run: ExportRun) => write(renderHtmlRun(run) + '\n') : (run: ExportRun) => write(renderMdRun(run));

  if (opts.format === 'html') write(renderHtmlHeader(meta, usage));
  else write(renderMdHeader(meta, usage));
  meta.messageCount = streamRuns(service, sessionId, { doRedact, counts }, onRun);
  if (meta.runCount === 0) {
    write(opts.format === 'html' ? '<p class="muted">（本会话暂无任务记录）</p>\n' : '（本会话暂无任务记录）\n');
  }
  meta.redactions = [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count);
  if (opts.format === 'html') write(renderHtmlFooter(meta));
  else write(renderMdFooter(meta));
  return meta;
}
