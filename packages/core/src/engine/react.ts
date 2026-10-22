import type {
  AgentEvent,
  ChatMessage,
  LLMProvider,
  ToolCall,
  Usage,
} from '@y-zero/shared';
import { estimateMessagesTokens } from '../context/tokens.js';
import { BudgetManager } from '../context/budget.js';
import { compact, shouldCompact, type CompressorDeps } from '../context/compressor.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';

export interface RunContext {
  sessionId: string;
  projectId: string;
  mode: 'react' | 'plan-execute' | 'multi-agent';
  model: string;
  systemPrompt: string;
  /**
   * M3：静态/动态分段系统提示词（优先于 systemPrompt 单串）。
   * 引擎按 静态→动态→历史→本轮 恒定顺序拼装，保证 Provider 前缀缓存命中。
   */
  systemPromptParts?: { staticText: string; dynamicText: string };
  /**
   * M3：每轮动态段提供器（如刷新时间戳、记忆重召回）。
   * 提供时优先于 systemPromptParts.dynamicText，静态段仍取 systemPromptParts.staticText。
   */
  dynamicProvider?: (turn: number) => string;
  maxTurns: number; // default 50
  signal: AbortSignal;
  provider: LLMProvider;
  registry: ToolRegistry;
  toolContext: ToolContext;
  budget: BudgetManager;
  /** model context window in tokens (for compaction trigger) */
  windowTokens: number;
  /** retry limit for transient LLM failures */
  maxRetries?: number;
}

const COMPACT_SUMMARY_PROMPT = `你是对话压缩器。请把给定的历史对话与既有摘要合并为一份结构化滚动摘要，包含以下小节（无则省略）：
## 任务目标
## 已完成步骤
## 关键决策与事实
## 当前状态
## 遗留问题
要求：信息密度优先，不重复既有摘要内容，不超过 800 字。`;

/**
 * ReAct main loop (PRD F-01).
 * Thought/Action/Observation cycle with budget guard, auto-compaction,
 * self-healing retries and abort propagation.
 */
export async function* runReAct(
  ctx: RunContext,
  history: ChatMessage[],
  userInput: string,
): AsyncIterable<AgentEvent> {
  const messages: ChatMessage[] = [...history];
  push(messages, { role: 'user', content: userInput });

  const maxTurns = ctx.maxTurns || 50;
  const maxRetries = ctx.maxRetries ?? 3;
  const toolFailures = new Map<string, number>();
  const usageTotal: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let prevSummary = '';

  try {
    for (let turn = 1; turn <= maxTurns && !ctx.signal.aborted; turn++) {
      yield { type: 'turn_start', turn };

      // ── budget guard (before LLM call) ──
      const guard = ctx.budget.guard();
      if (guard.exceeded) {
        const summary = ctx.budget.summarize();
        yield { type: 'budget_exhausted', summary };
        return;
      }
      if (ctx.budget.shouldWarn()) {
        yield { type: 'budget_warning', usedPct: Math.max(guard.usedTokenPct, guard.usedCostPct) };
      }

      // ── auto compaction (80% trigger / 55% target) ──
      const compressDeps: CompressorDeps = {
        windowTokens: ctx.windowTokens,
        summarize: async (prev, transcript) => {
          const sumMessages: ChatMessage[] = [
            { role: 'system', content: COMPACT_SUMMARY_PROMPT },
            {
              role: 'user',
              content: `<existing_summary>\n${prev || '（无）'}\n</existing_summary>\n<history>\n${transcript}\n</history>`,
            },
          ];
          let text = '';
          for await (const ev of ctx.provider.chat({
            messages: sumMessages,
            tools: [],
            model: ctx.model,
            maxTokens: 2048,
          })) {
            if (ev.type === 'text_delta') text += ev.text;
            if (ev.type === 'error') throw new Error(ev.message);
          }
          return text.trim() || prev;
        },
      };

      if (shouldCompact(messages, compressDeps)) {
        yield { type: 'compact_start' };
        const before = estimateMessagesTokens(messages);
        const result = await compact(messages, prevSummary, compressDeps);
        messages.length = 0;
        messages.push(...result.messages);
        prevSummary = result.summary;
        yield { type: 'compact_done', beforeTokens: before, afterTokens: result.afterTokens };
      }

      // ── LLM round-trip (SSE, with retries, streaming deltas) ──
      let round: { text: string; toolCalls: ToolCall[]; usage: Usage } | undefined;
      for await (const item of chatStream(ctx, messages, turn)) {
        if (item.kind === 'delta') {
          if (item.ev.type === 'text_delta') yield { type: 'text_delta', text: item.ev.text };
          else if (item.ev.type === 'thinking_delta') yield { type: 'thinking_delta', text: item.ev.text };
        } else {
          round = item.result;
        }
      }
      if (!round) throw new Error('llm stream produced no result');
      const { text, toolCalls, usage } = round;
      ctx.budget.record(usage);
      usageTotal.inputTokens += usage.inputTokens;
      usageTotal.outputTokens += usage.outputTokens;
      usageTotal.costUsd = (usageTotal.costUsd ?? 0) + (usage.costUsd ?? 0);
      yield { type: 'usage', usage };

      if (toolCalls.length === 0) {
        // terminal answer
        const finalMsg: ChatMessage = { role: 'assistant', content: text };
        finalMsg.tokens = ctx.provider.estimateTokens([finalMsg]);
        push(messages, finalMsg);
        return;
      }

      // assistant turn requesting tools
      const assistantMsg: ChatMessage = { role: 'assistant', content: text, toolCalls };
      assistantMsg.tokens = ctx.provider.estimateTokens([assistantMsg]);
      push(messages, assistantMsg);
      for (const call of toolCalls) {
        yield { type: 'tool_call_start', call };
      }

      // ── tools (parallel inside registry) ──
      const results = await ctx.registry.executeAll(toolCalls, ctx.toolContext);
      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        result.callId = toolCalls[i]!.id;
        result.name = toolCalls[i]!.name;
        const ms = 0; // timing handled by registry callers if needed
        yield { type: 'tool_result', call: toolCalls[i]!, result, ms };
        const msg: ChatMessage = {
          role: 'tool',
          content: result.content,
          toolCallId: toolCalls[i]!.id,
        };
        msg.tokens = ctx.provider.estimateTokens([msg]);
        push(messages, msg);

        // circuit breaker: same tool failing >=3 times in a row
        if (!result.ok) {
          const n = (toolFailures.get(toolCalls[i]!.name) ?? 0) + 1;
          toolFailures.set(toolCalls[i]!.name, n);
          if (n >= 3) {
            const note: ChatMessage = {
              role: 'user',
              content: `（系统提示：工具 ${toolCalls[i]!.name} 已连续失败 ${n} 次，本轮请换一种思路，不要立即重复同一调用）`,
            };
            note.tokens = ctx.provider.estimateTokens([note]);
            push(messages, note);
            toolFailures.set(toolCalls[i]!.name, 0);
          }
        } else {
          toolFailures.set(toolCalls[i]!.name, 0);
        }
      }
      // ctx.turn++ handled by for-loop
    }

    // maxTurns exhausted
    const note: ChatMessage = { role: 'user', content: '（已达最大轮次上限，请直接总结当前进展并给出结论）' };
    push(messages, note);
    yield { type: 'error', message: `reached max turns (${maxTurns})`, fatal: false };
  } catch (e) {
    const err = e as Error;
    if (ctx.signal.aborted) {
      yield { type: 'error', message: 'aborted by user', fatal: false };
    } else {
      yield { type: 'error', message: err.message, fatal: true };
    }
  } finally {
    yield { type: 'done', usage: usageTotal };
  }
}

