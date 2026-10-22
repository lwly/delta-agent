import { describe, expect, it } from 'vitest';
import type { AgentEvent, ChatMessage, ToolCall } from '@y-zero/shared';
import { BudgetManager } from '../src/context/budget.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { RunContext } from '../src/engine/react.js';
import type { ToolContext } from '../src/tools/types.js';
import {
  runHeadless,
  headlessExitCode,
  buildHeadlessReport,
  type HeadlessService,
} from '../src/headless.js';

// ── 伪造设施 ────────────────────────────────────────────────────────────────

function makeFakeService(): HeadlessService & {
  messages: Array<ChatMessage & { sessionId: string }>;
} {
  const messages: Array<ChatMessage & { sessionId: string }> = [];
  return {
    messages,
    appendMessage(sessionId, m) {
      messages.push({ ...m, sessionId });
    },
    getHistory(sessionId) {
      return messages.filter((m) => m.sessionId === sessionId);
    },
    recordUsage() {},
    recordCompaction() {},
  };
}

function makeBaseCtx(over: Partial<RunContext> = {}): RunContext {
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
    provider: {} as RunContext['provider'], // headless 不直接用 provider（引擎内部使用）
    registry: new ToolRegistry(),
    toolContext: toolCtx,
    budget: new BudgetManager({ maxTokens: 1_000_000, maxCostUsd: 1000 }),
    windowTokens: 200_000,
    ...over,
  };
}

/** 脚本化伪引擎：按序产出事件（script 可为异步）。 */
function scriptedEngine(script: (ctx: RunContext) => AgentEvent[] | Promise<AgentEvent[]>) {
  return async function* (ctx: RunContext): AsyncIterable<AgentEvent> {
    for (const ev of await script(ctx)) yield ev;
  };
}

const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id,
  name,
  argsJson: JSON.stringify(args),
  args,
});

// ── runHeadless ─────────────────────────────────────────────────────────────

describe('runHeadless', () => {
  it('completed：最终文本 + 用量 + 退出码 0', async () => {
    const service = makeFakeService();
    const outcome = await runHeadless(
      {
        base: makeBaseCtx(),
        service,
        engine: scriptedEngine((ctx) => [
          { type: 'turn_start', turn: 1 },
          { type: 'text_delta', text: '正在分析' },
          { type: 'tool_call_start', call: call('c1', 'read_file', { path: 'a.ts' }) },
          {
            type: 'tool_result',
            call: call('c1', 'read_file'),
            result: { callId: 'c1', name: 'read_file', ok: true, content: 'ok' },
            ms: 1,
          },
          { type: 'turn_start', turn: 2 },
          { type: 'text_delta', text: '最终答案' },
          { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 } },
          { type: 'done', usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 } },
        ]),
      },
      '修复 lint',
    );
    expect(outcome.status).toBe('completed');
    expect(outcome.result).toBe('最终答案');
    expect(outcome.transcript).toBe('正在分析最终答案');
    expect(outcome.turns).toBe(2);
    expect(outcome.toolCalls).toEqual([{ id: 'c1', name: 'read_file', ok: true }]);
    expect(outcome.usage).toEqual({ inputTokens: 100, outputTokens: 20, costUsd: 0.01 });
    expect(headlessExitCode(outcome.status)).toBe(0);
    // 落库：user → assistant(带 calls) → tool → assistant(最终)
    const roles = service.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(service.messages[1]!.toolCalls?.[0]?.id).toBe('c1');
    expect(service.messages[3]!.content).toBe('最终答案');
  });

  it('failed：引擎致命错误 → 退出码 2', async () => {
    const outcome = await runHeadless(
      {
        base: makeBaseCtx(),
        service: makeFakeService(),
        engine: scriptedEngine(() => [
          { type: 'turn_start', turn: 1 },
          { type: 'error', message: 'llm stream failed', fatal: true },
          { type: 'done', usage: { inputTokens: 0, outputTokens: 0 } },
        ]),
      },
      '任务',
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBe('llm stream failed');
    expect(headlessExitCode(outcome.status)).toBe(2);
  });

  it('max_turns：非致命 reached max turns → 退出码 3', async () => {
    const outcome = await runHeadless(
      {
        base: makeBaseCtx(),
        service: makeFakeService(),
        engine: scriptedEngine(() => [
          { type: 'turn_start', turn: 50 },
          { type: 'error', message: 'reached max turns (50)', fatal: false },
          { type: 'done', usage: { inputTokens: 0, outputTokens: 0 } },
        ]),
      },
      '任务',
    );
    expect(outcome.status).toBe('max_turns');
    expect(headlessExitCode(outcome.status)).toBe(3);
  });

  it('budget_exhausted：优先于其他状态 → 退出码 4', async () => {
    const outcome = await runHeadless(
      {
        base: makeBaseCtx(),
        service: makeFakeService(),
        engine: scriptedEngine(() => [
          { type: 'turn_start', turn: 1 },
          { type: 'budget_exhausted', summary: '预算耗尽' },
          { type: 'done', usage: { inputTokens: 0, outputTokens: 0 } },
        ]),
      },
      '任务',
    );
    expect(outcome.status).toBe('budget_exhausted');
    expect(headlessExitCode(outcome.status)).toBe(4);
  });

  it('aborted：外部 SIGINT 中断 → 退出码 5', async () => {
    const external = new AbortController();
    const outcome = await runHeadless(
      {
        base: makeBaseCtx(),
        service: makeFakeService(),
        externalSignal: external.signal,
        engine: scriptedEngine((ctx) => {
          expect(ctx.signal.aborted).toBe(false);
          external.abort(); // 模拟运行中 SIGINT → 传播到内部 AbortController
          expect(ctx.signal.aborted).toBe(true);
          return [
            { type: 'error', message: 'aborted by user', fatal: false },
            { type: 'done', usage: { inputTokens: 0, outputTokens: 0 } },
          ];
        }),
      },
      '任务',
    );
    expect(outcome.status).toBe('aborted');
    expect(headlessExitCode(outcome.status)).toBe(5);
  });

  it('confirm 自动拒绝并记录（非交互安全默认）', async () => {
    let decision: Awaited<ReturnType<ToolContext['confirm']>> | undefined;
    const outcome = await runHeadless(
      {
        base: makeBaseCtx(),
        service: makeFakeService(),
        engine: scriptedEngine(async (ctx) => {
          decision = await ctx.toolContext.confirm({
            id: 'c9',
            tool: 'write_file',
            args: { path: 'x.ts', content: '1' },
            reason: '高危',
          });
          return [{ type: 'done', usage: { inputTokens: 0, outputTokens: 0 } }];
        }),
      },
      '任务',
    );
    expect(decision?.kind).toBe('reject');
    expect(outcome.deniedConfirmations).toHaveLength(1);
    expect(outcome.deniedConfirmations[0]).toMatchObject({ tool: 'write_file', id: 'c9' });
  });

  it('askUser 自动应答并记录提问', async () => {
    let answer = '';
    await runHeadless(
      {
        base: makeBaseCtx(),
        service: makeFakeService(),
        engine: scriptedEngine(async (ctx) => {
          answer = await ctx.toolContext.askUser('选 A 还是 B？');
          return [{ type: 'done', usage: { inputTokens: 0, outputTokens: 0 } }];
        }),
      },
      '任务',
    );
    expect(answer).toContain('headless 非交互模式');
  });

  it('外部信号预中断传播为 aborted（SIGINT 场景）', async () => {
    const external = new AbortController();
    external.abort(); // 运行前已收到 SIGINT
    const outcome = await runHeadless(
      {
        base: makeBaseCtx(),
        service: makeFakeService(),
        externalSignal: external.signal,
        engine: scriptedEngine((ctx) => {
          expect(ctx.signal.aborted).toBe(true); // 内部 AbortController 被联动
          return [
            { type: 'error', message: 'aborted by user', fatal: false },
            { type: 'done', usage: { inputTokens: 0, outputTokens: 0 } },
          ];
        }),
      },
      '任务',
    );
    expect(outcome.status).toBe('aborted');
    expect(headlessExitCode(outcome.status)).toBe(5);
  });

  it('planApproval 自动批准并计数', async () => {
    let approved = false;
    const outcome = await runHeadless(
      {
        base: makeBaseCtx(),
        service: makeFakeService(),
        engine: scriptedEngine(async (ctx) => {
          const d = await ctx.planApproval!({
            id: 'p1',
            plan: { goal: 'g', nodes: [], revision: 1, createdAt: 0 },
          });
          approved = d.kind === 'approve';
          return [{ type: 'done', usage: { inputTokens: 0, outputTokens: 0 } }];
        }),
      },
      '任务',
    );
    expect(approved).toBe(true);
    expect(outcome.planApprovals).toBe(1);
  });
});

