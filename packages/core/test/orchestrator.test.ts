import { describe, expect, it } from 'vitest';
import type {
  AgentEvent,
  ChatMessage,
  Plan,
  PlanDecision,
  StreamEvent,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '@delta/shared';
import { BudgetManager } from '../src/context/budget.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/types.js';
import type { RunContext } from '../src/engine/react.js';
import { runMultiAgent } from '../src/engine/orchestrator.js';
import { runSubTask } from '../src/engine/subtask.js';

/** 顺序脚本 Mock：每次 chat() 消耗一条脚本（文本分片流出 + usage + done）。 */
class MockProvider implements import('@delta/shared').LLMProvider {
  readonly id = 'mock';
  constructor(private script: Array<{ text?: string }>) {}
  async *chat(): AsyncIterable<StreamEvent> {
    const next = this.script.shift();
    if (!next) {
      yield { type: 'error', message: 'mock script exhausted', retriable: false };
      return;
    }
    if (next.text) for (const chunk of next.text.match(/.{1,5}/gs) ?? []) yield { type: 'text_delta', text: chunk };
    yield { type: 'usage', input: 10, output: 5 };
    yield { type: 'done' };
  }
  estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((n, m) => n + m.content.length, 0);
  }
}

const PLAN_JSON = JSON.stringify({
  goal: '总目标',
  nodes: [
    { id: 'n1', goal: '子任务一' },
    { id: 'n2', goal: '子任务二', deps: ['n1'] },
  ],
});

const REVIEW_PASS = JSON.stringify({ pass: true, failures: [], feedback: 'ok' });

function makeCtx(
  provider: MockProvider,
  approval?: RunContext['planApproval'],
): RunContext {
  const toolCtx: ToolContext = {
    projectRoot: '/tmp',
    signal: new AbortController().signal,
    confirm: async () => ({ kind: 'allow' }),
    askUser: async () => 'ok',
    todos: [],
  };
  return {
    sessionId: 's1',
    projectId: 'p1',
    mode: 'multi-agent',
    model: 'mock-model',
    systemPrompt: 'SYS',
    maxTurns: 10,
    signal: new AbortController().signal,
    provider,
    registry: new ToolRegistry(),
    toolContext: toolCtx,
    budget: new BudgetManager({ maxTokens: 10_000_000, maxCostUsd: 1000 }),
    windowTokens: 200_000,
    planApproval: approval,
  };
}

/** Multi-Agent 全流程脚本：规划 → n1 → n2 → 审查 → 汇总。 */
const MULTI_SCRIPT = [
  { text: PLAN_JSON }, // planner
  { text: '节点一完成' }, // worker n1
  { text: '节点二完成' }, // worker n2
  { text: REVIEW_PASS }, // reviewer
  { text: '## 汇总' }, // summarizer
];

