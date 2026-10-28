import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentEvent, ChatMessage, ChatRequest, LLMProvider, StreamEvent, ToolCall } from '@delta/shared';
import { BudgetManager } from '../src/context/budget.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { runReAct, type RunContext } from '../src/engine/react.js';
import type { ToolContext } from '../src/tools/types.js';

/** Scripted mock provider: pops one response per chat() call. */
class MockProvider implements LLMProvider {
  readonly id = 'mock';
  constructor(private script: Array<{ text?: string; toolCalls?: ToolCall[]; usage?: { input: number; output: number } }>) {}
  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
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
    for (const [i, c] of (next.toolCalls ?? []).entries()) {
      yield { type: 'tool_call_delta', index: i, id: c.id, name: c.name, argsDelta: '' };
      const half = Math.ceil(c.argsJson.length / 2);
      yield { type: 'tool_call_delta', index: i, argsDelta: c.argsJson.slice(0, half) };
      yield { type: 'tool_call_delta', index: i, argsDelta: c.argsJson.slice(half) };
    }
    yield { type: 'usage', input: next.usage?.input ?? 10, output: next.usage?.output ?? 5 };
    yield { type: 'done' };
  }
  estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((n, m) => n + m.content.length, 0);
  }
}

function makeCtx(provider: LLMProvider, over: Partial<RunContext> = {}): RunContext {
  const toolCtx: ToolContext = {
    projectRoot: process.cwd(),
    signal: new AbortController().signal,
    confirm: async () => ({ kind: 'allow' }),
    askUser: async () => 'ok',
    todos: [],
  };
  return {
    sessionId: 's1',
    projectId: 'p1',
    mode: 'react',
    model: 'mock-model',
    systemPrompt: 'SYS',
    maxTurns: 10,
    signal: new AbortController().signal,
    provider,
    registry: new ToolRegistry(),
    toolContext: toolCtx,
    budget: new BudgetManager({ maxTokens: 1_000_000, maxCostUsd: 1000 }),
    windowTokens: 200_000,
    ...over,
  };
}

async function collect(gen: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

let tmpRoot = '';
beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-react-'));
  await fs.writeFile(path.join(tmpRoot, 'note.txt'), 'hello world');
});

