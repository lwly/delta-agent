/**
 * Plan-and-Execute 引擎（agent-modes-design §3）
 * 简单任务直达 ReAct；复杂任务 LLM 规划 → DAG → Worker Pool 并行执行 → 汇总。
 * 单节点失败：后继 skipped；critical 失败 → 整个 Plan 终止汇报。
 */
import type { AgentEvent, MessageImage, Plan, PlanApprovalRequest, PlanDecision, Usage } from '@delta/shared';
import { runReAct, type RunContext } from './react.js';
import { buildPlan, resolveSimpleTask } from './planner.js';
import { runPlanWithPool } from './worker-pool.js';
import { validatePlan } from './plan.js';
import { createEventPump } from './pump.js';

const SUMMARIZE_SYSTEM = `你是编排汇总器。给定 DAG 各节点的执行结果，输出最终交付说明：
## 完成情况（各节点一句话）
## 最终结果
## 遗留问题（无则省略）
不超过 500 字。`;

/** 累计 Usage（编排层用量口径：规划/分类/审查/汇总段 + worker 段统一入 done.usage）。 */
export function addUsage(total: Usage, u: Usage): Usage {
  total.inputTokens += u.inputTokens;
  total.outputTokens += u.outputTokens;
  total.costUsd = (total.costUsd ?? 0) + (u.costUsd ?? 0);
  return total;
}

/**
 * 编排段用量结算（费用口径闭环）：record 会话预算 + 产出 usage 事件，
 * headless / hub / TUI 据此落库；零用量跳过（未发生的调用不入账）。
 */
export async function* settleUsage(
  ctx: RunContext,
  usage: Usage,
  model: string,
): AsyncGenerator<AgentEvent> {
  if (usage.inputTokens === 0 && usage.outputTokens === 0) return;
  ctx.budget.record(usage);
  yield { type: 'usage', usage: { ...usage }, model };
}

/** 新建编排段用量累计器：返回累计容器与其 onUsage 回调（供 planner/reviewer/classifier 注入）。 */
export function usageAccumulator(): { total: Usage; onUsage: (u: Usage) => void } {
  const total: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  return { total, onUsage: (u) => addUsage(total, u) };
}

export async function* runPlanExecute(
  ctx: RunContext,
  history: Parameters<typeof runReAct>[1],
  userInput: string,
  images?: MessageImage[],
): AsyncIterable<AgentEvent> {
  const usageTotal: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const force = ctx.plan?.force;

  // ── 简单任务直达（用户未强制规划；规则强判定 + LLM 兜底分类）──
  if (force !== 'plan') {
    // 分类调用属编排段 LLM 用量（费用口径闭环）：无论走哪条路径都结算
    const classify = usageAccumulator();
    const simple =
      force === 'direct' ||
      (await resolveSimpleTask(ctx.provider, ctx.model, userInput, {
        signal: ctx.signal,
        onUsage: classify.onUsage,
      }));
    yield* settleUsage(ctx, classify.total, ctx.model);
    addUsage(usageTotal, classify.total);
    if (simple) {
      for await (const ev of runReAct(ctx, history, userInput, images)) {
        yield ev;
      }
      return;
    }
  }

  try {
    // ── 规划 ──
    if (ctx.signal.aborted) throw new Error('aborted by user');
    const planUsage = usageAccumulator();
    let plan = await buildPlan(ctx.provider, ctx.model, userInput, {
      signal: ctx.signal,
      onUsage: planUsage.onUsage,
    });
    yield* settleUsage(ctx, planUsage.total, ctx.model);
    addUsage(usageTotal, planUsage.total);

    // ── F-14 计划确认流：用户可批准 / 编辑（改节点、删节点、调依赖）/ 拒绝 ──
    if (ctx.planApproval) {
      const request: PlanApprovalRequest = { id: `plan_${ctx.sessionId}_${Date.now()}`, plan: snapshot(plan) };
      let decision: PlanDecision;
      try {
        decision = await ctx.planApproval(request);
      } catch {
        decision = { kind: 'approve' }; // 确认流故障不阻塞（降级自动批准）
      }
      if (decision.kind === 'reject') {
        // 拒绝规划 → 回退 ReAct 直达
        yield { type: 'text_delta', text: `（已按你的要求跳过计划，直接执行）\n` };
        for await (const ev of runReAct(ctx, history, userInput, images)) {
          yield ev;
        }
        return;
      }
      if (decision.kind === 'edit') {
        const edited = decision.plan;
        const problems = validatePlan(edited);
        if (problems.length > 0) {
          // 编辑后 DAG 非法 → 保留原计划并提示
          yield {
            type: 'text_delta',
            text: `（编辑后的计划无效，已回退原计划：${problems[0]}）\n`,
          };
        } else {
          plan = { ...edited, revision: plan.revision + 1 };
        }
      }
    }

    ctx.tasks?.createPlan(ctx.sessionId, plan);
    yield { type: 'plan_created', plan: snapshot(plan) };

    // ── DAG 并行执行（事件经泵实时转发；worker 的 usage 同步累计入 done.usage）──
    const pump = createEventPump();
    const poolRun = runPlanWithPool(ctx, plan, { onEvent: pump.push }).finally(pump.close);
    for await (const ev of pump.stream()) {
      if (ev.type === 'usage') addUsage(usageTotal, ev.usage);
      yield ev;
    }
    await poolRun;

    if (ctx.signal.aborted) {
      yield { type: 'error', message: 'aborted by user', fatal: false };
      return;
    }

    // ── 汇总 ──
    yield* summarize(ctx, plan, usageTotal);
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

/** 汇总 DAG 各节点结果为最终交付说明（into 提供时同步把汇总用量累计进整轮口径）。 */
export async function* summarize(
  ctx: RunContext,
  plan: Plan,
  into?: Usage,
): AsyncGenerator<AgentEvent> {
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
  // 汇总调用属编排段用量（费用口径闭环）：record 预算 + usage 事件（此前被丢弃）
  yield* settleUsage(ctx, usage, ctx.model);
  if (into) addUsage(into, usage);
}
