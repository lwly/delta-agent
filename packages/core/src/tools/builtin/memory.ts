/**
 * 记忆工具（memory-design.md §4/§5，F-06a）
 * save_memory / recall_memory —— 均标记 safe 免确认（内置工具 13 → 15）。
 * scope 由引擎注入（toolContext.sessionId/projectId），模型不接触 scope 细节。
 */
import { ok, fail, type AgentTool, type ToolContext } from '../types.js';

function scopeChain(ctx: ToolContext): string[] {
  const chain: string[] = ['global'];
  if (ctx.projectId) chain.push(`project:${ctx.projectId}`);
  if (ctx.sessionId) chain.push(`session:${ctx.sessionId}`);
  return chain;
}

export const saveMemoryTool: AgentTool = {
  name: 'save_memory',
  description:
    '保存长期记忆（用户偏好 / 事实 / 决策 / 坑点 / 工作流）。' +
    '当学到值得跨会话记住的内容时调用。每条记忆一句话；' +
    '自行评估重要度（0-1）与置信度（0-1）。',
  schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['preference', 'fact', 'decision', 'pitfall', 'workflow'],
        description: 'memory type',
      },
      content: { type: 'string', description: 'memory content, one sentence' },
      importance: { type: 'number', description: '0-1 self-assessed importance (default 0.5)' },
      confidence: { type: 'number', description: '0-1 confidence (default 0.8)' },
      keywords: { type: 'string', description: 'optional space-separated retrieval keywords' },
    },
    required: ['kind', 'content'],
  },
  danger: 'safe',
  async execute(args, ctx: ToolContext) {
    if (!ctx.memory) return fail('memory system unavailable');
    const content = String(args.content ?? '').trim();
    if (!content) return fail('content is required');
    try {
      // 工具显式保存 → 项目级（会话级属 L1 短期职责；无项目时退全局）
      const r = ctx.memory.save({
        scope: ctx.projectId ? `project:${ctx.projectId}` : 'global',
        kind: String(args.kind ?? 'fact'),
        content,
        importance: args.importance === undefined ? undefined : Number(args.importance),
        confidence: args.confidence === undefined ? undefined : Number(args.confidence),
        keywords: args.keywords === undefined ? undefined : String(args.keywords),
        source: 'tool',
      });
      const parts = [`✔ 已保存（${r.action === 'duplicate' ? '去重合并' : r.action === 'superseded' ? '新版本替换旧条' : '新建'}）`];
      if (r.evicted.length > 0) {
        parts.push(`配额淘汰 ${r.evicted.length} 条低价值旧记忆：${r.evicted.map((m) => m.content.slice(0, 30)).join(' / ')}`);
      }
      return ok(parts.join('\n'), { id: r.id, action: r.action });
    } catch (e) {
      return fail((e as Error).message);
    }
  },
};

export const recallMemoryTool: AgentTool = {
  name: 'recall_memory',
  description:
    '按查询检索相关的长期记忆（用户偏好、历史决策、坑点）。' +
    '返回得分最高的若干条匹配；当用户提及过往工作时请主动使用。',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'search query (natural language)' },
      topK: { type: 'number', description: 'max results (default 5)' },
    },
    required: ['query'],
  },
  danger: 'safe',
  async execute(args, ctx: ToolContext) {
    if (!ctx.memory) return fail('memory system unavailable');
    const query = String(args.query ?? '').trim();
    if (!query) return fail('query is required');
    const hits = ctx.memory.recall(query, scopeChain(ctx), Math.min(20, Math.max(1, Number(args.topK ?? 5))));
    if (hits.length === 0) return ok('（无相关记忆）');
    const lines = hits.map((h, i) =>
      `${i + 1}. [score ${h.score.toFixed(2)}] (${h.item.kind}) ${h.item.content}`,
    );
    return ok(lines.join('\n'), { count: hits.length });
  },
};