async function collect(gen: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const textOf = (events: AgentEvent[]) =>
  events.filter((e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta').map((e) => e.text).join('');

const planCreated = (events: AgentEvent[]) =>
  events.find((e): e is Extract<AgentEvent, { type: 'plan_created' }> => e.type === 'plan_created');

const usageEvents = (events: AgentEvent[]) =>
  events.filter((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage');

describe('Multi-Agent 计划确认流（F-14 同源）', () => {
  it('approve → 计划发布并完整执行（规划/执行/审查/汇总）', async () => {
    const provider = new MockProvider([...MULTI_SCRIPT]);
    const events = await collect(
      runMultiAgent(makeCtx(provider, async (req) => {
        expect(req.plan.nodes).toHaveLength(2);
        return { kind: 'approve' };
      }), [], '做一个复杂任务'),
    );
    const planEv = planCreated(events)!;
    expect(planEv.plan.revision).toBe(1);
    expect(events.some((e) => e.type === 'subtask_done')).toBe(true);
    expect(events.some((e) => e.type === 'review_verdict')).toBe(true);
    expect(textOf(events)).toContain('汇总');
    // 子任务的内层 done 已被编排层过滤，全程只应有一个 done（引擎收尾）
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('reject → 取消执行，不发布计划', async () => {
    const provider = new MockProvider([{ text: PLAN_JSON }]);
    const events = await collect(
      runMultiAgent(makeCtx(provider, async () => ({ kind: 'reject', reason: '先不做' })), [], '做一个复杂任务'),
    );
    expect(planCreated(events)).toBeUndefined();
    expect(events.some((e) => e.type === 'subtask_start')).toBe(false);
    expect(textOf(events)).toContain('取消执行该计划');
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('edit 非法 DAG → 回退原计划并提示', async () => {
    const provider = new MockProvider([
      { text: PLAN_JSON }, // planner
      { text: '节点一完成' }, // n1（原计划执行）
      { text: '节点二完成' }, // n2
      { text: REVIEW_PASS }, // reviewer
      { text: '## 汇总' }, // summarizer
    ]);
    const events = await collect(
      runMultiAgent(makeCtx(provider, async () => ({
        kind: 'edit',
        plan: {
          goal: 'g',
          revision: 1,
          createdAt: 0,
          nodes: [
            { id: 'a', goal: 'x', deps: ['b'], suggestedTools: [], status: 'pending', retries: 0 },
            { id: 'b', goal: 'y', deps: ['a'], suggestedTools: [], status: 'pending', retries: 0 }, // 环
          ],
        } as Plan,
      })), [], '做一个复杂任务'),
    );
    expect(textOf(events)).toContain('回退原计划');
    const planEv = planCreated(events)!;
    expect(planEv.plan.nodes.map((n) => n.id)).toEqual(['n1', 'n2']);
  });

  it('edit 合法 DAG → 采纳编辑后的计划执行', async () => {
    const provider = new MockProvider([
      { text: PLAN_JSON }, // planner
      { text: '改后节点完成' }, // n1
      { text: REVIEW_PASS }, // reviewer
      { text: '## 汇总' }, // summarizer
    ]);
    const events = await collect(
      runMultiAgent(makeCtx(provider, async () => ({
        kind: 'edit',
        plan: {
          goal: '总目标（用户改）',
          revision: 1,
          createdAt: 0,
          nodes: [{ id: 'n1', goal: '用户改写的子任务', deps: [], suggestedTools: [], status: 'pending', retries: 0 }],
        },
      })), [], '做一个复杂任务'),
    );
    const planEv = planCreated(events)!;
    expect(planEv.plan.nodes).toHaveLength(1);
    expect(planEv.plan.nodes[0]!.goal).toBe('用户改写的子任务');
    expect(events.some((e) => e.type === 'subtask_done')).toBe(true);
  });

  it('确认流故障 → 降级自动批准', async () => {
    const provider = new MockProvider([...MULTI_SCRIPT]);
    const events = await collect(
      runMultiAgent(makeCtx(provider, async () => {
        throw new Error('ui gone');
      }), [], '做一个复杂任务'),
    );
    expect(planCreated(events)).toBeDefined();
  });
});

describe('编排层用量入账（费用口径闭环）', () => {
  it('multi-agent：规划/worker/审查/汇总的 usage 全部入事件流与预算，done.usage 为整轮累计', async () => {
    const provider = new MockProvider([...MULTI_SCRIPT]);
    const ctx = makeCtx(provider);
    const events = await collect(runMultiAgent(ctx, [], '做一个复杂任务'));

    // 5 次 LLM 调用各发一条 usage（planner + 2 worker + reviewer + summarizer）
    const usages = usageEvents(events);
    expect(usages).toHaveLength(5);
    const sumInput = usages.reduce((n, u) => n + u.usage.inputTokens, 0);
    const sumOutput = usages.reduce((n, u) => n + u.usage.outputTokens, 0);
    expect(sumInput).toBe(50);
    expect(sumOutput).toBe(25);

    // done.usage = 整轮累计（worker 经泵转发 + 编排段 settle），不再恒 0
    const done = events.find((e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done')!;
    expect(done.usage.inputTokens).toBe(50);
    expect(done.usage.outputTokens).toBe(25);

    // 预算：worker 各自 record + 编排段 settleUsage record，5 次调用全部入账
    expect(ctx.budget.usedTokens()).toBe(75);
  });

  it('reject 路径：仅规划调用入账，done.usage 只含规划段', async () => {
    const provider = new MockProvider([{ text: PLAN_JSON }]);
    const ctx = makeCtx(provider, async () => ({ kind: 'reject' }));
    const events = await collect(runMultiAgent(ctx, [], '做一个复杂任务'));

    const usages = usageEvents(events);
    expect(usages).toHaveLength(1); // 只有 planner
    const done = events.find((e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done')!;
    expect(done.usage.inputTokens).toBe(10);
    expect(ctx.budget.usedTokens()).toBe(15);
  });

  it('子任务不外传内层 done/error 事件（生命周期归编排层）', async () => {
    const provider = new MockProvider([{ text: '子任务正常完成' }]);
    const parent = makeCtx(provider);
    const forwarded: AgentEvent[] = [];
    const node = { id: 'n1', goal: '做点事', deps: [], suggestedTools: [], status: 'pending' as const, retries: 0 };
    const result = await runSubTask(node, { parent, planGoal: '总目标', upstream: new Map(), onEvent: (ev) => forwarded.push(ev) });
    expect(result.ok).toBe(true);
    expect(forwarded.some((e) => e.type === 'done')).toBe(false);
    expect(forwarded.some((e) => e.type === 'error')).toBe(false);
    expect(forwarded.some((e) => e.type === 'usage')).toBe(true); // 用量照常转发
  });
});
