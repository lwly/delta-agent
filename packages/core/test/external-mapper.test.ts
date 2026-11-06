/**
 * F-55 外部事件映射引擎单测（docs/design-f55-external-cli-agents.md §4）：
 * ExternalEvent → AgentEvent 逐条映射规则 + done 必达 + abort / 未注册兜底。
 * adapter 用内联 AsyncGenerator 脚本化吐事件，零真实 CLI、零协议解析。
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ConfirmDecision, ConfirmRequest } from '@delta/shared';
import { runExternalAgent } from '../src/engine/external.js';
import type { RunContext } from '../src/engine/react.js';
import { registerExternalAdapter, registerExternalAdapterFactory, resolveExternalAdapter } from '../src/external/registry.js';
import { cancelAllExternalRuns } from '../src/external/lifecycle.js';
import { spawnExternal, type SpawnedProcess } from '../src/external/spawn.js';
import type { ExternalAgentAdapter, ExternalAgentSpec, ExternalEvent } from '../src/external/types.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
  /** P4 dispose 全杀测试用：真实子进程的 cwd */
  projectRoot?: string;
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
      projectRoot: opts.projectRoot ?? '/tmp/fake-project',
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
    // F-58（§6③）：done 如实带出退出码（含 0）
    expect(events[4]).toEqual({
      type: 'done',
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      exitCode: 0,
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

  it('auth_required/auth_url → external_auth_required 稳定码提示（fatal false，消息带认证方式与登录链接）', async () => {
    const adapter = scriptAdapter([
      { type: 'auth_required', methods: [{ id: 'iOA', name: 'iOA 账号' }] },
      { type: 'auth_url', url: 'https://example.com/login?token=abc' },
      { type: 'text', text: 'after-auth' },
      { type: 'done', exitCode: 0 },
    ]);
    registerExternalAdapter(adapter);
    const events = await collect(makeCtx());

    const errs = events.filter((e) => e.type === 'error');
    expect(errs).toHaveLength(2);
    expect(errs.every((e) => e.type === 'error' && e.fatal === false)).toBe(true);
    expect(errs[0]!.message).toContain('external_auth_required');
    expect(errs[0]!.message).toContain('iOA 账号');
    expect(errs[1]!.message).toContain('external_auth_required');
    expect(errs[1]!.message).toContain('https://example.com/login?token=abc');
    // 认证期间会话继续跑：text 照常透传
    expect(types(events)).toContain('text_delta');
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

// ═══════════════════════════════════════════════════════════════════════════
// F-55 P4 多外部 agent 并发（工厂语义注册表）+ dispose 全杀（AC-55-5）
// 设计稿 §13 出口标准：两会话并行不串事件；AC-55-5：serve dispose 后无孤儿进程。
// 注：并入本文件而非独立 external-concurrent.test.ts——本机（Node v22.23.2，
// threads pool）全量 vitest run 的 worker teardown（CppHeap::DetachIsolate）
// 存在**资源累积型 SIGSEGV**（P4 审查实测 111 文件也 5 跑 4 崩、崩点漂移，
// 并非精确文件数阈值；2026-10-29 起即有同签名 crash report，环境缺陷与测试
// 内容无关）。可靠规避：全量验证加 `--isolate=false`（实测稳定）；forks 池
// 会踩沙箱 TMPDIR 的 vite-node ssr 缓存 ENOENT，node v20 亦挂，不可替代。
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 轮询并发驱动：两个 generator 交替拉取，制造真实并发交错
 * （顺序 drain 不会触发「A run 让出控制权窗口内 B run 覆盖共享状态」的互踩路径）。
 */
async function zipDrain(gens: AsyncGenerator<AgentEvent>[]): Promise<AgentEvent[][]> {
  const out: AgentEvent[][] = gens.map(() => []);
  const iters = gens.map((g) => g[Symbol.asyncIterator]());
  const active = gens.map(() => true);
  while (active.some(Boolean)) {
    for (let i = 0; i < gens.length; i++) {
      if (!active[i]) continue;
      const r = await iters[i]!.next();
      if (r.done) {
        active[i] = false;
        continue;
      }
      out[i]!.push(r.value);
    }
  }
  return out;
}

/**
 * 标记 adapter：run 时把 req.prompt 写入实例字段，让出控制权（20ms）后再读出吐 text。
 * 共享单例（工厂语义前）时另一 run 会在窗口内覆盖 current → 两流都吐后写的 marker（互踩）；
 * 每 run 独立实例时各吐自己的 marker。usage.input 取 marker 长度，供串线断言二次校验。
 */
class MarkerAdapter implements ExternalAgentAdapter {
  readonly spec: ExternalAgentSpec;
  private current: string | null = null;
  constructor(id: string) {
    this.spec = baseSpec(id);
  }
  async *run(req: { prompt: string; signal: AbortSignal }): AsyncGenerator<ExternalEvent> {
    this.current = req.prompt;
    // 让出控制权：共享实例时另一 run 在此窗口覆盖 current（TDD 红线：工厂语义前必互踩）
    await new Promise((r) => setTimeout(r, 20));
    yield { type: 'text', text: this.current! };
    yield { type: 'usage', input: this.current!.length, output: 0 };
    yield { type: 'done', exitCode: 0 };
  }
}

describe('F-55 P4 多外部 agent 并发（工厂语义注册表）', () => {
  it('同一 model 两会话并发：每 run 独立实例，事件互不串（§13 出口标准）', async () => {
    registerExternalAdapterFactory('cli:fake', () => new MarkerAdapter('cli:fake'));
    const ctxA = makeCtx({ model: 'cli:fake' });
    const ctxB = makeCtx({ model: 'cli:fake' });

    const [eventsA, eventsB] = await zipDrain([
      runExternalAgent(ctxA, [], 'marker-A'),
      runExternalAgent(ctxB, [], 'marker-B'),
    ]);

    // 各自的 text_delta 是自己的 marker（共享单例时 B 会覆盖 A，两流都吐 marker-B）
    const textA = eventsA.filter((e) => e.type === 'text_delta');
    const textB = eventsB.filter((e) => e.type === 'text_delta');
    expect(textA).toEqual([{ type: 'text_delta', text: 'marker-A' }]);
    expect(textB).toEqual([{ type: 'text_delta', text: 'marker-B' }]);

    // usage 不串：各流 usage.input 是自己 marker 的长度
    const usageA = eventsA.find((e) => e.type === 'usage');
    const usageB = eventsB.find((e) => e.type === 'usage');
    expect(usageA).toMatchObject({ usage: { inputTokens: 'marker-A'.length } });
    expect(usageB).toMatchObject({ usage: { inputTokens: 'marker-B'.length } });

    // done 必达：各流恰好一次
    expect(eventsA.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(eventsB.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('不同 model 两会话并发：cli:fake-a / cli:fake-b 事件互不串', async () => {
    registerExternalAdapterFactory('cli:fake-a', () => new MarkerAdapter('cli:fake-a'));
    registerExternalAdapterFactory('cli:fake-b', () => new MarkerAdapter('cli:fake-b'));
    const ctxA = makeCtx({ model: 'cli:fake-a' });
    const ctxB = makeCtx({ model: 'cli:fake-b' });

    const [eventsA, eventsB] = await zipDrain([
      runExternalAgent(ctxA, [], 'alpha'),
      runExternalAgent(ctxB, [], 'beta'),
    ]);

    expect(eventsA.filter((e) => e.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'alpha' }]);
    expect(eventsB.filter((e) => e.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'beta' }]);
    expect(eventsA.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(eventsB.filter((e) => e.type === 'done')).toHaveLength(1);
  });
});

// ── dispose 全杀（AC-55-5）：真实子进程 fixture ──

/** 长驻 fixture 脚本：打印 pid 到 stderr 后 setInterval 长驻（等 cancelAllExternalRuns 全杀） */
const LONG_NODE_SCRIPT = `process.stderr.write('PID:' + process.pid + '\\n'); setInterval(() => {}, 1000);`;

/**
 * 长驻进程 adapter：spawn node -e fixture，从 stderr 捕获 pid 供测试断言进程死亡；
 * cancel() 取消自身 lastProc（spawnExternal.cancel 幂等）——dispose 全杀的协议入口。
 */
class LongProcAdapter implements ExternalAgentAdapter {
  readonly spec: ExternalAgentSpec = baseSpec('cli:long', {
    command: process.execPath,
    args: ['-e', LONG_NODE_SCRIPT],
  });
  lastProc: SpawnedProcess | null = null;
  /** fixture 进程 pid（stderr PID: 行捕获；null = 尚未打印） */
  pid: number | null = null;

  async *run(req: { cwd: string; signal: AbortSignal }): AsyncGenerator<ExternalEvent> {
    const proc = spawnExternal({
      command: process.execPath,
      args: ['-e', LONG_NODE_SCRIPT],
      cwd: req.cwd,
      envWhitelist: [],
      signal: req.signal,
    });
    this.lastProc = proc;
    for await (const ev of proc.events) {
      if (ev.type === 'stderr_line') {
        const m = /^PID:(\d+)$/.exec(ev.text.trim());
        if (m) this.pid = Number(m[1]);
      } else if (ev.type === 'exit') {
        // 被杀收尾：code 为 null（信号终止）→ 统一 -1，映射引擎的非零退出兜底路径可达
        yield { type: 'done', exitCode: ev.code ?? -1 };
      }
    }
  }

  async cancel(): Promise<void> {
    await this.lastProc?.cancel();
  }
}

/** 一次性进程 adapter：echo 一行后自然退出（dispose 后注册表不受影响 → 下一会话可再跑） */
class EchoAdapter implements ExternalAgentAdapter {
  readonly spec: ExternalAgentSpec = baseSpec('cli:echo', {
    command: process.execPath,
    args: ['-e', "process.stdout.write('ok')"],
  });
  async *run(req: { cwd: string; signal: AbortSignal }): AsyncGenerator<ExternalEvent> {
    const proc = spawnExternal({
      command: process.execPath,
      args: ['-e', "process.stdout.write('ok')"],
      cwd: req.cwd,
      envWhitelist: [],
      signal: req.signal,
    });
    try {
      for await (const ev of proc.events) {
        if (ev.type === 'line') yield { type: 'text', text: ev.text };
        else if (ev.type === 'exit') yield { type: 'done', exitCode: ev.code ?? -1 };
      }
    } finally {
      await proc.cancel(); // 消费方提前 break 时收敛子进程；已退出时幂等
    }
  }
}

describe('F-55 P4 dispose 全杀（AC-55-5：serve dispose 后无孤儿进程）', () => {
  it('两个长驻进程并发 run：cancelAllExternalRuns 全杀（1.5s 内退出）', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'delta-f55-conc-'));
    const instances: LongProcAdapter[] = [];
    registerExternalAdapterFactory('cli:long', () => {
      const a = new LongProcAdapter();
      instances.push(a);
      return a;
    });

    // 两个会话并发启动（不 await：generator 惰性，collect 同步推进到首个挂起点即完成 spawn）
    const drainA = collect(makeCtx({ model: 'cli:long', projectRoot: tmpDir }), 'a');
    const drainB = collect(makeCtx({ model: 'cli:long', projectRoot: tmpDir }), 'b');

    // 等 fixture 进程都起来并打印 pid（证明 engine 的 trackExternalRun 已生效）；
    // 显式 3s 超时：慢机上两次 node spawn 打印 pid 可能贴默认 1s 线（P4 审查 nit）
    await vi.waitFor(
      () => {
        expect(instances).toHaveLength(2);
        expect(instances.every((i) => i.pid !== null)).toBe(true);
      },
      { timeout: 3000 },
    );

    const startedAt = Date.now();
    await cancelAllExternalRuns();
    const elapsed = Date.now() - startedAt;
    const [eventsA, eventsB] = await Promise.all([drainA, drainB]);

    // 两流 done 必达（被杀收尾走映射引擎非零退出兜底，error 非 fatal 阻断不了 done）
    expect(eventsA.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(eventsB.filter((e) => e.type === 'done')).toHaveLength(1);

    // 两进程均已退出（POSIX kill(pid,0) 探活抛错）
    for (const inst of instances) {
      expect(() => process.kill(inst.pid!, 0)).toThrow();
    }
    // AC-55-5：停止 1s 内退出 + 300ms 宽限余量
    expect(elapsed).toBeLessThan(1500);
  });

  it('cancelAllExternalRuns 重复调用幂等（dispose 二次收尾不炸）', async () => {
    await cancelAllExternalRuns();
    await expect(cancelAllExternalRuns()).resolves.toBeUndefined();
  });

  it('dispose 后注册表不受影响：工厂仍可解析且产出新实例，下一会话可再跑', async () => {
    const factory = resolveExternalAdapter('cli:long');
    expect(factory).toBeDefined();
    const fresh = factory!();
    expect(fresh).not.toBeNull();

    // 真实再跑一轮一次性会话：cancelAll 只杀运行，不摘除注册
    registerExternalAdapterFactory('cli:echo', () => new EchoAdapter());
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'delta-f55-echo-'));
    const events = await collect(makeCtx({ model: 'cli:echo', projectRoot: tmpDir }), 'go');
    expect(events.filter((e) => e.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'ok' }]);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });
});
