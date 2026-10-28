import type {
  AgentEvent,
  ChatMessage,
  LLMProvider,
  MessageImage,
  ToolCall,
  Usage,
} from '@delta/shared';
import { estimateMessagesTokens } from '../context/tokens.js';
import { BudgetManager } from '../context/budget.js';
import { compact, shouldCompact, type CompressorDeps } from '../context/compressor.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';
import type { RegistryLike } from './roles.js';
import { sanitizeHistory } from '../llm/sanitize.js';
import { computeCostUsd } from '../llm/pricing.js';

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
  /** M5: 允许受限视图（Worker Pool 角色白名单） */
  registry: ToolRegistry | RegistryLike;
  toolContext: ToolContext;
  budget: BudgetManager;
  /**
   * 方案 D：预算耗尽降级续跑（缺省 false = 保持硬停 + budget_exhausted 事件，headless 退出码 4 协议不变）。
   * 开启时（Web serve 链路）到 100% 不终止：禁用 task/子代理、单轮 maxTokens 降到 1024、主循环继续，
   * 并发出一次 budget_degraded 事件（UI 据此展示「追加预算继续」）。
   */
  budgetDegrade?: boolean;
  /** model context window in tokens (for compaction trigger) */
  windowTokens: number;
  /** retry limit for transient LLM failures */
  maxRetries?: number;
  /** M5: Plan/Multi-Agent 编排参数（agent-modes-design §3/§5） */
  plan?: PlanOptions;
  /** M5: 任务持久化（状态落库 + 租约心跳 + 崩溃恢复）；缺省 = 仅内存编排 */
  tasks?: import('../session/tasks.js').TaskStore;
  /**
   * F-14 计划确认流：规划产出后等待用户决策（approve / edit / reject）。
   * 缺省 = 自动批准（非交互环境 / 测试兼容）。
   */
  planApproval?: (req: import('@delta/shared').PlanApprovalRequest) => Promise<import('@delta/shared').PlanDecision>;
}

