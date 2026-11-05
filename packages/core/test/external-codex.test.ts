/**
 * F-55 Tier C Codex app-server 适配器单测（docs/design-f55-external-cli-agents.md §2/§3/§9）：
 *  - 全部走 spawnExternal + fake-codex.mjs fixture（JSON-RPC over stdio），零网络、零真实 CLI；
 *  - 协议形状以 codex-cli 0.162.0-alpha.17.2 的 generate-json-schema + 真机 probe 为准
 *    （method 斜杠拼写、审批 decision 枚举、tokenUsage 通知，见 external/codex.ts 头注释）；
 *  - 场景经 FAKE_CODEX_SCRIPT env 注入 fixture（adapter 镜像为子进程 env，对齐既有先例）；
 *  - fatal 判定归映射引擎（engine/external.ts），本层只透传退出码与 error fatal:false。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_AGENTS, detectedToSpec } from '../src/external/detect.js';
import { CodexExternalAdapter } from '../src/external/codex.js';
import type { ExternalAgentSpec, ExternalEvent } from '../src/external/types.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-codex.mjs');
const NODE = process.execPath;

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'yz-ext-codex-'));
});
afterEach(async () => {
  delete process.env.FAKE_CODEX_SCRIPT;
  await rm(tmp, { recursive: true, force: true });
});

function makeSpec(): ExternalAgentSpec {
  return {
    id: 'cli:codex',
    kind: 'app-server-jsonl',
    command: NODE,
    // 生产中 spec.args=[]，'app-server' 由适配器按协议静态携带；测试经 spec.args 指向 fixture
    args: [FIXTURE],
    tier: 'C',
    version: 'fake',
    // fixture 无权限 flags 语义，三档全空
    permissionArgs: { plan: [], default: [], yolo: [] },
  };
}

async function writeScenario(scenario: Record<string, unknown>): Promise<string> {
  const p = path.join(tmp, `scenario-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(p, JSON.stringify(scenario));
  return p;
}

interface RunOptions {
  signal?: AbortSignal;
  prompt?: string;
  resumeSessionId?: string;
}

/** 跑一轮会话并收集事件（done 即止） */
async function runScenario(
  adapter: CodexExternalAdapter,
  scenario: Record<string, unknown>,
  opts: RunOptions = {},
): Promise<ExternalEvent[]> {
  const events: ExternalEvent[] = [];
  for await (const ev of startScenario(adapter, scenario, opts)) {
    events.push(ev);
    if (ev.type === 'done') break;
  }
  return events;
}

/** 写场景文件 + 置 FAKE_CODEX_SCRIPT 后返回原始事件迭代器（供测试中途 abort / respondPermission） */
async function* startScenario(
  adapter: CodexExternalAdapter,
  scenario: Record<string, unknown>,
  opts: RunOptions = {},
): AsyncGenerator<ExternalEvent> {
  const scenarioPath = await writeScenario(scenario);
  process.env.FAKE_CODEX_SCRIPT = scenarioPath;
  yield* adapter.run({
    prompt: opts.prompt ?? 'hi',
    cwd: tmp,
    permissionMode: 'default',
    resumeSessionId: opts.resumeSessionId,
    signal: opts.signal ?? new AbortController().signal,
  });
}

/** stderrTail 里的 recv 日志 → [method, params] 有序数组（握手序断言用） */
function recvLog(adapter: CodexExternalAdapter): Array<{ method: string; params: Record<string, unknown> }> {
  return adapter
    .stderrTail()
    .filter((l) => l.includes('[fake-codex] recv:'))
    .map((l) => {
      const body = l.slice(l.indexOf('recv:') + 5).trim();
      const idx = body.indexOf(' ');
      return { method: body.slice(0, idx), params: JSON.parse(body.slice(idx + 1)) as Record<string, unknown> };
    });
}