// ── headlessExitCode / buildHeadlessReport ──────────────────────────────────

describe('headlessExitCode 协议', () => {
  it.each([
    ['completed', 0],
    ['failed', 2],
    ['max_turns', 3],
    ['budget_exhausted', 4],
    ['aborted', 5],
  ] as const)('%s → %d', (status, code) => {
    expect(headlessExitCode(status)).toBe(code);
  });
});

describe('buildHeadlessReport', () => {
  it('snake_case 结构化输出，ok 与 exit_code 一致', () => {
    const report = buildHeadlessReport({
      status: 'completed',
      result: '完成',
      transcript: '完成',
      turns: 2,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
      toolCalls: [{ id: 'c1', name: 'list_dir', ok: true }],
      todos: [{ content: 'x', status: 'done' }],
      deniedConfirmations: [],
      askUserQuestions: [],
      planApprovals: 0,
      error: null,
      durationMs: 1234,
      sessionId: 's1',
      projectId: 'p1',
    });
    expect(report).toEqual({
      ok: true,
      status: 'completed',
      exit_code: 0,
      session_id: 's1',
      project_id: 'p1',
      result: '完成',
      turns: 2,
      duration_ms: 1234,
      usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.001 },
      tool_calls: [{ id: 'c1', name: 'list_dir', ok: true }],
      todos: [{ content: 'x', status: 'done' }],
      denied_confirmations: [],
      ask_user_questions: [],
      plan_approvals: 0,
      error: null,
    });
  });

  it('失败报告：ok=false 且 error 透传', () => {
    const report = buildHeadlessReport({
      status: 'failed',
      result: '',
      transcript: '',
      turns: 1,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      toolCalls: [],
      todos: [],
      deniedConfirmations: [],
      askUserQuestions: [],
      planApprovals: 0,
      error: 'boom',
      durationMs: 10,
      sessionId: 's1',
      projectId: 'p1',
    });
    expect(report.ok).toBe(false);
    expect(report.exit_code).toBe(2);
    expect(report.error).toBe('boom');
  });
});