/** push with token estimate attached */
function push(messages: ChatMessage[], m: ChatMessage): void {
  if (m.tokens === undefined) {
    m.tokens = 4 + estimateTokensText(m.content);
  }
  messages.push(m);
}

function estimateTokensText(text: string): number {
  const cjk = (text.match(/[\u3200-\u9FFF\uF900-\uFAFF]/g) ?? []).length;
  return cjk + Math.ceil((text.length - cjk) / 3);
}

/** 系统消息内容：每轮动态注入 > 静态/动态分段 > 单串 systemPrompt */
function systemContent(ctx: RunContext, turn: number): string {
  if (ctx.dynamicProvider) {
    return [ctx.systemPromptParts?.staticText ?? ctx.systemPrompt, ctx.dynamicProvider(turn)]
      .filter((t) => t.length > 0)
      .join('\n\n');
  }
  if (ctx.systemPromptParts) {
    return [ctx.systemPromptParts.staticText, ctx.systemPromptParts.dynamicText]
      .filter((t) => t.length > 0)
      .join('\n\n');
  }
  return ctx.systemPrompt;
}

type StreamItem =
  | { kind: 'delta'; ev: { type: 'text_delta' | 'thinking_delta'; text: string } }
  | { kind: 'result'; result: { text: string; toolCalls: ToolCall[]; usage: Usage } };

/** One chat round-trip as a stream: yields UI deltas, ends with the result. */
async function* chatStream(
  ctx: RunContext,
  messages: ChatMessage[],
  turn: number,
): AsyncGenerator<StreamItem> {
  const { ToolCallAccumulator } = await import('../llm/accumulator.js');
  const maxRetries = ctx.maxRetries ?? 3;
  let lastError = '';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (ctx.signal.aborted) throw new Error('aborted by user');
    if (attempt > 0) {
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000), ctx.signal);
    }
    const acc = new ToolCallAccumulator();
    let text = '';
    let usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    let streamError = '';
    let retriable = false;

    try {
      for await (const ev of ctx.provider.chat({
        messages: [{ role: 'system', content: systemContent(ctx, turn) }, ...messages],
        tools: ctx.registry.definitions(),
        model: ctx.model,
        signal: ctx.signal,
      })) {
        switch (ev.type) {
          case 'text_delta':
            text += ev.text;
            yield { kind: 'delta', ev };
            break;
          case 'thinking_delta':
            yield { kind: 'delta', ev };
            break;
          case 'tool_call_delta':
            acc.ingest(ev);
            break;
          case 'usage':
            if (ev.input) usage.inputTokens = ev.input;
            if (ev.output) usage.outputTokens += ev.output;
            break;
          case 'error':
            streamError = ev.message;
            retriable = ev.retriable;
            break;
          case 'done':
            break;
          default:
            break;
        }
      }
    } catch (e) {
      streamError = (e as Error).message;
      retriable = true;
    }

    if (streamError && !text && !acc.hasAny()) {
      lastError = streamError;
      if (retriable && attempt < maxRetries) continue;
      throw new Error(`llm stream failed: ${streamError}`);
    }

    const toolCalls = acc.hasAny() ? acc.finalize() : [];
    yield { kind: 'result', result: { text, toolCalls, usage } };
    return;
  }
  throw new Error(`llm stream failed after ${maxRetries} retries: ${lastError}`);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted by user'));
      },
      { once: true },
    );
  });
}
