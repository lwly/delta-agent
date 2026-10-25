import { describe, expect, it, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type { AgentEvent, ChatMessage, ChatRequest, Plan, LLMProvider, StreamEvent } from '@delta/shared';
import { BudgetManager } from '../src/context/budget.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/types.js';
import { SessionStore } from '../src/session/store.js';
import { TaskStore } from '../src/session/tasks.js';
import type { RunContext } from '../src/engine/react.js';
import { runPlanWithPool, TaskQueue } from '../src/engine/worker-pool.js';
import { runPlanExecute } from '../src/engine/plan-execute.js';
import { runMultiAgent } from '../src/engine/orchestrator.js';

/** Scripted mock provider (one response per chat call, in order). */
class MockProvider implements LLMProvider {
  readonly id = 'mock';
  constructor(private script: Array<{ text?: string; usage?: { input: number; output: number } }>) {}
  async *chat(): AsyncIterable<StreamEvent> {
    const next = this.script.shift();
    if (!next) {
      yield { type: 'error', message: 'mock script exhausted', retriable: false };
      return;
    }
    if (next.text) {
      for (const chunk of next.text.match(/.{1,5}/gs) ?? []) {
        yield { type: 'text_delta', text: chunk };
      }
    }
    yield { type: 'usage', input: next.usage?.input ?? 10, output: next.usage?.output ?? 5 };
    yield { type: 'done' };
  }
  estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((n, m) => n + m.content.length, 0);
  }
}

let tmpRoot = '';
let store: SessionStore;
let tasks: TaskStore;

beforeEach(async () => {
  tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yz-m5-'));
  store = new SessionStore(path.join(tmpRoot, 'test.db'));
  tasks = new TaskStore(store.db);
});

function makeCtx(provider: LLMProvider, over: Partial<RunContext> = {}): RunContext {
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
    tasks,
    ...over,
  };
}