/** M5 编排参数 */
export interface PlanOptions {
  /** Worker Pool 并发（默认 min(4, 并行度)，可配 1-8） */
  workerCount?: number;
  /** 子任务单次最大轮数（默认 15） */
  maxSubTurns?: number;
  /** Reviewer 打回重试上限（默认 2） */
  maxReviewRetries?: number;
  /** 用户强制：plan=强制规划，direct=强制直达（/plan /direct） */
  force?: 'plan' | 'direct';
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
  images?: MessageImage[],
): AsyncIterable<AgentEvent> {
  // 历史完整性修复：丢弃悬空 tool_calls / 孤儿 tool 消息（中断留下的断裂历史会被网关 400）
  const messages: ChatMessage[] = sanitizeHistory(history);
  const first: ChatMessage = { role: 'user', content: userInput };
  if (images && images.length > 0) first.images = images; // F-25 多模态附件
  push(messages, first);

  const maxTurns = ctx.maxTurns || 50;
  const maxRetries = ctx.maxRetries ?? 3;
  const toolFailures = new Map<string, number>();
  const usageTotal: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  /** 方案 B：子代理（task 工具 meta.usage）派生次数，随 done 事件上报供 UI 标注 */
  let subagentCount = 0;
  /** 方案 D：是否已进入降级续跑（一次性转换，降级后 guard 不再硬停） */
  let degraded = false;
  let prevSummary = '';

  /**
   * 收尾总结轮（反馈：预算耗尽戛然而止，用户拿不到任何结果）：
   * 强制一次无工具的纯文本调用（maxTokens 封顶，不再产生工具消耗），
   * 把已完成的工作总结成结论。调用失败/中止时静默——耗尽语义不变，只是少了总结。
   */
  const wrapUp = async function* (noteText: string, turnNo: number): AsyncGenerator<AgentEvent> {
    if (ctx.signal.aborted) return;
    const note: ChatMessage = { role: 'user', content: noteText };
    push(messages, note);
    const usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    try {
      for await (const ev of ctx.provider.chat({
        messages: [{ role: 'system', content: systemContent(ctx, turnNo) }, ...messages],
        tools: [],
        model: ctx.model,
        maxTokens: 2048,
        signal: ctx.signal,
      })) {
        if (ev.type === 'text_delta') yield { type: 'text_delta', text: ev.text };
        else if (ev.type === 'usage') {
          if (ev.input) usage.inputTokens = ev.input;
          if (ev.output) usage.outputTokens += ev.output;
        } else if (ev.type === 'error') {
          throw new Error(ev.message);
        }
      }
    } catch {
      return;
    }
    // 计价：网关不回传费用，用静态牌价估算（未收录模型不计）
    const cost = computeCostUsd(ctx.model, usage.inputTokens, usage.outputTokens);
    if (cost !== undefined) usage.costUsd = cost;
    usageTotal.inputTokens += usage.inputTokens;
    usageTotal.outputTokens += usage.outputTokens;
    usageTotal.costUsd = (usageTotal.costUsd ?? 0) + (usage.costUsd ?? 0);
    if (usage.inputTokens > 0 || usage.outputTokens > 0) {
      yield { type: 'usage', usage, model: ctx.model };
    }
  };

  try {
    for (let turn = 1; turn <= maxTurns && !ctx.signal.aborted; turn++) {
      yield { type: 'turn_start', turn };

      // ── budget guard (before LLM call) ──
      // F-31：分级告警改在 record 之后判定（D7），轮首仅保留 100% 硬停检查（行为不变）
      const guard = ctx.budget.guard();
      if (guard.exceeded && !ctx.budgetDegrade) {
        const summary = ctx.budget.summarize();
        yield { type: 'budget_exhausted', summary };
        // 预算耗尽也给一次纯文本总结：用户拿到结论，而不是一堆工具卡后戛然而止
        yield* wrapUp(
          '（预算已耗尽，工具已停用。请基于以上已完成的工作立即输出最终总结：结论 / 已完成内容 / 遗留事项，不要再请求任何工具。）',
          turn,
        );
        return;
      }
      // ── 方案 D：降级续跑（budgetDegrade 链路，仅转换一次）──
      // 不终止主循环：禁用 task/子代理、单轮输出上限降到 1024，让任务自然收敛；
      // 后续轮 guard 仍 exceeded 但 degraded 已置位，直接放行（停止手段 = 用户中断/最大轮次）。
      if (guard.exceeded && !degraded) {
        degraded = true;
        yield { type: 'budget_degraded', summary: ctx.budget.summarize('degraded') };
        const note: ChatMessage = {
          role: 'user',
          content:
            '（系统提示：预算已耗尽，已降级续跑——子代理已停用、单轮输出上限降低。请尽快收敛任务并输出结论，不要再派生子代理或做大规模检索。）',
        };
        push(messages, note);
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
      for await (const item of chatStream(ctx, messages, turn, degraded)) {
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
      // ── F-31：record 后立即判定分级告警（D7：覆盖最后一轮跨阈值的死角；100% 告警先于下一轮轮首的 budget_exhausted）──
      const alert = ctx.budget.takeAlert();
      usageTotal.inputTokens += usage.inputTokens;
      usageTotal.outputTokens += usage.outputTokens;
      usageTotal.costUsd = (usageTotal.costUsd ?? 0) + (usage.costUsd ?? 0);
      yield { type: 'usage', usage, model: ctx.model };
      if (alert) yield { type: 'budget_alert', ...alert };

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

      // ── tools (parallel inside registry, streamed) ──
      // 流式上报：谁先完成先 yield tool_result（registry 负责回填 callId/name），
      // 一个工具挂住不再阻塞其余已完成结果的事件推送与落库（此前 executeAll 全部完成才逐条处理）
      for await (const { call, result } of ctx.registry.executeEach(toolCalls, ctx.toolContext)) {
        const ms = 0; // timing handled by registry callers if needed
        yield { type: 'tool_result', call, result, ms };
        // ── 方案 B：子代理用量统一口径 ──
        // task 工具在 meta.usage 回传子代理消耗（其内部 usage 事件不外抛）：
        // 1) 并入 usageTotal → done.usage 覆盖主循环 + 子代理，与预算累计口径一致；
        // 2) 补发一条 usage 事件 → hub 逐轮落库（DB 口径同样包含子代理），UI 可标注「含子代理 N 个」。
        // 预算侧不在此重复 record（task 工具已回写父预算）。
        const metaUsage = result.meta?.['usage'] as Usage | undefined;
        if (metaUsage && typeof metaUsage.inputTokens === 'number' && typeof metaUsage.outputTokens === 'number') {
          usageTotal.inputTokens += metaUsage.inputTokens;
          usageTotal.outputTokens += metaUsage.outputTokens;
          usageTotal.costUsd = (usageTotal.costUsd ?? 0) + (metaUsage.costUsd ?? 0);
          subagentCount += 1;
          yield { type: 'usage', usage: metaUsage, model: ctx.model };
        }
        const msg: ChatMessage = {
          role: 'tool',
          content: result.content,
          toolCallId: call.id,
        };
        msg.tokens = ctx.provider.estimateTokens([msg]);
        push(messages, msg);

        // circuit breaker: same tool failing >=3 times in a row
        if (!result.ok) {
          const n = (toolFailures.get(call.name) ?? 0) + 1;
          toolFailures.set(call.name, n);
          if (n >= 3) {
            const note: ChatMessage = {
              role: 'user',
              content: `（系统提示：工具 ${call.name} 已连续失败 ${n} 次，本轮请换一种思路，不要立即重复同一调用）`,
            };
            note.tokens = ctx.provider.estimateTokens([note]);
            push(messages, note);
            toolFailures.set(call.name, 0);
          }
        } else {
          toolFailures.set(call.name, 0);
        }
      }
      // ctx.turn++ handled by for-loop
    }

    // maxTurns exhausted：此前只往历史塞了一句总结提示就结束（从未发给模型），用户同样拿不到结果；
    // 现在补一次纯文本收尾轮
    yield { type: 'error', message: `reached max turns (${maxTurns})`, fatal: false };
    yield* wrapUp(
      '（已达最大轮次上限，工具已停用。请基于以上已完成的工作立即输出最终总结：结论 / 已完成内容 / 遗留事项，不要再请求任何工具。）',
      maxTurns,
    );
  } catch (e) {
    const err = e as Error;
    if (ctx.signal.aborted) {
      yield { type: 'error', message: 'aborted by user', fatal: false };
    } else {
      yield { type: 'error', message: err.message, fatal: true };
    }
  } finally {
    yield {
      type: 'done',
      usage: usageTotal,
      ...(subagentCount > 0 ? { subagents: subagentCount } : {}),
    };
  }
}

/** push with token estimate attached */
function push(messages: ChatMessage[], m: ChatMessage): void {
  if (m.tokens === undefined) {
    let tokens = 4 + estimateTokensText(m.content);
    // F-25：图片附件按封顶面积口径计入估算（与 tokens.ts 同规则）
    for (const img of m.images ?? []) {
      tokens += Math.min(1600, Math.max(1, Math.ceil(Math.floor(img.base64.length * 0.75) / 750)));
    }
    m.tokens = tokens;
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
  degraded = false,
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
        // E-4：静态前缀透传 → Anthropic 在静态/动态边界打 cache_control 断点，
        // 每轮重复的 8 层系统提示命中前缀缓存（input 计费与延迟双降）
        systemStatic: ctx.systemPromptParts?.staticText ?? ctx.systemPrompt,
        // 方案 D：降级续跑时禁用 task（子代理派生）工具
        tools: degraded
          ? ctx.registry.definitions().filter((d) => d.name !== 'task')
          : ctx.registry.definitions(),
        model: ctx.model,
        // 方案 D：降级续跑时单轮输出上限降到 1024，抑制长输出的 token 放大
        ...(degraded ? { maxTokens: 1024 } : {}),
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
    // 计价：网关不回传费用，用静态牌价估算（未收录模型不计）→ budget 费用维度生效
    const cost = computeCostUsd(ctx.model, usage.inputTokens, usage.outputTokens);
    if (cost !== undefined) usage.costUsd = cost;
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
