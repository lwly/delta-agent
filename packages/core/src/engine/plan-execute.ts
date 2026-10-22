/**
 * Plan-and-Execute 引擎（agent-modes-design §3）
 * 简单任务直达 ReAct；复杂任务 LLM 规划 → DAG → Worker Pool 并行执行 → 汇总。
 * 单节点失败：后继 skipped；critical 失败 → 整个 Plan 终止汇报。
 */
import type { AgentEvent, Plan, Usage } from '@y-zero/shared';
import { runReAct, type RunContext } from './react.js';
import { buildPlan, detectSimpleTask } from './planner.js';
import { runPlanWithPool } from './worker-pool.js';
import { createEventPump } from './pump.js';

const SUMMARIZE_SYSTEM = `你是编排汇总器。给定 DAG 各节点的执行结果，输出最终交付说明：
## 完成情况（各节点一句话）
## 最终结果
## 遗留问题（无则省略）
不超过 500 字。`;

export async function* runPlanExecute(
  ctx: RunContext,
  history: Parameters<typeof runReAct>[1],
  userInput: string,
): AsyncIterable<AgentEvent> {
  const usageTotal: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const force = ctx.plan?.force;

  // ── 简单任务直达（用户未强制规划且启发式判简）──
  if (force !== 'plan' && (force === 'direct' || detectSimpleTask(userInput))) {
    for await (const ev of runReAct(ctx, history, userInput)) {
      yield ev;
    }
    return;
  }

  try {
    // ── 规划 ──
    if (ctx.signal.aborted) throw new Error('aborted by user');
    const plan = await buildPlan(ctx.provider, ctx.model, userInput, { signal: ctx.signal });
    ctx.tasks?.createPlan(ctx.sessionId, plan);
    yield { type: 'plan_created', plan: snapshot(plan) };

    // ── DAG 并行执行（事件经泵实时转发）──
    const pump = createEventPump();
    const poolRun = runPlanWithPool(ctx, plan, { onEvent: pump.push }).finally(pump.close);
    yield* pump.stream();
    await poolRun;

    if (ctx.signal.aborted) {
      yield { type: 'error', message: 'aborted by user', fatal: false };
      return;
    }

    // ── 汇总 ──
    yield* summarize(ctx, plan);
  } catch (e) {
    const err = e as Error;
    if (ctx.signal.aborted) yield { type: 'error', message: 'aborted by user', fatal: false };
    else yield { type: 'error', message: err.message, fatal: true };
  } finally {
    yield { type: 'done', usage: usageTotal };
  }
}

function snapshot(plan: Plan): Plan {
  return { ...plan, nodes: plan.nodes.map((n) => ({ ...n })) };
}

export async function* summarize(ctx: RunContext, plan: Plan): AsyncGenerator<AgentEvent> {
  const transcript = plan.nodes
    .map((n) => `### ${n.id} [${n.status}] ${n.goal}\n${n.result ?? n.error ?? '(无输出)'}`)
    .join('\n\n');
  let text = '';
  let usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  for await (const ev of ctx.provider.chat({
    messages: [
      { role: 'system', content: SUMMARIZE_SYSTEM },
      { role: 'user', content: `总目标：${plan.goal}\n\n${transcript}` },
    ],
    tools: [],
    model: ctx.model,
    maxTokens: 2048,
    signal: ctx.signal,
  })) {
    if (ev.type === 'text_delta') {
      text += ev.text;
      yield { type: 'text_delta', text: ev.text };
    }
    if (ev.type === 'usage') usage = { inputTokens: ev.input, outputTokens: ev.output };
    if (ev.type === 'error') throw new Error(`summarizer error: ${ev.message}`);
  }
  if (text.trim().length === 0) {
    // 汇总失败兜底：直接拼接节点结果
    const fallback = plan.nodes.map((n) => `[${n.id}] ${n.result ?? n.error ?? ''}`).join('\n');
    yield { type: 'text_delta', text: fallback };
  }
  void usage;
}