describe('CodexExternalAdapter（F-55 Tier C：app-server v2 JSON-RPC over stdio）', () => {
  it('握手序 initialize → thread/start → turn/start：method 名与参数形状正确 + external_session → text → done', async () => {
    const adapter = new CodexExternalAdapter(makeSpec());
    const events = await runScenario(adapter, {
      steps: [{ type: 'agentMessageDelta', delta: 'hello' }],
    });
    // 握手序断言（stderr recv 日志按到达顺序）
    const log = recvLog(adapter);
    expect(log.map((e) => e.method)).toEqual(['initialize', 'thread/start', 'turn/start']);
    expect(log[0]!.params).toMatchObject({ clientInfo: { name: 'delta-agent' }, capabilities: {} });
    expect(log[1]!.params).toEqual({ cwd: tmp });
    expect(log[2]!.params).toMatchObject({ threadId: 'fake-codex-thread-1', input: [{ type: 'text', text: 'hi' }] });
    expect(events[0]).toEqual({ type: 'external_session', id: 'fake-codex-thread-1' });
    expect(events).toContainEqual({ type: 'text', text: 'hello' });
    expect(events[events.length - 1]).toEqual({ type: 'done', exitCode: 0 });
  });

  it('agentMessageDelta → text；reasoningDelta → thinking；未知通知忽略不崩', async () => {
    const adapter = new CodexExternalAdapter(makeSpec());
    const events = await runScenario(adapter, {
      steps: [
        { type: 'reasoningDelta', delta: 'pondering' },
        { type: 'agentMessageDelta', delta: 'answer' },
        { type: 'notification', method: 'future/unknownNotification', params: { x: 1 } },
      ],
    });
    expect(events).toContainEqual({ type: 'thinking', text: 'pondering' });
    expect(events).toContainEqual({ type: 'text', text: 'answer' });
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(events[events.length - 1]).toEqual({ type: 'done', exitCode: 0 });
  });

  it('命令执行 item started/completed → tool_use + tool_result（exitCode 判 ok；fileChange 同理）', async () => {
    const adapter = new CodexExternalAdapter(makeSpec());
    const events = await runScenario(adapter, {
      steps: [
        {
          type: 'itemStarted',
          item: { type: 'commandExecution', id: 'c1', command: 'npm test -- --run', cwd: tmp, status: 'inProgress' },
        },
        {
          type: 'itemCompleted',
          item: { type: 'commandExecution', id: 'c1', command: 'npm test -- --run', cwd: tmp, status: 'completed', exitCode: 0, aggregatedOutput: 'all green' },
        },
        {
          type: 'itemStarted',
          item: { type: 'commandExecution', id: 'c2', command: 'rm -rf /', cwd: tmp, status: 'inProgress' },
        },
        {
          type: 'itemCompleted',
          item: { type: 'commandExecution', id: 'c2', command: 'rm -rf /', cwd: tmp, status: 'failed', exitCode: 1, aggregatedOutput: 'boom' },
        },
        {
          type: 'itemStarted',
          item: { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [{ path: 'a.ts' }] },
        },
        {
          type: 'itemCompleted',
          item: { type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: 'a.ts' }] },
        },
      ],
    });
    expect(events).toContainEqual({ type: 'tool_use', id: 'c1', name: 'npm', argsJson: `{"command":"npm test -- --run","cwd":"${tmp}"}` });
    expect(events).toContainEqual({ type: 'tool_result', id: 'c1', ok: true, content: 'all green' });
    expect(events).toContainEqual({ type: 'tool_result', id: 'c2', ok: false, content: 'boom' });
    expect(events).toContainEqual({ type: 'tool_use', id: 'f1', name: 'fileChange', argsJson: '[{"path":"a.ts"}]' });
    expect(events).toContainEqual({ type: 'tool_result', id: 'f1', ok: true, content: '[{"path":"a.ts"}]' });
    expect(events[events.length - 1]).toEqual({ type: 'done', exitCode: 0 });
  });

  it('v2 审批请求 → permission_request（id/toolKind/argsJson 正确）+ respondPermission(allow) 回包 decision=accept', async () => {
    const adapter = new CodexExternalAdapter(makeSpec());
    const events: ExternalEvent[] = [];
    for await (const ev of startScenario(adapter, {
      steps: [
        {
          type: 'requestApproval',
          method: 'item/commandExecution/requestApproval',
          params: { itemId: 'c1', command: 'git push', cwd: tmp, reason: 'needs network', threadId: 'fake-codex-thread-1', turnId: 'fake-codex-turn-1', startedAtMs: 1 },
        },
      ],
    })) {
      events.push(ev);
      if (ev.type === 'permission_request') {
        expect(ev.tool).toBe('git');
        expect(ev.argsJson).toBe('{"command":"git push","cwd":' + JSON.stringify(tmp) + ',"reason":"needs network"}');
        expect(ev.options).toEqual(['allow', 'reject']);
        expect(ev.toolKind).toBe('execute');
        expect(ev.id).toMatch(/^\d+$/);
        adapter.respondPermission(ev.id, 'allow');
      }
      if (ev.type === 'done') break;
    }
    // fixture 把收到的 decision 回显进下一条 agentMessageDelta 的 delta
    const echo = events.find((e) => e.type === 'text' && String((e as { text: string }).text).startsWith('approval-decision:'));
    expect((echo as { text: string }).text).toBe('approval-decision:{"decision":"accept"}');
    expect(events[events.length - 1]).toEqual({ type: 'done', exitCode: 0 });
  });

  it('v2 fileChange 审批 reject → decision=decline；allow_session → acceptForSession（legacy ReviewDecision 同理映射）', async () => {
    // reject 分支（v2 fileChange → decline）
    const adapter1 = new CodexExternalAdapter(makeSpec());
    const events1 = await collectApprovalEcho(adapter1, {
      steps: [
        {
          type: 'requestApproval',
          method: 'item/fileChange/requestApproval',
          params: { itemId: 'f1', threadId: 'fake-codex-thread-1', turnId: 'fake-codex-turn-1', startedAtMs: 1, reason: 'write outside cwd' },
        },
      ],
      reply: 'reject',
    });
    expect((events1.echo as { text: string }).text).toBe('approval-decision:{"decision":"decline"}');
    expect(events1.permReq.toolKind).toBe('edit');
    expect(events1.permReq.tool).toBe('fileChange');

    // allow_session 分支（v2 → acceptForSession）
    const adapter2 = new CodexExternalAdapter(makeSpec());
    const events2 = await collectApprovalEcho(adapter2, {
      steps: [
        {
          type: 'requestApproval',
          method: 'item/fileChange/requestApproval',
          params: { itemId: 'f1', threadId: 'fake-codex-thread-1', turnId: 'fake-codex-turn-1', startedAtMs: 1 },
        },
      ],
      reply: 'allow_session',
    });
    expect((events2.echo as { text: string }).text).toBe('approval-decision:{"decision":"acceptForSession"}');

    // legacy execCommandApproval：approved 系枚举映射（allow→approved / reject→denied）
    const adapter3 = new CodexExternalAdapter(makeSpec());
    const events3 = await collectApprovalEcho(adapter3, {
      steps: [
        {
          type: 'requestApproval',
          method: 'execCommandApproval',
          params: { callId: 'call-1', command: ['ls', '-la'], conversationId: 'fake-codex-thread-1', cwd: tmp, parsedCmd: [] },
        },
      ],
      reply: 'allow',
    });
    expect(events3.permReq.toolKind).toBe('execute');
    expect(events3.permReq.tool).toBe('ls');
    expect(events3.permReq.argsJson).toBe('{"command":["ls","-la"],"cwd":' + JSON.stringify(tmp) + '}');
    expect((events3.echo as { text: string }).text).toBe('approval-decision:{"decision":"approved"}');
  });

  it('error 通知（unauthorized）→ error 事件带 codex_error:unauthorized；其他 codexErrorInfo 同样透传；均 fatal:false', async () => {
    const adapter = new CodexExternalAdapter(makeSpec());
    const events = await runScenario(adapter, {
      steps: [
        { type: 'errorNotification', message: 'login expired', codexErrorInfo: 'unauthorized', willRetry: false },
        { type: 'errorNotification', message: 'stream broken', codexErrorInfo: 'responseStreamDisconnected', willRetry: true },
        { type: 'errorNotification', message: 'plain failure' },
        { type: 'agentMessageDelta', delta: 'after' },
      ],
    });
    const errors = events.filter((e): e is Extract<ExternalEvent, { type: 'error' }> => e.type === 'error');
    expect(errors).toHaveLength(3);
    expect(errors[0]!.message).toContain('codex_error:unauthorized');
    expect(errors[0]!.message).toContain('login expired');
    expect(errors[1]!.message).toContain('codex_error:responseStreamDisconnected');
    expect(errors[2]!.message).not.toContain('codex_error:'); // 无 info：普通文案
    for (const e of errors) expect(e.fatal).toBe(false);
    expect(events).toContainEqual({ type: 'text', text: 'after' });
    expect(events[events.length - 1]).toEqual({ type: 'done', exitCode: 0 });
  });

  it('thread/tokenUsage/updated + turn/completed → usage 事件（每 turn 一次，不随流式重复）', async () => {
    const adapter = new CodexExternalAdapter(makeSpec());
    const events = await runScenario(adapter, {
      steps: [
        { type: 'tokenUsage', inputTokens: 120, outputTokens: 45 },
        { type: 'tokenUsage', inputTokens: 130, outputTokens: 50 }, // 流式更新：缓存覆盖，不重复产出
        { type: 'agentMessageDelta', delta: 'done thinking' },
        { type: 'turnCompleted' },
      ],
    });
    expect(events.filter((e) => e.type === 'usage')).toEqual([{ type: 'usage', input: 130, output: 50 }]);
    expect(events[events.length - 1]).toEqual({ type: 'done', exitCode: 0 });
  });

  it('turn/completed(turn.error) → error 事件 fatal:false；无 tokenUsage 时跳过 usage', async () => {
    const adapter = new CodexExternalAdapter(makeSpec());
    const events = await runScenario(adapter, {
      steps: [
        { type: 'turnCompleted', turn: { id: 'fake-codex-turn-1', status: 'failed', items: [], error: { message: 'upstream 500' } } },
      ],
    });
    const errors = events.filter((e): e is Extract<ExternalEvent, { type: 'error' }> => e.type === 'error');
    expect(errors).toEqual([{ type: 'error', message: 'codex turn 失败：upstream 500', fatal: false }]);
    expect(events.filter((e) => e.type === 'usage')).toEqual([]);
    expect(events[events.length - 1]).toEqual({ type: 'done', exitCode: 0 });
  });

  it('resumeSessionId → thread/resume 替代 thread/start（threadId 透传，external_session 取 resume id）', async () => {
    const adapter = new CodexExternalAdapter(makeSpec());
    const events = await runScenario(
      adapter,
      { steps: [{ type: 'agentMessageDelta', delta: 'resumed' }] },
      { resumeSessionId: 'fake-thread-9' },
    );
    const log = recvLog(adapter);
    expect(log.map((e) => e.method)).toEqual(['initialize', 'thread/resume', 'turn/start']);
    expect(log[1]!.params).toEqual({ threadId: 'fake-thread-9', cwd: tmp });
    expect(events[0]).toEqual({ type: 'external_session', id: 'fake-thread-9' });
    expect(events[events.length - 1]).toEqual({ type: 'done', exitCode: 0 });
  });

  it('abort：turn/interrupt（threadId+turnId）到达 fixture → 进程退出 → done exit 0', async () => {
    const adapter = new CodexExternalAdapter(makeSpec());
    const ac = new AbortController();
    const events: ExternalEvent[] = [];
    for await (const ev of startScenario(
      adapter,
      // 先给一条 delta：确保 abort 发生在 turn/start 回包（turnId）到达之后
      { steps: [{ type: 'agentMessageDelta', delta: 'go' }, { type: 'delay', ms: 10000 }] },
      { signal: ac.signal },
    )) {
      events.push(ev);
      if (ev.type === 'text') ac.abort();
      if (ev.type === 'done') break;
    }
    expect(events[events.length - 1]).toEqual({ type: 'done', exitCode: 0 });
    // fixture 收到 turn/interrupt 请求后写 stderr 并退出
    expect(adapter.stderrTail().join('\n')).toContain('recv: turn/interrupt');
    expect(adapter.stderrTail().join('\n')).toContain('"turnId":"fake-codex-turn-1"');
  });

  it('exit 非 0 → done exit N（fatal 判定归映射引擎，本层只透传）', async () => {
    const adapter = new CodexExternalAdapter(makeSpec());
    const events = await runScenario(adapter, { steps: [{ type: 'exit', code: 3 }] });
    expect(events[0]).toEqual({ type: 'external_session', id: 'fake-codex-thread-1' });
    expect(events[events.length - 1]).toEqual({ type: 'done', exitCode: 3 });
  });

  it('stderrTail 透传 fixture 的 stderr 输出；非法 JSON 行 → error fatal:false 且会话继续', async () => {
    const adapter = new CodexExternalAdapter(makeSpec());
    const events = await runScenario(adapter, {
      steps: [
        { type: 'stderr', text: 'codex-stderr-marker' },
        { type: 'raw', text: '{"not-json' },
        { type: 'agentMessageDelta', delta: 'after' },
      ],
    });
    expect(adapter.stderrTail().join('\n')).toContain('codex-stderr-marker');
    const errors = events.filter((e): e is Extract<ExternalEvent, { type: 'error' }> => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.fatal).toBe(false);
    expect(errors[0]!.message).toContain('{"not-json');
    expect(events).toContainEqual({ type: 'text', text: 'after' });
  });

  it('respondPermission 对未知 id 静默不崩；重复应答只回一次', async () => {
    const adapter = new CodexExternalAdapter(makeSpec());
    expect(() => adapter.respondPermission('no-such-id', 'allow')).not.toThrow();
    const { permReq, echo } = await collectApprovalEcho(adapter, {
      steps: [
        {
          type: 'requestApproval',
          method: 'item/commandExecution/requestApproval',
          params: { itemId: 'c1', command: 'echo hi', cwd: tmp, threadId: 'fake-codex-thread-1', turnId: 'fake-codex-turn-1', startedAtMs: 1 },
        },
      ],
      reply: 'reject',
      twice: true,
    });
    expect(permReq.id).toMatch(/^\d+$/);
    expect((echo as { text: string }).text).toBe('approval-decision:{"decision":"decline"}');
  });

  it('detect：KNOWN_AGENTS 含 cli:codex（kind/tier/permissionArgs/loginStateFiles 正确）', () => {
    const def = KNOWN_AGENTS.find((d) => d.id === 'cli:codex');
    expect(def).toBeDefined();
    expect(def!.kind).toBe('app-server-jsonl');
    expect(def!.tier).toBe('C');
    expect(def!.executable).toBe('codex');
    expect(def!.probeArgs).toEqual(['--version']);
    expect(def!.permissionArgs.plan).toEqual([]); // 无只读档 → 映射引擎 external_no_plan_mode 门禁拒绝
    expect(def!.permissionArgs.yolo).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
    expect(def!.loginStateFiles).toContain('.codex');
    // detectedToSpec：kind/tier 透传，args 留空（'app-server' 由适配器按协议携带）
    const spec = detectedToSpec({
      def: def!,
      command: '/usr/local/bin/codex',
      version: '0.162.0-alpha.17.2',
      source: 'path',
    });
    expect(spec.kind).toBe('app-server-jsonl');
    expect(spec.tier).toBe('C');
    expect(spec.args).toEqual([]);
    expect(spec.resumeArgs).toBeUndefined(); // resume 走协议 thread/resume
    expect(spec.mcpArgs).toBeUndefined(); // P3 不做 codex MCP 透传
  });
});

/** 审批回显收集：跑场景，respondPermission(reply) 应答，返回 permission_request 与回显 text */
async function collectApprovalEcho(
  adapter: CodexExternalAdapter,
  scenario: { steps: Array<Record<string, unknown>> } & { reply: 'allow' | 'allow_session' | 'reject'; twice?: boolean },
): Promise<{
  permReq: Extract<ExternalEvent, { type: 'permission_request' }>;
  echo: ExternalEvent | undefined;
  events: ExternalEvent[];
}> {
  const events: ExternalEvent[] = [];
  let permReq: Extract<ExternalEvent, { type: 'permission_request' }> | null = null;
  for await (const ev of startScenario(adapter, scenario)) {
    events.push(ev);
    if (ev.type === 'permission_request') {
      permReq = ev;
      adapter.respondPermission(ev.id, scenario.reply);
      if (scenario.twice) adapter.respondPermission(ev.id, 'allow'); // 已答复：静默忽略
    }
    if (ev.type === 'done') break;
  }
  return {
    permReq: permReq!,
    echo: events.find((e) => e.type === 'text' && String((e as { text: string }).text).startsWith('approval-decision:')),
    events,
  };
}
