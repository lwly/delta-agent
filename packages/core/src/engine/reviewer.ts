/**
 * 质量层：Reviewer（主观审查）+ Verifier（客观验证）（agent-modes-design §4）
 * 分工不合并：Reviewer 找缺陷提意见；Verifier 跑测试/构建用事实说话。
 * 合并裁决为 ReviewVerdict：不通过时携带失败节点与原因，进入打回闭环。
 */
import type { LLMProvider, Plan, ReviewVerdict, ToolCall, Usage } from '@delta/shared';
import type { ToolContext } from '../tools/types.js';
import { extractJson } from './planner.js';

export const REVIEWER_SYSTEM = `你是质量评审者（Reviewer）。审查 DAG 各节点的执行结果：
- 正确性：结果是否达成节点目标，有无明显错误
- 完整性：是否有遗漏
- 一致性：节点间结果是否冲突
严格输出 JSON（不要 markdown 围栏）：
{"pass": true|false, "failures": [{"nodeId": "n1", "reason": "失败原因"}], "feedback": "整体改进建议"}
只有存在需要重做的节点时才 pass=false；没有足够信息时 pass=true 并写明 feedback。`;

const VERIFIER_SYSTEM = `你是验证者（Verifier）。调用 run_tests 等工具客观验证执行结果。
完成后输出 JSON：{"pass": true|false, "failures": [{"nodeId": "n0", "reason": "..."}], "feedback": "..."}`.trim();

export interface ReviewInput {
  provider: LLMProvider;
  model: string;
  signal: AbortSignal;
  registry?: { definitions(): Array<{ name: string }>; executeAll(calls: ToolCall[], ctx: ToolContext): Promise<Array<{ ok: boolean; content: string }>> };
  toolContext?: ToolContext;
  plan: Plan;
  /**
   * 用量回调（费用口径闭环）：Reviewer 属编排层 LLM 调用，此前不进预算与会话用量，
   * 现回调实际用量，由编排层 record 预算并转 usage 事件（Verifier 跑工具不耗 LLM，无需回调）。
   */
  onUsage?: (usage: Usage) => void;
}

/** 主观审查：LLM 依据节点结果裁决（输出不可解析时视为通过，避免死循环）。 */
export async function review(input: ReviewInput): Promise<ReviewVerdict> {
  const transcript = input.plan.nodes
    .map((n) => `### ${n.id} [${n.status}] ${n.goal}\n${n.result ?? n.error ?? '(无输出)'}`)
    .join('\n\n');
  let text = '';
  for await (const ev of input.provider.chat({
    messages: [
      { role: 'system', content: REVIEWER_SYSTEM },
      { role: 'user', content: `总目标：${input.plan.goal}\n\n${transcript}` },
    ],
    tools: [],
    model: input.model,
    maxTokens: 2048,
    signal: input.signal,
  })) {
    if (ev.type === 'text_delta') text += ev.text;
    if (ev.type === 'usage') {
      const u: Usage = { inputTokens: ev.input, outputTokens: ev.output };
      input.onUsage?.(u);
    }
    if (ev.type === 'error') throw new Error(`reviewer llm error: ${ev.message}`);
  }
  try {
    const raw = extractJson(text) as { pass?: unknown; failures?: unknown; feedback?: unknown };
    const failures = (Array.isArray(raw.failures) ? raw.failures : [])
      .map((f) => f as { nodeId?: unknown; reason?: unknown })
      .filter((f) => typeof f.nodeId === 'string')
      .map((f) => ({ nodeId: f.nodeId as string, reason: String(f.reason ?? 'unspecified') }));
    return {
      pass: raw.pass !== false,
      failures,
      feedback: typeof raw.feedback === 'string' ? raw.feedback : undefined,
    };
  } catch {
    return { pass: true, failures: [], feedback: `reviewer output unparseable: ${text.slice(0, 200)}` };
  }
}

/** 客观验证：项目存在测试套件时运行 run_tests；全部节点已失败则直接判不通过。 */
export async function verify(input: ReviewInput): Promise<ReviewVerdict> {
  if (input.plan.nodes.every((n) => n.status === 'failed' || n.status === 'skipped')) {
    return { pass: false, failures: input.plan.nodes.filter((n) => n.status === 'failed').map((n) => ({ nodeId: n.id, reason: n.error ?? 'failed' })) };
  }
  const registry = input.registry;
  if (!registry || !registry.definitions().some((d) => d.name === 'run_tests') || !input.toolContext) {
    return { pass: true, failures: [], feedback: 'verifier unavailable (no run_tests)' };
  }
  const call: ToolCall = { id: `verify_${Date.now()}`, name: 'run_tests', argsJson: '{}' };
  const results = await registry.executeAll([call], input.toolContext);
  const r = results[0]!;
  if (/no test runner detected/i.test(r.content)) {
    return { pass: true, failures: [], feedback: 'verifier skipped (no test runner detected)' };
  }
  return r.ok
    ? { pass: true, failures: [], feedback: `tests passed` }
    : {
        pass: false,
        failures: [{ nodeId: '*tests', reason: r.content.slice(0, 2000) }],
        feedback: 'objective verification failed',
      };
}

/** 合并主观 + 客观裁决：任一不通过即不通过。 */
export function mergeVerdicts(...vs: ReviewVerdict[]): ReviewVerdict {
  const failures = vs.flatMap((v) => v.failures);
  return {
    pass: vs.every((v) => v.pass),
    failures,
    feedback: vs.map((v) => v.feedback).filter(Boolean).join(' | ') || undefined,
  };
}
