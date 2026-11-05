/**
 * F-55 外部事件映射引擎单测（docs/design-f55-external-cli-agents.md §4）：
 * ExternalEvent → AgentEvent 逐条映射规则 + done 必达 + abort / 未注册兜底。
 * adapter 用内联 AsyncGenerator 脚本化吐事件，零真实 CLI、零协议解析。
 */
import { describe, expect, it } from 'vitest';
import type { AgentEvent, ConfirmDecision, ConfirmRequest } from '@delta/shared';
import { runExternalAgent } from '../src/engine/external.js';
import type { RunContext } from '../src/engine/react.js';
import { registerExternalAdapter } from '../src/external/registry.js';
import type { ExternalAgentAdapter, ExternalAgentSpec, ExternalEvent } from '../src/external/types.js';

const MODEL = 'cli:fake';

function baseSpec(overrides: Partial<ExternalAgentSpec> = {}): ExternalAgentSpec {
  return {
    id: MODEL,
    kind: 'stream-json-jsonl',
    command: 'fake-cli',
    args: [],
    tier: 'B',
    version: '0.0.0-test',
    permissionArgs: { plan: [], default: [], yolo: [] },
    ...overrides,
  };
}

interface RunCapture {
  prompt: string;
  cwd: string;
  permissionMode: 'plan' | 'default' | 'yolo';
  signal: AbortSignal;
}

/** 内联 adapter：按脚本吐 ExternalEvent，记录 run 入参，可挂 respondPermission 探针 */
function scriptAdapter(
  script: ExternalEvent[],
  opts: {
    signal?: AbortController;
    spec?: Partial<ExternalAgentSpec>;
    /** 吐出第一个事件后立刻 abort（模拟运行中用户中断） */
    abortAfterFirst?: boolean;
    /** 每个事件吐出前的延迟（ms），供打点计时断言用 */
    delayMs?: number;
    respondPermission?: (permissionId: string, decision: 'allow' | 'allow_session' | 'reject') => void;
    /** adapter 级 stderr 环形缓冲快照（进程异常收尾时随 error 事件带出） */
    stderrTail?: string[];
  } = {},
): ExternalAgentAdapter & { captures: RunCapture[]; decisions: Array<{ id: string; decision: string }> } {
  const self: ExternalAgentAdapter & { captures: RunCapture[]; decisions: Array<{ id: string; decision: string }> } = {
    spec: baseSpec(opts.spec),
    captures: [],
    decisions: [],
    run: async function* (req) {
      self.captures.push(req);
      let first = true;
      for (const ev of script) {
        // 模拟真实 adapter 对 abort 的响应：信号中止即停止吐事件
        if (opts.signal?.signal.aborted) break;
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        yield ev;
        if (first && opts.abortAfterFirst) opts.signal?.abort();
        first = false;
      }
    },
  };
  // 探针：记录映射引擎回传的权限决定（映射规则断言数据源）
  self.respondPermission = (id, decision) => {
    self.decisions.push({ id, decision });
    opts.respondPermission?.(id, decision);
  };
  if (opts.stderrTail) self.stderrTail = () => opts.stderrTail!;
  return self;
}

/** 极简 RunContext：只填 runExternalAgent 用到的字段 */
function makeCtx(opts: {
  controller?: AbortController;
  confirm?: (req: ConfirmRequest) => Promise<ConfirmDecision>;
  permissionsMode?: 'plan' | 'default' | 'yolo';
  model?: string;
} = {}): RunContext {
  const controller = opts.controller ?? new AbortController();
  const confirm = opts.confirm ?? (async () => ({ kind: 'allow' }) as ConfirmDecision);
  return {
    sessionId: 's_test',
    projectId: 'p_test',
    mode: 'react',
    model: opts.model ?? MODEL,
    systemPrompt: '',
    maxTurns: 1,
    signal: controller.signal,
    provider: {} as never,
    registry: {} as never,
    toolContext: {
      projectRoot: '/tmp/fake-project',
      signal: controller.signal,
      confirm,
      ...(opts.permissionsMode ? { permissions: { policy: { mode: opts.permissionsMode } } as never } : {}),
    },
    budget: {} as never,
    windowTokens: 100_000,
  } as unknown as RunContext;
}

