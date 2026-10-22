/**
 * 记忆自动提炼（memory-design.md §4 双通道 / PRD 决议 #10）
 * 会话结束/压缩后用小模型从历史提炼 0-3 条候选 → 待确认队列（status='pending'），
 * Web 记忆面板一键采纳，避免记忆污染。默认开启可关（memory.autoDistill）。
 */
import type { LLMProvider } from '@y-zero/shared';
import type { MemoryStore } from './memory.js';
import type { MemoryProvider } from '../prompt/memory-provider.js';
import type { RecalledMemory } from '../prompt/types.js';

const DISTILL_SYSTEM = `你是记忆提炼器。从给定的对话历史中提炼值得跨会话长期保存的信息（用户偏好、关键决策、踩坑记录、工作流约定）。
严格输出 JSON 数组（不要 markdown 围栏），0-3 条，没有值得记的就输出 []：
[
  {"kind": "preference|fact|decision|pitfall|workflow", "content": "一句话记忆", "importance": 0.5, "confidence": 0.8}
]
要求：只记"以后还会用到"的信息；不要记一次性任务细节；content 必须自包含（脱离对话可读懂）。`;

export interface DistillResult {
  proposals: Array<{ kind: string; content: string; importance: number; confidence: number }>;
  saved: number;
}

/** 从会话历史提炼候选并落库为 pending。 */
export async function distillMemories(
  store: MemoryStore,
  provider: LLMProvider,
  model: string,
  opts: {
    scope: string;
    transcript: string;
    signal?: AbortSignal;
    max?: number;
  },
): Promise<DistillResult> {
  const transcript = opts.transcript.slice(-16_000); // 控制提炼输入体量
  if (!transcript.trim()) return { proposals: [], saved: 0 };
  let text = '';
  for await (const ev of provider.chat({
    messages: [
      { role: 'system', content: DISTILL_SYSTEM },
      { role: 'user', content: `<history>\n${transcript}\n</history>` },
    ],
    tools: [],
    model,
    maxTokens: 1024,
    signal: opts.signal,
  })) {
    if (ev.type === 'text_delta') text += ev.text;
    if (ev.type === 'error') throw new Error(`distill llm error: ${ev.message}`);
  }
  const proposals = parseProposals(text, opts.max ?? 3);
  let saved = 0;
  for (const p of proposals) {
    try {
      store.save({
        scope: opts.scope,
        kind: p.kind,
        content: p.content,
        importance: p.importance,
        confidence: Math.min(p.confidence, 0.7), // 提炼候选置信度封顶，采纳后可上调
        source: 'auto-distill',
        status: 'pending',
      });
      saved++;
    } catch {
      // 单条失败不影响其余
    }
  }
  return { proposals, saved };
}

function parseProposals(text: string, max: number): DistillResult['proposals'] {
  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = fenced ? fenced[1]! : text;
    const start = body.indexOf('[');
    const end = body.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    const raw = JSON.parse(body.slice(start, end + 1)) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .slice(0, max)
      .map((r) => r as { kind?: unknown; content?: unknown; importance?: unknown; confidence?: unknown })
      .filter((r) => typeof r.content === 'string' && r.content.trim())
      .map((r) => ({
        kind: typeof r.kind === 'string' ? r.kind : 'fact',
        content: (r.content as string).trim(),
        importance: clamp01(r.importance, 0.5),
        confidence: clamp01(r.confidence, 0.6),
      }));
  } catch {
    return [];
  }
}

function clamp01(v: unknown, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : dflt;
}

// ── Prompt 接入：L2 动态记忆 → MemoryProvider（memory-design §7 动态段）──────

/** L2 记忆召回适配器：给 SplitPromptAssembler 的动态段注入 Top-K。 */
export function createMemoryProvider(store: MemoryStore, scopes: string[]): MemoryProvider {
  return {
    async recall(query): Promise<RecalledMemory[]> {
      try {
        const hits = store.recall(query.query, scopes, query.topK ?? 5);
        return hits.map((h) => ({
          id: h.item.id,
          content: h.item.content,
          score: h.score,
          source: 'l2' as const,
        }));
      } catch {
        return []; // 接口约定：不抛异常
      }
    },
  };
}