describe('runReAct', () => {
  it('streams text deltas and terminates on plain answer', async () => {
    const provider = new MockProvider([{ text: '最终答案', usage: { input: 100, output: 20 } }]);
    const events = await collect(runReAct(makeCtx(provider, { toolContext: { ...makeCtx(provider).toolContext, projectRoot: tmpRoot } }), [], 'hi'));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('turn_start');
    expect(types).toContain('text_delta');
    const text = events.filter((e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text).join('');
    expect(text).toBe('最终答案');
    const done = events.find((e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done')!;
    expect(done.usage.inputTokens).toBe(100);
    expect(done.usage.outputTokens).toBe(20);
    // exactly one done, emitted last
    expect(types[types.length - 1]).toBe('done');
    expect(types.filter((t) => t === 'done')).toHaveLength(1);
  });

  it('runs tool calls then continues to final answer', async () => {
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'read_file', argsJson: JSON.stringify({ path: 'note.txt' }) }] },
      { text: '文件内容是 hello world', usage: { input: 200, output: 30 } },
    ]);
    const ctx = makeCtx(provider, { toolContext: { ...makeCtx(provider).toolContext, projectRoot: tmpRoot } });
    const events = await collect(runReAct(ctx, [], '读一下 note.txt'));
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_call_start');
    const toolResult = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result')!;
    expect(toolResult.result.ok).toBe(true);
    expect(toolResult.result.content).toContain('hello world');
    expect(types[types.length - 1]).toBe('done');
    const text = events.filter((e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text).join('');
    expect(text).toBe('文件内容是 hello world');
  });

  it('emits budget_exhausted, then a forced text wrap-up summary', async () => {
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'list_dir', argsJson: '{}' }], usage: { input: 999_999, output: 5 } },
      { text: '收尾总结：已完成勘察', usage: { input: 50, output: 10 } },
    ]);
    const events = await collect(
      runReAct(
        makeCtx(provider, {
          budget: new BudgetManager({ maxTokens: 1_000_000, maxCostUsd: 1000 }),
          toolContext: { ...makeCtx(provider).toolContext, projectRoot: tmpRoot },
        }),
        [],
        'hi',
      ),
    );
    const exhausted = events.find((e): e is Extract<AgentEvent, { type: 'budget_exhausted' }> => e.type === 'budget_exhausted');
    expect(exhausted).toBeDefined();
    expect(exhausted!.summary).toContain('预算耗尽');
    // guard fires before the second LLM round-trip: one tool round ran
    expect(events.filter((e) => e.type === 'tool_call_start')).toHaveLength(1);
    // 收尾轮：预算耗尽后强制一次纯文本总结（用户拿得到结论），且用量计入 done
    const text = events.filter((e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text).join('');
    expect(text).toBe('收尾总结：已完成勘察');
    const done = events.find((e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done')!;
    expect(done.usage.inputTokens).toBe(999_999 + 50);
    expect(done.usage.outputTokens).toBe(5 + 10);
  });

  it('emits a wrap-up summary after maxTurns is exhausted', async () => {
    const toolCall = { id: 'c', name: 'list_dir', argsJson: '{}' };
    const provider = new MockProvider([
      { toolCalls: [toolCall] },
      { toolCalls: [toolCall] },
      { text: '轮次收尾总结', usage: { input: 40, output: 8 } },
      { text: 'never reached' },
    ]);
    const events = await collect(
      runReAct(
        makeCtx(provider, { maxTurns: 2, toolContext: { ...makeCtx(provider).toolContext, projectRoot: tmpRoot } }),
        [],
        'hi',
      ),
    );
    expect(events.filter((e) => e.type === 'turn_start')).toHaveLength(2);
    const err = events.find((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error')!;
    expect(err.message).toContain('max turns');
    const text = events.filter((e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text).join('');
    expect(text).toBe('轮次收尾总结');
    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('feeds tool failures back and keeps looping (self-heal)', async () => {
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'read_file', argsJson: JSON.stringify({ path: 'missing.txt' }) }] },
      { text: '文件不存在，任务结束' },
    ]);
    const events = await collect(
      runReAct(
        makeCtx(provider, { toolContext: { ...makeCtx(provider).toolContext, projectRoot: tmpRoot } }),
        [],
        'hi',
      ),
    );
    const failed = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result')!;
    expect(failed.result.ok).toBe(false);
    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('respects user abort via AbortSignal', async () => {
    const ac = new AbortController();
    const provider = new MockProvider([{ toolCalls: [{ id: 'c1', name: 'list_dir', argsJson: '{}' }] }]);
    const ctx = makeCtx(provider, {
      signal: ac.signal,
      toolContext: { ...makeCtx(provider).toolContext, projectRoot: tmpRoot, signal: ac.signal },
    });
    const events: AgentEvent[] = [];
    for await (const ev of runReAct(ctx, [], 'hi')) {
      events.push(ev);
      if (ev.type === 'tool_result') ac.abort();
    }
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('injects per-turn dynamic prompt via dynamicProvider (M3)', async () => {
    const seen: string[] = [];
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'list_dir', argsJson: '{}' }] },
      { text: '完成' },
    ]);
    const base = makeCtx(provider, { toolContext: { ...makeCtx(provider).toolContext, projectRoot: tmpRoot } });
    const ctx: RunContext = {
      ...base,
      systemPromptParts: { staticText: '静态段', dynamicText: '第一轮动态' },
      dynamicProvider: (turn) => `动态-t${turn}`,
    };
    // 捕获每轮 system 消息
    const origChat = provider.chat.bind(provider);
    (provider as unknown as { chat: (req: ChatRequest) => AsyncIterable<StreamEvent> }).chat =
      async function* (req: ChatRequest) {
        seen.push(req.messages[0]?.content ?? '');
        yield* origChat(req);
      };

    const events = await collect(runReAct(ctx, [], 'hi'));
    expect(events[events.length - 1]!.type).toBe('done');
    expect(seen[0]).toBe('静态段\n\n动态-t1');
    expect(seen[1]).toBe('静态段\n\n动态-t2');
  });

  it('composes static+dynamic from systemPromptParts without dynamicProvider', async () => {
    const seen: string[] = [];
    const provider = new MockProvider([{ text: '答案' }]);
    const base = makeCtx(provider, { toolContext: { ...makeCtx(provider).toolContext, projectRoot: tmpRoot } });
    const ctx: RunContext = {
      ...base,
      systemPromptParts: { staticText: '静态段', dynamicText: '动态段' },
    };
    const origChat = provider.chat.bind(provider);
    (provider as unknown as { chat: (req: ChatRequest) => AsyncIterable<StreamEvent> }).chat =
      async function* (req: ChatRequest) {
        seen.push(req.messages[0]?.content ?? '');
        yield* origChat(req);
      };

    await collect(runReAct(ctx, [], 'hi'));
    expect(seen[0]).toBe('静态段\n\n动态段');
  });

  // ── F-31：usage 事件带 model + budget_alert 分级告警 ──

  it('emits usage events carrying ctx.model (F-31)', async () => {
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'list_dir', argsJson: '{}' }], usage: { input: 20, output: 8 } },
      { text: '完成', usage: { input: 30, output: 12 } },
    ]);
    const events = await collect(
      runReAct(makeCtx(provider, { toolContext: { ...makeCtx(provider).toolContext, projectRoot: tmpRoot } }), [], 'hi'),
    );
    const usages = events.filter((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage');
    expect(usages).toHaveLength(2);
    for (const u of usages) expect(u.model).toBe('mock-model');
  });

  it('emits exactly one budget_alert (level 0.8) when crossing two levels in one turn (F-31)', async () => {
    const provider = new MockProvider([{ text: '一次性跨级告警', usage: { input: 900, output: 0 } }]);
    const events = await collect(
      runReAct(
        makeCtx(provider, {
          budget: new BudgetManager({ maxTokens: 1000, maxCostUsd: 1000 }),
          toolContext: { ...makeCtx(provider).toolContext, projectRoot: tmpRoot },
        }),
        [],
        'hi',
      ),
    );
    const alerts = events.filter((e): e is Extract<AgentEvent, { type: 'budget_alert' }> => e.type === 'budget_alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.level).toBe(0.8);
    expect(alerts[0]!.usedTokenPct).toBeCloseTo(0.9);
    // 告警在 usage 事件之后、同轮内发出
    const types = events.map((e) => e.type);
    expect(types.indexOf('budget_alert')).toBeGreaterThan(types.lastIndexOf('usage'));
  });

  it('emits no budget_alert below 50% (F-31)', async () => {
    const provider = new MockProvider([{ text: '小额消耗', usage: { input: 100, output: 20 } }]);
    const events = await collect(
      runReAct(makeCtx(provider, { toolContext: { ...makeCtx(provider).toolContext, projectRoot: tmpRoot } }), [], 'hi'),
    );
    expect(events.some((e) => e.type === 'budget_alert')).toBe(false);
  });

  it('computes costUsd from the static price table and feeds the budget guard', async () => {
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'list_dir', argsJson: '{}' }], usage: { input: 500_000, output: 500_000 } },
      { text: '完成', usage: { input: 1_000_000, output: 0 } },
    ]);
    // deepseek 牌价 0.28/0.42 USD per 1M：第一轮 0.14+0.21=0.35，第二轮 0.28 → 累计 0.63
    const budget = new BudgetManager({ maxTokens: 10_000_000, maxCostUsd: 0.5 });
    const events = await collect(
      runReAct(makeCtx(provider, { model: 'deepseek-chat', budget, toolContext: { ...makeCtx(provider).toolContext, projectRoot: tmpRoot } }), [], 'hi'),
    );
    const done = events.find((e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done')!;
    expect(done.usage.costUsd).toBeCloseTo(0.63, 6);
    // 费用维度已激活：第二輪 guard 前累计 0.35 产生 0.8 级告警（cost 70% > 50%）
    const alerts = events.filter((e): e is Extract<AgentEvent, { type: 'budget_alert' }> => e.type === 'budget_alert');
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });

  // ── 方案 D：预算耗尽降级续跑（budgetDegrade 链路）──

  it('budgetDegrade：耗尽不硬停——禁用 task、maxTokens 降到 1024、主循环继续', async () => {
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'list_dir', argsJson: '{}' }], usage: { input: 2_000, output: 0 } },
      { text: '降级后完成', usage: { input: 100, output: 10 } },
    ]);
    const seen: Array<ChatRequest> = [];
    const base = makeCtx(provider, {
      budget: new BudgetManager({ maxTokens: 1_000, maxCostUsd: 1000 }),
      toolContext: { ...makeCtx(provider).toolContext, projectRoot: tmpRoot },
    });
    const ctx: RunContext = { ...base, budgetDegrade: true };
    const origChat = provider.chat.bind(provider);
    (provider as unknown as { chat: (req: ChatRequest) => AsyncIterable<StreamEvent> }).chat =
      async function* (req: ChatRequest) {
        seen.push(req);
        yield* origChat(req);
      };

    const events = await collect(runReAct(ctx, [], 'hi'));
    const types = events.map((e) => e.type);
    // 降级事件恰好一次，且不再发 budget_exhausted（硬停协议只在缺省链路）
    const degraded = events.filter((e): e is Extract<AgentEvent, { type: 'budget_degraded' }> => e.type === 'budget_degraded');
    expect(degraded).toHaveLength(1);
    expect(degraded[0]!.summary).toContain('已降级续跑');
    expect(types).not.toContain('budget_exhausted');
    // 主循环继续：第二轮真实发生并以文本答案收尾
    expect(events.filter((e) => e.type === 'turn_start')).toHaveLength(2);
    const text = events.filter((e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text).join('');
    expect(text).toBe('降级后完成');
    // 降级轮：task 工具被摘除 + 单轮输出上限 1024
    expect(seen[0]!.tools.some((d) => d.name === 'task')).toBe(true);
    expect(seen[1]!.tools.some((d) => d.name === 'task')).toBe(false);
    expect(seen[1]!.maxTokens).toBe(1024);
    expect(types[types.length - 1]).toBe('done');
  });

  it('budgetDegrade 缺省 false：保持硬停 + budget_exhausted（headless 退出码 4 协议）', async () => {
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'list_dir', argsJson: '{}' }], usage: { input: 2_000, output: 0 } },
      { text: '收尾总结', usage: { input: 50, output: 10 } },
    ]);
    const events = await collect(
      runReAct(
        makeCtx(provider, {
          budget: new BudgetManager({ maxTokens: 1_000, maxCostUsd: 1000 }),
          toolContext: { ...makeCtx(provider).toolContext, projectRoot: tmpRoot },
        }),
        [],
        'hi',
      ),
    );
    expect(events.some((e) => e.type === 'budget_exhausted')).toBe(true);
    expect(events.some((e) => e.type === 'budget_degraded')).toBe(false);
  });

  // ── 方案 B：子代理用量统一口径（tool_result.meta.usage → usageTotal + usage 事件 + done.subagents）──

  it('aggregates subagent usage from tool_result.meta.usage into done.usage and emits a usage event', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'fake_task',
      description: '模拟 task 工具',
      schema: { type: 'object' },
      danger: 'safe',
      execute: async () => ({
        callId: '',
        name: 'fake_task',
        ok: true,
        content: '子代理汇报',
        meta: { usage: { inputTokens: 500, outputTokens: 100, costUsd: 0.01 } },
      }),
    });
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'fake_task', argsJson: '{}' }], usage: { input: 10, output: 5 } },
      { text: '完成', usage: { input: 10, output: 5 } },
    ]);
    const events = await collect(
      runReAct(makeCtx(provider, { registry, toolContext: { ...makeCtx(provider).toolContext, projectRoot: tmpRoot } }), [], 'hi'),
    );
    const done = events.find((e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done')!;
    // 主循环 (10+5)+(10+5) + 子代理 (500+100)
    expect(done.usage.inputTokens).toBe(520);
    expect(done.usage.outputTokens).toBe(110);
    expect(done.usage.costUsd).toBeCloseTo(0.01, 6);
    expect(done.subagents).toBe(1);
    // 子代理用量补发了一条 usage 事件（hub 据此逐轮落库，DB 口径与预算一致）
    const usages = events.filter((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage');
    expect(usages).toHaveLength(3);
    expect(usages.some((u) => u.usage.inputTokens === 500 && u.usage.outputTokens === 100)).toBe(true);
  });
});