async function collect(ctx: RunContext, input = '你好'): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of runExternalAgent(ctx, [], input)) events.push(ev);
  return events;
}

const types = (events: AgentEvent[]): string[] => events.map((e) => e.type);

describe('runExternalAgent（F-55 事件映射引擎）', () => {
  it('引擎启动发一次 turn_start {turn:1}，text/thinking 透传为对应 delta', async () => {
    const adapter = scriptAdapter([
      { type: 'text', text: '你好' },
      { type: 'thinking', text: '思考中' },
      { type: 'text', text: '，世界' },
      { type: 'done', exitCode: 0 },
    ]);
    registerExternalAdapter(adapter);
    const events = await collect(makeCtx());

    expect(types(events)).toEqual(['turn_start', 'text_delta', 'thinking_delta', 'text_delta', 'done']);
    expect(events[0]).toEqual({ type: 'turn_start', turn: 1 });
    expect(events[1]).toEqual({ type: 'text_delta', text: '你好' });
    expect(events[2]).toEqual({ type: 'thinking_delta', text: '思考中' });
    expect(events[4]).toEqual({
      type: 'done',
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    });
  });

  it('tool_use → tool_call_start 且 argsJson 原样透传（不 parse/不改写字节）', async () => {
    const rawArgs = '{"path": "a b/c d.txt", "note": "he said \\"hi\\", 仔细看"}';
    const adapter = scriptAdapter([
      { type: 'tool_use', id: 'tu_1', name: 'write_file', argsJson: rawArgs },
      { type: 'done', exitCode: 0 },
    ]);
    registerExternalAdapter(adapter);
    const events = await collect(makeCtx());

    const start = events.find((e) => e.type === 'tool_call_start');
    expect(start).toBeDefined();
    if (start?.type === 'tool_call_start') {
      expect(start.call).toEqual({ id: 'tu_1', name: 'write_file', argsJson: rawArgs });
      expect(start.call.args).toBeUndefined(); // 未 parse
    }
  });

  it('tool_result → ms 由本地打点计算（>0），content 超 50k 保尾截断且尾部内容保留', async () => {
    const tail = 'TAIL_SENTINEL_最后的结论是交付完成';
    const head = 'HEAD_START_被丢弃的前缀' + 'H'.repeat(60_000);
    const adapter = scriptAdapter(
      [
        { type: 'tool_use', id: 'tu_1', name: 'big_tool', argsJson: '{}' },
        { type: 'tool_result', id: 'tu_1', ok: true, content: head + tail },
        { type: 'done', exitCode: 0 },
      ],
      { delayMs: 12 },
    );
    registerExternalAdapter(adapter);
    const events = await collect(makeCtx());

    const result = events.find((e) => e.type === 'tool_result');
    expect(result).toBeDefined();
    if (result?.type === 'tool_result') {
      expect(result.ms).toBeGreaterThan(0);
      expect(result.result.ok).toBe(true);
      expect(result.result.callId).toBe('tu_1');
      // ≤ 50k + 标记行（标记远小于 1k，给 1k 余量）
      expect(result.result.content.length).toBeLessThanOrEqual(50_000 + 1_000);
      // 尾部内容保留（保尾口径）
      expect(result.result.content.endsWith(tail)).toBe(true);
      // 头部前缀被截掉，标记行顶在开头
      expect(result.result.content.startsWith('（内容过长，前')).toBe(true);
      expect(result.result.content).not.toContain('HEAD_START_被丢弃的前缀');
    }
  });

  it('tool_result 无配对 start 时 ms=0', async () => {
    const adapter = scriptAdapter([
      { type: 'tool_result', id: 'orphan', ok: false, content: '孤儿结果' },
      { type: 'done', exitCode: 0 },
    ]);
    registerExternalAdapter(adapter);
    const events = await collect(makeCtx());

    const result = events.find((e) => e.type === 'tool_result');
    if (result?.type === 'tool_result') {
      expect(result.ms).toBe(0);
      expect(result.result.ok).toBe(false);
      expect(result.call.id).toBe('orphan');
    }
  });

  it.each<[ConfirmDecision['kind'], 'allow' | 'allow_session' | 'reject']>([
    ['allow', 'allow'],
    ['allow_session', 'allow_session'],
    ['reject', 'reject'],
    ['edit', 'reject'], // 外部 agent 无法回填编辑参数，edit 视作 reject
  ])('permission_request：confirm 决定 %s → respondPermission 收到 %s', async (kind, expected) => {
    const confirmCalls: ConfirmRequest[] = [];
    const decision: ConfirmDecision =
      kind === 'allow_session'
        ? { kind: 'allow_session', tool: 'exec' }
        : kind === 'edit'
          ? { kind: 'edit', args: {} }
          : ({ kind } as ConfirmDecision);
    const adapter = scriptAdapter(
      [
        { type: 'permission_request', id: 'perm_1', tool: 'exec', argsJson: '{"cmd":"ls -la"}', options: ['allow', 'reject'] },
        { type: 'done', exitCode: 0 },
      ],
    );
    registerExternalAdapter(adapter);
    const ctx = makeCtx({
      confirm: async (req) => {
        confirmCalls.push(req);
        return decision;
      },
    });
    const events = await collect(ctx);

    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0]).toMatchObject({
      id: 'perm_1',
      tool: 'exec',
      args: { cmd: 'ls -la' },
      reason: '外部 agent 请求执行 exec',
    });
    expect(adapter.decisions).toEqual([{ id: 'perm_1', decision: expected }]);
    // confirm_request 事件由 hub 的 toolContext.confirm 负责 publish，映射引擎不重复产出
    expect(events.some((e) => e.type === 'confirm_request')).toBe(false);
  });

  it('permission_request 的 argsJson 解析失败时按空参数确认', async () => {
    const confirmCalls: ConfirmRequest[] = [];
    const adapter = scriptAdapter([
      { type: 'permission_request', id: 'perm_2', tool: 'write_file', argsJson: '{broken json', options: [] },
      { type: 'done', exitCode: 0 },
    ]);
    registerExternalAdapter(adapter);
    await collect(makeCtx({ confirm: async (req) => { confirmCalls.push(req); return { kind: 'reject' }; } }));

    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0].args).toEqual({});
  });

  it('plan → plan_created：revision 0、external true、占位节点只展示不进 DAG', async () => {
    const adapter = scriptAdapter([
      {
        type: 'plan',
        steps: [
          { title: '读取配置', status: 'completed' },
          { title: '执行迁移', status: 'in_progress' },
          { title: '验证结果', status: 'pending' },
        ],
      },
      { type: 'done', exitCode: 0 },
    ]);
    registerExternalAdapter(adapter);
    const events = await collect(makeCtx());

    const created = events.find((e) => e.type === 'plan_created');
    expect(created).toBeDefined();
    if (created?.type === 'plan_created') {
      expect(created.plan.revision).toBe(0);
      expect(created.plan.external).toBe(true);
      expect(created.plan.nodes).toHaveLength(3);
      expect(created.plan.nodes.map((n) => n.status)).toEqual(['done', 'running', 'pending']);
    }
  });

  it('usage → costUsd 0、billing subscription、model cli:fake，done 累计 usageTotal', async () => {
    const adapter = scriptAdapter([
      { type: 'usage', input: 100, output: 20 },
      { type: 'usage', input: 50, output: 30 },
      { type: 'done', exitCode: 0 },
    ]);
    registerExternalAdapter(adapter);
    const events = await collect(makeCtx());

    const usages = events.filter((e) => e.type === 'usage');
    expect(usages).toHaveLength(2);
    expect(usages[0]).toEqual({
      type: 'usage',
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0 },
      model: MODEL,
      billing: 'subscription',
    });
    const done = events.find((e) => e.type === 'done');
    if (done?.type === 'done') {
      expect(done.usage).toEqual({ inputTokens: 150, outputTokens: 50, costUsd: 0 });
    }
  });

  it('external_session 不产出事件（resume 令牌经 onExternalSession 上报，见 external-resume.test.ts）', async () => {
    const adapter = scriptAdapter([
      { type: 'external_session', id: 'sess_abc' },
      { type: 'text', text: 'hi' },
      { type: 'done', exitCode: 0 },
    ]);
    registerExternalAdapter(adapter);
    const events = await collect(makeCtx());

    expect(types(events)).toEqual(['turn_start', 'text_delta', 'done']);
  });

  it('error 事件透传且 fatal 照搬上游', async () => {
    const adapter = scriptAdapter([
      { type: 'error', message: '协议不识别', fatal: false },
      { type: 'error', message: '初始化失败', fatal: true },
      { type: 'done', exitCode: 0 },
    ]);
    registerExternalAdapter(adapter);
    const events = await collect(makeCtx());

    const errs = events.filter((e) => e.type === 'error');
    expect(errs).toEqual([
      { type: 'error', message: '协议不识别', fatal: false },
      { type: 'error', message: '初始化失败', fatal: true },
    ]);
    // done 必达
    expect(events.at(-1)?.type).toBe('done');
  });

  it('done 必达：上游不发 done 事件且 exit 非 0、无产出 → fatal error（exit 3）+ done', async () => {
    // 脚本末尾没有 ExternalEvent done：adapter 流自然结束
    const adapter = scriptAdapter([{ type: 'error', message: 'boom', fatal: false }]);
    registerExternalAdapter(adapter);
    const events = await collect(makeCtx());

    expect(events.at(-1)?.type).toBe('done');
    const errs = events.filter((e) => e.type === 'error');
    expect(errs).toContainEqual({ type: 'error', message: 'boom', fatal: false });
    expect(errs).toContainEqual({ type: 'error', message: '外部 agent 进程退出（exit -1）', fatal: true });
  });

  it('非零退出无产出 → error fatal true；有 text 产出 → error fatal false；done 均照发', async () => {
    // 分支一：无产出
    const noOutput = scriptAdapter([{ type: 'done', exitCode: 3 }]);
    registerExternalAdapter(noOutput);
    const eventsA = await collect(makeCtx());
    expect(eventsA.at(-1)?.type).toBe('done');
    const errsA = eventsA.filter((e) => e.type === 'error');
    expect(errsA).toEqual([{ type: 'error', message: '外部 agent 进程退出（exit 3）', fatal: true }]);

    // 分支二：有 text 产出
    const withOutput = scriptAdapter([
      { type: 'text', text: '部分结果已经给出' },
      { type: 'done', exitCode: 3 },
    ]);
    registerExternalAdapter(withOutput);
    const eventsB = await collect(makeCtx());
    expect(eventsB.at(-1)?.type).toBe('done');
    const errsB = eventsB.filter((e) => e.type === 'error');
    expect(errsB).toEqual([{ type: 'error', message: '外部 agent 进程退出（exit 3）', fatal: false }]);
  });

  it('信号已 aborted：error aborted by user（fatal false）+ done，adapter 不启动', async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = scriptAdapter([{ type: 'text', text: '不该出现' }], { signal: controller });
    registerExternalAdapter(adapter);
    const events = await collect(makeCtx({ controller }));

    expect(adapter.captures).toHaveLength(0); // 未启动 adapter
    expect(types(events)).toEqual(['error', 'done']);
    expect(events[0]).toEqual({ type: 'error', message: 'aborted by user', fatal: false });
  });

  it('运行中 abort：error 文案与三引擎逐字一致且 fatal false，之后仍有 done', async () => {
    const controller = new AbortController();
    const adapter = scriptAdapter(
      [
        { type: 'text', text: '写到一半' },
        { type: 'done', exitCode: 0 },
      ],
      { signal: controller, abortAfterFirst: true },
    );
    registerExternalAdapter(adapter);
    const events = await collect(makeCtx({ controller }));

    const abortIdx = events.findIndex((e) => e.type === 'error' && e.message === 'aborted by user');
    expect(abortIdx).toBeGreaterThanOrEqual(0);
    expect(events[abortIdx]).toEqual({ type: 'error', message: 'aborted by user', fatal: false });
    const doneIdx = events.findIndex((e) => e.type === 'done');
    expect(doneIdx).toBeGreaterThan(abortIdx);
  });

  it('未注册 adapter → external_agent_not_found fatal error + done（零值 usage）', async () => {
    const events = await collect(makeCtx({ model: 'cli:missing' }));

    expect(types(events)).toEqual(['error', 'done']);
    expect(events[0]).toEqual({ type: 'error', message: 'external_agent_not_found: cli:missing', fatal: true });
    expect(events[1]).toEqual({ type: 'done', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } });
  });

  it('adapter.run 收到 prompt/cwd/permissionMode/signal；permissions.mode 透传', async () => {
    const controller = new AbortController();
    const adapter = scriptAdapter([{ type: 'done', exitCode: 0 }], { signal: controller });
    registerExternalAdapter(adapter);
    const ctx = makeCtx({ controller, permissionsMode: 'yolo' });
    await collect(ctx, '帮我跑个任务');

    expect(adapter.captures).toHaveLength(1);
    expect(adapter.captures[0]).toMatchObject({
      prompt: '帮我跑个任务',
      cwd: '/tmp/fake-project',
      permissionMode: 'yolo',
      signal: controller.signal,
    });
  });

  it('全事件扫描：全程不出现 compact_*/budget_*/subtask_*/review_verdict', async () => {
    const adapter = scriptAdapter([
      { type: 'text', text: '开始' },
      { type: 'thinking', text: '想想' },
      { type: 'tool_use', id: 't1', name: 'ls', argsJson: '{}' },
      { type: 'tool_result', id: 't1', ok: true, content: 'ok' },
      { type: 'permission_request', id: 'p1', tool: 'exec', argsJson: '{}', options: [] },
      { type: 'plan', steps: [{ title: 'step', status: 'pending' }] },
      { type: 'usage', input: 1, output: 1 },
      { type: 'external_session', id: 's' },
      { type: 'error', message: 'warn', fatal: false },
      { type: 'done', exitCode: 0 },
    ]);
    registerExternalAdapter(adapter);
    const ctx = makeCtx({ confirm: async () => ({ kind: 'allow' }) });
    const events = await collect(ctx);

    const forbidden = /^compact_|^budget_|^subtask_|^review_verdict$/;
    const offenders = events.filter((e) => forbidden.test(e.type));
    expect(offenders).toEqual([]);
  });

  it('非零退出收尾：adapter.stderrTail 前 20 行随 error 消息带出（§9）', async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `err-line-${i + 1}`);
    const adapter = scriptAdapter([{ type: 'done', exitCode: 3 }], { stderrTail: lines });
    registerExternalAdapter(adapter);
    const events = await collect(makeCtx());
    const err = events.find((e) => e.type === 'error');
    expect(err?.type === 'error' && err.fatal).toBe(true); // 无产出 → fatal
    expect(err?.type === 'error' && err.message).toContain('exit 3');
    expect(err?.type === 'error' && err.message).toContain('err-line-1');
    expect(err?.type === 'error' && err.message).not.toContain('err-line-21'); // 只带前 20 行
    expect(events.at(-1)?.type).toBe('done'); // done 必达
  });

  it('上游已发 fatal error 后进程非零退出 → error 去重不连发，done 照发', async () => {
    const adapter = scriptAdapter([
      { type: 'error', message: 'boom', fatal: true },
      { type: 'done', exitCode: 3 },
    ]);
    registerExternalAdapter(adapter);
    const events = await collect(makeCtx());
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.type === 'error' && errors[0]!.message).toBe('boom');
    expect(events.at(-1)?.type).toBe('done');
  });
});
