/**
 * Multi-Agent 编排器（agent-modes-design §4/§5）
 * 闭环：Planner(DAG) → Worker Pool 并行执行 → Reviewer/Verifier 质量检查
 *       → 不通过：失败节点回队重试或调整目标（携带审查反馈），重试上限默认 2
 *       → 超限终止并汇报遗留问题；通过：Orchestrator 汇总交付。
 */
import type { AgentEvent, ChatMessage, MessageImage, Plan, ReviewVerdict, TaskNode, Usage } from '@y-zero/shared';
import type { RunContext } from './react.js';
import { buildPlan } from './planner.js';
import { runPlanWithPool } from './worker-pool.js';
import { mergeVerdicts, review, verify } from './reviewer.js';
import { summarize } from './plan-execute.js';
import { createEventPump } from './pump.js';

export const DEFAULT_MAX_REVIEW_RETRIES = 2;

export async function* runMultiAgent(
  ctx: RunContext,
  _history: ChatMessage[],
  userInput: string,
  _images?: MessageImage[], // F-25：多代理模式的图片走历史消息（hub 已落库 user 消息），worker 规划用文本
): AsyncIterable<AgentEvent> {
  const usageTotal: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const maxReviewRetries = ctx.plan?.maxReviewRetries ?? DEFAULT_MAX_REVIEW_RETRIES;

  try {
    // ① Planner：产出 DAG
    if (ctx.signal.aborted) throw new Error('aborted by user');
    const plan = await buildPlan(ctx.provider, ctx.model, userInput, { signal: ctx.signal });
    ctx.tasks?.createPlan(ctx.sessionId, plan);
    yield { type: 'plan_created', plan: snapshot(plan) };

    // ② 执行 ↔ 审查 闭环
    let verdict: ReviewVerdict | undefined;
    let round = 0;
    while (true) {
      if (ctx.signal.aborted) break;

      // Worker Pool 并行执行
      const pump = createEventPump();
      const poolRun = runPlanWithPool(ctx, plan, { onEvent: pump.push }).finally(pump.close);
      yield* pump.stream();
      await poolRun;
      if (ctx.signal.aborted) break;

      // ③ Reviewer（主观）+ Verifier（客观）
      const input = {
        provider: ctx.provider,
        model: ctx.model,
        signal: ctx.signal,
        registry: ctx.registry,
        toolContext: ctx.toolContext,
        plan,
      };
      const [subjective, objective] = await Promise.all([
        review(input),
        verify(input),
      ]);
      verdict = mergeVerdicts(subjective, objective);
      plan.revision++;
      yield { type: 'review_verdict', verdict, revision: plan.revision };

      if (verdict.pass) break;
      if (round >= maxReviewRetries) break; // 超限：终止并汇报遗留问题

      // ④ 打回：失败节点重置为 pending，目标追加审查反馈后重新入队
      round++;
      const requeued = requeueFailed(plan, verdict);
      if (requeued.length === 0) break; // 无可重试节点
      ctx.tasks?.createPlan(ctx.sessionId, plan); // 回 queued 落库
      yield {
        type: 'plan_updated',
        plan: snapshot(plan),
        reason: `review round ${round}: ${requeued.map((n) => n.id).join(', ')} requeued`,
      };
    }

    if (ctx.signal.aborted) {
      yield { type: 'error', message: 'aborted by user', fatal: false };
      return;
    }

    // ⑤ Orchestrator 汇总（超限时列出遗留问题）
    if (verdict && !verdict.pass) {
      const leftovers = verdict.failures.map((f) => `- ${f.nodeId}: ${f.reason}`).join('\n');
      yield {
        type: 'text_delta',
        text: `质量审查未通过（已重试 ${round} 次），以下问题遗留：\n${leftovers}\n${verdict.feedback ?? ''}`,
      };
      return;
    }
    yield* summarize(ctx, plan);
  } catch (e) {
    const err = e as Error;
    if (ctx.signal.aborted) yield { type: 'error', message: 'aborted by user', fatal: false };
    else yield { type: 'error', message: err.message, fatal: true };
  } finally {
    yield { type: 'done', usage: usageTotal };
  }
}

/**
 * 审查不通过 → 重置失败节点（含 verifier 的 *tests 失败映射到全部代码产出节点）。
 * 返回被重置的节点（retries 保留，由 worker 的 EXEC_RETRY_CAP 与 maxReviewRetries 共同限流）。
 */
export function requeueFailed(plan: Plan, verdict: ReviewVerdict) {
  const byId = new Map(plan.nodes.map((n) => [n.id, n]));
  const requeued: TaskNode[] = [];
  const feedbackByNode = new Map<string, string>();

  for (const f of verdict.failures) {
    if (f.nodeId === '*tests') {
      // 客观验证失败：重跑所有产出代码的已完成节点
      for (const n of plan.nodes) {
        if (n.status === 'done' && (n.role === 'worker' || n.role === 'tool-caller')) {
          feedbackByNode.set(n.id, f.reason);
        }
      }
    } else if (f.nodeId === 'plan') {
      continue; // 全局反馈只进 feedback，不定向
    } else {
      feedbackByNode.set(f.nodeId, f.reason);
    }
  }

  for (const [id, reason] of feedbackByNode) {
    const node = byId.get(id);
    if (!node || node.status === 'skipped') continue;
    node.status = 'pending';
    node.error = undefined;
    node.result = undefined;
    node.goal = `${stripFeedback(node.goal)}\n（Reviewer 反馈，请修正：${reason}）`;
    requeued.push(node);
  }
  return requeued;
}

function stripFeedback(goal: string): string {
  return goal.split('\n（Reviewer 反馈')[0]!;
}

function snapshot(plan: Plan): Plan {
  return { ...plan, nodes: plan.nodes.map((n) => ({ ...n })) };
}