async function collect(gen: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function planOf(nodes: Plan['nodes']): Plan {
  return { goal: '总目标', nodes, revision: 1, createdAt: Date.now() };
}

const workerText = '节点完成：已处理目标。';

describe('TaskQueue', () => {
  it('fifo order, requeue unshifts to front', async () => {
    const q = new TaskQueue();
    const a = { id: 'a', goal: '', deps: [], suggestedTools: [], status: 'pending' as const, retries: 0 };
    const b = { ...a, id: 'b' };
    q.push(a);
    q.push(b);
    await expect(q.get()).resolves.toBe(a);
    q.requeue(a); // 重试：回队首（优先于 b）
    await expect(q.get()).resolves.toBe(a);
    await expect(q.get()).resolves.toBe(b);
    q.close();
    await expect(q.get()).resolves.toBeUndefined();
  });
});

describe('runPlanWithPool', () => {
  it('executes diamond DAG respecting deps and persists tasks', async () => {
    const provider = new MockProvider([
      { text: workerText }, // a
      { text: workerText }, // b
      { text: workerText }, // c
      { text: workerText }, // d
    ]);
    const plan = planOf([
      { id: 'a', goal: 'ga', deps: [], suggestedTools: [], status: 'pending', retries: 0 },
      { id: 'b', goal: 'gb', deps: ['a'], suggestedTools: [], status: 'pending', retries: 0 },
      { id: 'c', goal: 'gc', deps: ['a'], suggestedTools: [], status: 'pending', retries: 0 },
      { id: 'd', goal: 'gd', deps: ['b', 'c'], suggestedTools: [], status: 'pending', retries: 0 },
    ]);
    tasks.createPlan('s1', plan);
    const ctx = makeCtx(provider, { plan: { workerCount: 2 } });
    await runPlanWithPool(ctx, plan);
    expect(plan.nodes.map((n) => n.status)).toEqual(['done', 'done', 'done', 'done']);
    const rows = tasks.list('s1');
    expect(rows.every((r) => r.status === 'completed')).toBe(true);
    // b/c only after a (lease timestamps monotonic)
    const a = rows.find((r) => r.node_id === 'a')!;
    const b = rows.find((r) => r.node_id === 'b')!;
    expect(b.updated_at).toBeGreaterThanOrEqual(a.updated_at);
  });

  it('skips downstream of terminally failed node and persists skip', async () => {
    // worker keeps failing (empty output → failure), retries cap 2 → terminal failed
    const provider = new MockProvider([{ text: '' }, { text: '' }]);
    const plan = planOf([
      { id: 'a', goal: 'ga', deps: [], suggestedTools: [], status: 'pending', retries: 0 },
      { id: 'b', goal: 'gb', deps: ['a'], suggestedTools: [], status: 'pending', retries: 0 },
    ]);
    tasks.createPlan('s1', plan);
    const ctx = makeCtx(provider);
    await runPlanWithPool(ctx, plan);
    expect(plan.nodes.find((n) => n.id === 'a')!.status).toBe('failed');
    expect(plan.nodes.find((n) => n.id === 'b')!.status).toBe('skipped');
    expect(tasks.get('s1', 'b')!.status).toBe('failed'); // skipped 落库为 failed+reason
  });

  it('aborts the whole plan when a critical node fails', async () => {
    const provider = new MockProvider([{ text: 'ok' }, { text: '' }, { text: '' }]);
    const plan = planOf([
      { id: 'p', goal: 'g', deps: [], suggestedTools: [], status: 'pending', retries: 0 },
      { id: 'crit', goal: 'g', deps: ['p'], suggestedTools: [], status: 'pending', retries: 0, critical: true },
    ]);
    tasks.createPlan('s1', plan);
    const ctx = makeCtx(provider);
    const events: AgentEvent[] = [];
    await runPlanWithPool(ctx, plan, { onEvent: (e) => events.push(e) });
    expect(events.some((e) => e.type === 'plan_updated')).toBe(true);
    expect(plan.nodes.find((n) => n.id === 'crit')!.status).toBe('failed');
    expect(plan.nodes.find((n) => n.id === 'p')!.status).toBe('done');
  });

  it('respects tool allowlist via node.suggestedTools (role worker denied run_command)', async () => {
    const provider = new MockProvider([{ text: 'done output' }]);
    const plan = planOf([
      { id: 'a', goal: 'g', deps: [], suggestedTools: ['read_file'], status: 'pending', retries: 0 },
    ]);
    tasks.createPlan('s1', plan);
    const ctx = makeCtx(provider);
    await runPlanWithPool(ctx, plan);
    expect(plan.nodes[0]!.status).toBe('done');
  });
});

describe('TaskStore recovery', () => {
  it('claim is atomic; orphan recovery requeues expired leases with retries+1', () => {
    const plan = planOf([{ id: 'a', goal: 'g', deps: [], suggestedTools: [], status: 'pending', retries: 0 }]);
    tasks.createPlan('s1', plan);
    expect(tasks.claim('s1', 'a', 'w1')).toBe(true);
    expect(tasks.claim('s1', 'a', 'w2')).toBe(false); // already running
    tasks.heartbeat('s1', 'a', 'w1');
    const row = tasks.get('s1', 'a')!;
    expect(row.status).toBe('running');
    expect(row.heartbeat_at).not.toBeNull();
    // expire the lease → orphan
    store.db.prepare('UPDATE tasks SET lease_until = ? WHERE id = ?').run(Date.now() - 1000, `s1:a`);
    expect(tasks.recoverOrphans('s1')).toBe(1);
    const after = tasks.get('s1', 'a')!;
    expect(after.status).toBe('queued');
    expect(after.retries).toBe(1);
    expect(tasks.pendingNodes('s1')).toHaveLength(1);
  });

  it('cancelSession cancels queued and running tasks', () => {
    const plan = planOf([
      { id: 'a', goal: 'g', deps: [], suggestedTools: [], status: 'pending', retries: 0 },
      { id: 'b', goal: 'g', deps: [], suggestedTools: [], status: 'pending', retries: 0 },
    ]);
    tasks.createPlan('s1', plan);
    tasks.claim('s1', 'a', 'w1');
    expect(tasks.cancelSession('s1')).toBe(2);
    expect(tasks.get('s1', 'a')!.status).toBe('canceled');
    expect(tasks.get('s1', 'b')!.status).toBe('canceled');
  });

  it('fail → requeue keeps retries for cap enforcement', () => {
    const plan = planOf([{ id: 'a', goal: 'g', deps: [], suggestedTools: [], status: 'pending', retries: 0 }]);
    tasks.createPlan('s1', plan);
    tasks.claim('s1', 'a', 'w1');
    tasks.fail('s1', 'a', 1, 'boom');
    expect(tasks.requeue('s1', 'a')).toBe(true);
    expect(tasks.get('s1', 'a')!.retries).toBe(1);
  });
});

describe('runPlanExecute', () => {
  it('simple input goes direct (no plan_created)', async () => {
    const provider = new MockProvider([{ text: '直接回答' }]);
    const ctx = makeCtx(provider, { mode: 'plan-execute' });
    const events = await collect(runPlanExecute(ctx, [], '什么是闭包？'));
    expect(events.some((e) => e.type === 'plan_created')).toBe(false);
    expect(events.at(-1)!.type).toBe('done');
  });

  it('complex input plans, executes DAG and summarizes', async () => {
    const planJson = JSON.stringify({
      goal: '重构两个模块',
      nodes: [
        { id: 'n1', goal: '模块一重构' },
        { id: 'n2', goal: '模块二重构' },
        { id: 'n3', goal: '汇总验证', deps: ['n1', 'n2'] },
      ],
    });
    const provider = new MockProvider([
      { text: planJson }, // planner
      { text: workerText }, // n1
      { text: workerText }, // n2
      { text: workerText }, // n3
      { text: '## 汇总完成' }, // summarizer
    ]);
    const ctx = makeCtx(provider, { mode: 'plan-execute' });
    const events = await collect(runPlanExecute(ctx, [], '重构 moduleA 与 moduleB 两个模块'));
    const types = events.map((e) => e.type);
    expect(types).toContain('plan_created');
    expect(types).toContain('subtask_start');
    expect(types).toContain('subtask_done');
    const text = events
      .filter((e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(text).toContain('汇总完成');
  });
});

describe('runMultiAgent (Reviewer closed loop)', () => {
  it('plan → execute → review pass → summary', async () => {
    const planJson = JSON.stringify({
      goal: '大任务',
      nodes: [
        { id: 'n1', goal: '子任务一' },
        { id: 'n2', goal: '子任务二', deps: ['n1'] },
      ],
    });
    const provider = new MockProvider([
      { text: planJson }, // planner
      { text: workerText }, // n1
      { text: workerText }, // n2
      { text: '{"pass":true,"failures":[]}' }, // reviewer
      { text: '## 全部通过' }, // summarizer
    ]);
    const ctx = makeCtx(provider);
    const events = await collect(runMultiAgent(ctx, [], '做一个大任务'));
    const types = events.map((e) => e.type);
    expect(types).toContain('plan_created');
    expect(types).toContain('review_verdict');
    expect(types).toContain('subtask_done');
  });

  it('review fail → requeue failed node with feedback → pass on second round', async () => {
    const planJson = JSON.stringify({
      goal: '大任务',
      nodes: [{ id: 'n1', goal: '子任务一' }],
    });
    const provider = new MockProvider([
      { text: planJson }, // planner
      { text: workerText }, // n1 (round 1)
      { text: '{"pass":false,"failures":[{"nodeId":"n1","reason":"缺测试"}]}' }, // reviewer round 1
      { text: workerText }, // n1 retry (round 2)
      { text: '{"pass":true,"failures":[]}' }, // reviewer round 2
      { text: '## 完成' }, // summarizer
    ]);
    const ctx = makeCtx(provider);
    const events = await collect(runMultiAgent(ctx, [], '做一个大任务'));
    const types = events.map((e) => e.type);
    // plan_updated emitted when requeueing
    expect(types).toContain('plan_updated');
    // n1 executed twice (two subtask_start for same node)
    const starts = events.filter(
      (e): e is Extract<AgentEvent, { type: 'subtask_start' }> => e.type === 'subtask_start',
    );
    expect(starts.filter((e) => e.nodeId === 'n1')).toHaveLength(2);
    const text = events
      .filter((e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(text).toContain('完成');
  });

  it('stops reporting leftovers when retries are exhausted', async () => {
    const planJson = JSON.stringify({ goal: '大任务', nodes: [{ id: 'n1', goal: '子任务一' }] });
    const alwaysFail = JSON.stringify({ pass: false, failures: [{ nodeId: 'n1', reason: '仍然不行' }] });
    const provider = new MockProvider([
      { text: planJson }, // planner
      { text: workerText }, // n1 round 1
      { text: alwaysFail }, // review 1
      { text: workerText }, // n1 round 2
      { text: alwaysFail }, // review 2
      { text: workerText }, // n1 round 3
      { text: alwaysFail }, // review 3 → over cap
    ]);
    const ctx = makeCtx(provider, { plan: { maxReviewRetries: 2 } });
    const events = await collect(runMultiAgent(ctx, [], '做一个大任务'));
    const text = events
      .filter((e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(text).toContain('遗留');
  });
});
