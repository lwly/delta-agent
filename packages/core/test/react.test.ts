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
});
