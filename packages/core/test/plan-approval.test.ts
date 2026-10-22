import { describe, expect, it, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type { AgentEvent, ChatMessage, ChatRequest, LLMProvider, Plan, PlanDecision, StreamEvent } from '@y-zero/shared';
import { BudgetManager } from '../src/context/budget.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/types.js';
import type { RunContext } from '../src/engine/react.js';
import { runPlanExecute } from '../src/engine/plan-execute.js';

class MockProvider implements LLMProvider {
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

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yz-approve-'));
});

function makeCtx(provider: LLMProvider, approval?: RunContext['planApproval']): RunContext {
  const toolCtx: ToolContext = {
    projectRoot: tmpRoot,
    signal: new AbortController().signal,
    confirm: async () => ({ kind: 'allow' }),
    askUser: async () => 'ok',
    todos: [],
  };
  return {
    sessionId: 's1',
    projectId: 'p1',
    mode: 'plan-execute',
    model: 'mock-model',
    systemPrompt: 'SYS',
    maxTurns: 10,
    signal: new AbortController().signal,
    provider,
    registry: new ToolRegistry(),
    toolContext: toolCtx,
    budget: new BudgetManager({ maxTokens: 10_000_000, maxCostUsd: 1000 }),
    windowTokens: 200_000,
    plan: { force: 'plan' },
    planApproval: approval,
  };
}

async function collect(gen: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const textOf = (events: AgentEvent[]) =>
  events.filter((e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta').map((e) => e.text).join('');

describe('F-14 计划确认流', () => {
  it('approve → plan_created with original revision and DAG executes', async () => {
    const provider = new MockProvider([
      { text: PLAN_JSON }, // planner
      { text: '节点一完成' }, // n1
      { text: '节点二完成' }, // n2
      { text: '## 汇总' }, // summarizer
    ]);
    const events = await collect(
      runPlanExecute(makeCtx(provider, async (req) => {
        expect(req.plan.nodes).toHaveLength(2);
        return { kind: 'approve' };
      }), [], '做一个复杂任务'),
    );
    const planEv = events.find((e): e is Extract<AgentEvent, { type: 'plan_created' }> => e.type === 'plan_created')!;
    expect(planEv.plan.revision).toBe(1);
    expect(events.some((e) => e.type === 'subtask_done')).toBe(true);
  });

  it('edit → merged plan (revision+1) executed after validation', async () => {
    const provider = new MockProvider([
      { text: PLAN_JSON }, // planner
      { text: '改后节点一完成' }, // n1
      { text: '改后节点二完成' }, // n2
      { text: '## 汇总' }, // summarizer
    ]);
    const events = await collect(
      runPlanExecute(makeCtx(provider, async () => {
        const decision: PlanDecision = {
          kind: 'edit',
          plan: {
            goal: '总目标（用户改）',
            revision: 1,
            createdAt: 0,
            nodes: [{ id: 'n1', goal: '用户改写的子任务', deps: [], suggestedTools: [], status: 'pending', retries: 0 }],
          },
        };
        return decision;
      }), [], '做一个复杂任务'),
    );
    const planEv = events.find((e): e is Extract<AgentEvent, { type: 'plan_created' }> => e.type === 'plan_created')!;
    expect(planEv.plan.revision).toBe(2);
    expect(planEv.plan.nodes[0]!.goal).toBe('用户改写的子任务');
  });

  it('edit with invalid dag → falls back to original plan with notice', async () => {
    const provider = new MockProvider([
      { text: PLAN_JSON }, // planner
      { text: '节点一完成' }, // n1（原计划执行）
      { text: '节点二完成' }, // n2
      { text: '## 汇总' }, // summarizer
    ]);
    const events = await collect(
      runPlanExecute(makeCtx(provider, async () => ({
        kind: 'edit',
        plan: {
          goal: 'g',
          revision: 1,
          createdAt: 0,
          nodes: [
            { id: 'a', goal: 'x', deps: ['b'], suggestedTools: [], status: 'pending', retries: 0 },
            { id: 'b', goal: 'y', deps: ['a'], suggestedTools: [], status: 'pending', retries: 0 }, // 环
          ],
        },
      })), [], '做一个复杂任务'),
    );
    expect(textOf(events)).toContain('回退原计划');
    const planEv = events.find((e): e is Extract<AgentEvent, { type: 'plan_created' }> => e.type === 'plan_created')!;
    expect(planEv.plan.revision).toBe(1); // 原计划
    expect(planEv.plan.nodes.map((n) => n.id)).toEqual(['n1', 'n2']);
  });

  it('reject → skips plan, runs ReAct directly', async () => {
    const provider = new MockProvider([
      { text: PLAN_JSON }, // planner（决策前必然先产出计划）
      { text: '直接执行的最终答案' }, // ReAct 直达
    ]);
    const events = await collect(
      runPlanExecute(makeCtx(provider, async () => ({ kind: 'reject', reason: '太简单' })), [], '做一个任务'),
    );
    expect(events.some((e) => e.type === 'plan_created')).toBe(false);
    expect(events.some((e) => e.type === 'subtask_start')).toBe(false);
    expect(textOf(events)).toContain('跳过计划');
    expect(textOf(events)).toContain('直接执行的最终答案');
  });

  it('planApproval throwing degrades to auto-approve', async () => {
    const provider = new MockProvider([
      { text: PLAN_JSON },
      { text: '节点一完成' },
      { text: '节点二完成' },
      { text: '## 汇总' },
    ]);
    const events = await collect(
      runPlanExecute(makeCtx(provider, async () => {
        throw new Error('ui gone');
      }), [], '做一个复杂任务'),
    );
    expect(events.some((e) => e.type === 'plan_created')).toBe(true);
  });
});