// ── F-42：压缩摘要路由（summarizeRoute）────────────────────────────────────

/** 带 chat 请求捕获的 Mock（记录每次 chat 的请求，断言路由 model 用） */
class CapturingProvider extends MockProvider {
  readonly requests: ChatRequest[] = [];
  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(req);
    yield* super.chat(req);
  }
}

describe('F-42 summarize routing', () => {
  /** 7 条 user 大消息：保证 compactZone 非空，且总 token 超过小窗口阈值触发压缩 */
  function bigHistory(): ChatMessage[] {
    return Array.from({ length: 7 }, (_, i) => ({
      role: 'user' as const,
      content: `turn-${i} ${'x'.repeat(6000)}`,
    }));
  }

  it('命中 summarizeRoute：压缩摘要走目标模型 + 归因 usage 事件 + done.usage 汇总', async () => {
    const aux = new CapturingProvider([{ text: '压缩摘要', usage: { input: 123, output: 45 } }]);
    const main = new CapturingProvider([{ text: '最终答案', usage: { input: 10, output: 2 } }]);
    const events = await collect(
      runReAct(
        makeCtx(main, {
          windowTokens: 1000,
          summarizeRoute: { provider: aux, model: 'aux-model' },
          toolContext: { ...makeCtx(main).toolContext, projectRoot: tmpRoot },
        }),
        bigHistory(),
        'hi',
      ),
    );
    // 压缩摘要请求打到 aux provider，且 model = 路由目标；主循环仍用主模型
    expect(aux.requests).toHaveLength(1);
    expect(aux.requests[0]!.model).toBe('aux-model');
    expect(main.requests.every((r) => r.model === 'mock-model')).toBe(true);
    // 归因 usage 事件（model = aux-model），hub 据此逐轮落库区分辅助调用
    const usages = events.filter((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage');
    const auxUsage = usages.find((u) => u.model === 'aux-model');
    expect(auxUsage).toBeDefined();
    expect(auxUsage!.usage.inputTokens).toBe(123);
    expect(auxUsage!.usage.outputTokens).toBe(45);
    // done.usage 覆盖主循环 + 压缩摘要（与 headless 汇总口径一致）
    const done = events.find((e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done')!;
    expect(done.usage.inputTokens).toBe(133);
    expect(done.usage.outputTokens).toBe(47);
  });

  it('未注入 summarizeRoute：压缩摘要跟随主模型（决议 #10 兜底，用量仍归因落库）', async () => {
    const main = new CapturingProvider([
      { text: '压缩摘要', usage: { input: 5, output: 1 } }, // 压缩摘要调用（主模型）
      { text: '最终答案', usage: { input: 10, output: 2 } },
    ]);
    const events = await collect(
      runReAct(
        makeCtx(main, { windowTokens: 1000, toolContext: { ...makeCtx(main).toolContext, projectRoot: tmpRoot } }),
        bigHistory(),
        'hi',
      ),
    );
    expect(main.requests[0]!.model).toBe('mock-model');
    const usages = events.filter((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage');
    // 所有 usage 事件 model 均为主模型（无跨模型归因）
    expect(usages.every((u) => u.model === 'mock-model')).toBe(true);
    const done = events.find((e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done')!;
    expect(done.usage.inputTokens).toBe(15);
  });
});
