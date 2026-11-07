/**
 * F-58 T6：AC1–AC9 端到端串联（设计稿 §15/§16）。
 *
 * 与单测的分工：router-*.test.ts 各自用 fake hub 钉住单点行为；本文件把**真实组件**
 * 接成一条链——SessionHub（fake provider）→ dispatch_task 真工具（经 toolContext.dispatcher）
 * → Dispatcher（fake preflight，零进程）→ Worker 会话（外部 cli:e2e 走进程内 scripted
 * adapter，不 spawn 子进程；内置走同一 fake provider）→ onRunFinished 收敛 → pumpDigest 播报。
 * 「派单 → 完成 → 播报」完整跑通，逐条对齐 §15 的 AC1–AC9 在真实链路上的可观测面。
 *
 * 发现记录：本文件首轮编写时暴露「hub 未把 dispatcher 注入 toolContext」的装配缝
 * （真实 serve 链路 dispatch_task 恒报 dispatcher_unavailable，此前只有 http 端点与
 * 手工注入 ctx 的单测覆盖）——已按「回对应任务补」纪律以 resolveDispatcher 延迟解析
 * 补上（hub.ts + runtime.ts），本文件 AC1 用例即该缝隙的回归守卫。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ChatMessage, ChatRequest, LLMProvider, StreamEvent, ToolCall } from '@delta/shared';
import { SessionService } from '../src/session/service.js';
import { SessionHub } from '../src/server/hub.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { Dispatcher } from '../src/router/dispatcher.js';
import { watchdogTick } from '../src/router/watchdog.js';
import { buildRouterLedger } from '../src/router/ledger.js';
import { registerExternalAdapterFactory } from '../src/external/registry.js';
import type { ExternalAgentAdapter, ExternalAgentSpec, ExternalEvent } from '../src/external/types.js';

// 真实链路涉及引擎/收敛/播报多级异步，放宽单用例时限（默认 5s 不够 20 任务串联）
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// ── fake provider：脚本队列 + 慢 Marker 门（造「运行中」窗口）─────────────────

class ScriptedE2eProvider implements LLMProvider {
  readonly id = 'e2e-scripted';
  readonly requests: ChatRequest[] = [];
  private queue: Array<{ text?: string; toolCalls?: ToolCall[] }> = [];
  /** 非空时：最后一条用户消息包含该词的请求被挂起（造 Router/内置 Worker 的运行中窗口） */
  holdMarker = '';
  private gate: Promise<void> = Promise.resolve();
  private release: () => void = () => {};

  push(entry: { text?: string; toolCalls?: ToolCall[] }): void {
    this.queue.push(entry);
  }

  holdOn(marker: string): void {
    this.holdMarker = marker;
    this.gate = new Promise((r) => {
      this.release = r;
    });
  }

  unhold(): void {
    this.holdMarker = '';
    this.release();
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(req);
    const last = req.messages[req.messages.length - 1];
    if (
      this.holdMarker &&
      typeof last?.content === 'string' &&
      last.content.includes(this.holdMarker)
    ) {
      await this.gate;
    }
    const next = this.queue.shift();
    if (!next) {
      yield { type: 'text_delta', text: '收到' };
      yield { type: 'usage', input: 10, output: 5 };
      yield { type: 'done' };
      return;
    }
    for (const [i, c] of (next.toolCalls ?? []).entries()) {
      yield { type: 'tool_call_delta', index: i, id: c.id, name: c.name, argsDelta: '' };
      yield { type: 'tool_call_delta', index: i, argsDelta: c.argsJson };
    }
    if (next.text) {
      for (const chunk of next.text.match(/.{1,4}/gs) ?? []) {
        yield { type: 'text_delta', text: chunk };
      }
    }
    yield { type: 'usage', input: 10, output: 5 };
    yield { type: 'done' };
  }

  estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((n, m) => n + m.content.length, 0);
  }
}

// ── 外部 cli:e2e 进程内 adapter（不 spawn；共享门造「外部 Worker 运行中」窗口）──
// 工厂在 beforeEach 重新注册：用例内可整体替换脚本（如 exit 3），不泄漏到后续用例。

const E2E_MODEL = 'cli:e2e';

let factoryCalls = 0;
let workerHold = false;
let workerGate = Promise.resolve();
let releaseWorkers: () => void = () => {};

function holdWorkerRuns(): void {
  workerHold = true;
  workerGate = new Promise((r) => {
    releaseWorkers = r;
  });
}

function releaseWorkerRuns(): void {
  workerHold = false;
  releaseWorkers();
}

function e2eSpec(): ExternalAgentSpec {
  return {
    id: E2E_MODEL,
    kind: 'stream-json-jsonl',
    command: 'e2e-noop',
    args: [],
    tier: 'B',
    version: '0.0.0-e2e',
    permissionArgs: { plan: [], default: [], yolo: [] },
  };
}

/** 恒定失败模型（exit 3 无产出 → fatal → runError → failed(runtime)，供 batch 条目用例） */
const BAD_MODEL = 'cli:e2e-bad';

function registerBadE2eFactory(): void {
  registerExternalAdapterFactory(BAD_MODEL, () => {
    const adapter: ExternalAgentAdapter = {
      spec: { ...e2eSpec(), id: BAD_MODEL, command: 'e2e-bad' },
      run: async function* (): AsyncIterable<ExternalEvent> {
        yield { type: 'done', exitCode: 3 };
      },
    };
    return adapter;
  });
}

function registerDefaultE2eFactory(): void {
  registerExternalAdapterFactory(E2E_MODEL, () => {
    factoryCalls += 1;
    const adapter: ExternalAgentAdapter = {
      spec: e2eSpec(),
      run: async function* (req): AsyncIterable<ExternalEvent> {
        yield { type: 'text', text: `完成：${req.prompt.split('\n')[0]?.slice(0, 20) ?? ''}` };
        if (workerHold) await workerGate;
        yield { type: 'done', exitCode: 0 };
      },
    };
    return adapter;
  });
}

// ── 每用例一套真实链路环境 ───────────────────────────────────────────────────

interface E2eEnv {
  service: SessionService;
  hub: SessionHub;
  provider: ScriptedE2eProvider;
  dispatcher: Dispatcher;
  projectId: string;
  routerId: string;
  /** 发给 Router 会话的 send 次数（AC9 计数口径；历史 user 消息数） */
  routerSends: () => number;
  routerSendInputs: () => string[];
  /** dispatcher.abort 的调用记录（真实 SessionHub 无 aborted 数组，FakeHub 才有） */
  aborted: string[];
  /** isRunning 调用计数（红线自检；真实 SessionHub 无 FakeHub 的计数器） */
  isRunningCalls: () => number;
  /** 替换 preflight 门禁（AC4 用） */
  setPreflight: (fn: Dispatcher['workerTasks'] extends never ? never : (task: unknown) => Promise<{ ok: boolean; reason?: string; message?: string }>) => void;
  /** 等待所有已知会话退出运行态（防悬挂写入已关闭的库） */
  settle: (timeoutMs?: number) => Promise<void>;
}

let tmp = '';
let env: E2eEnv;
let clockNow = 0;

async function waitFor(cond: () => boolean, timeoutMs = 8000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** runtime 同款 getResultSummary：Worker 会话最后一条非空 assistant 消息（≤400 字） */
function lastAssistant(service: SessionService, workerSessionId: string): string | null {
  try {
    const msgs = service.getHistory(workerSessionId);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.role === 'assistant' && m.content.trim()) return m.content.trim().slice(0, 400);
    }
    return null;
  } catch {
    return null;
  }
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-f58-ac-e2e-'));
  const service = new SessionService(path.join(tmp, 'db.sqlite'));
  const projectId = service.ensureProject(tmp).id;
  const provider = new ScriptedE2eProvider();
  clockNow = Date.now();
  factoryCalls = 0;
  registerDefaultE2eFactory();
  registerBadE2eFactory();

  const router = service.createSession(projectId, { title: '总管', model: 'test-model' });
  service.store.setSessionKind(router.id, 'router');
  const routerId = router.id;

  let preflightImpl: (task: unknown) => Promise<{ ok: boolean; reason?: string; message?: string }> = () =>
    Promise.resolve({ ok: true });

  let dispatcher!: Dispatcher;
  const aborted: string[] = [];
  let isRunningCalls = 0;
  const hub = new SessionHub({
    service,
    registry: new ToolRegistry(),
    resolveProvider: async () => provider,
    autoDistill: false, // 隔离蒸馏辅助请求，避免污染 AC1 的请求体断言
    // F-58 接缝（与 runtime.ts 同款装配）：收敛主路径 + toolContext.dispatcher 延迟解析
    onRunFinished: (sessionId, outcome) => dispatcher.onRunFinished(sessionId, outcome),
    resolveDispatcher: () => dispatcher,
  });

  dispatcher = new Dispatcher({
    workerTasks: service.workerTasks,
    inbox: service.inbox,
    send: (sessionId, input) => hub.send(sessionId, input),
    peekRunning: (sessionId) => hub.peekRunning(sessionId),
    isRunning: (sessionId) => {
      isRunningCalls += 1;
      return hub.isRunning(sessionId);
    },
    abort: (sessionId) => {
      aborted.push(sessionId);
      hub.abort(sessionId);
    },
    // fake detect：零进程（AC4 的「无任何 CLI 进程被拉起」以 factoryCalls===0 断言）
    preflight: (task) => preflightImpl(task),
    createWorkerSession: (pid, o) => service.createWorkerSession(pid, o),
    getRouterModel: () => service.getSession(routerId)?.model ?? null,
    maxConcurrentWorkers: 3,
    getResultSummary: (workerSessionId) => lastAssistant(service, workerSessionId),
    // 时钟注入：C4 防抖是 60s，测试内推进时钟绕过（真实间隔语义不改）
    now: () => clockNow,
    watchdog: {
      listFileChanges: (sessionId) => service.changes.list(sessionId).map((c) => ({ path: c.path })),
      getWorkRoot: (sessionId) => hub.resolveSessionWorkRoot(sessionId) ?? null,
    },
  });

  env = {
    service,
    hub,
    provider,
    dispatcher,
    projectId,
    routerId,
    routerSends: () => service.getHistory(routerId).filter((m) => m.role === 'user').length,
    routerSendInputs: () =>
      service.getHistory(routerId).filter((m) => m.role === 'user').map((m) => m.content),
    aborted,
    isRunningCalls: () => isRunningCalls,
    setPreflight: (fn) => {
      preflightImpl = fn;
    },
    async settle(timeoutMs = 8000) {
      provider.unhold();
      releaseWorkerRuns();
      const ids = [routerId, ...service.listSessions(projectId).map((s) => s.id)];
      await waitFor(() => ids.every((id) => !hub.peekRunning(id)), timeoutMs, 'all runs settled');
    },
  };
});

afterEach(async () => {
  await env.settle();
  env.service.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

/** 经 dispatch_task 真工具派单（走 toolContext.dispatcher 注入链） */
async function dispatchViaTool(args: Record<string, unknown>): Promise<string> {
  const seq = env.provider.requests.length;
  env.provider.push({
    toolCalls: [{ id: `c${seq}`, name: 'dispatch_task', argsJson: JSON.stringify(args) }],
  });
  env.provider.push({ text: '已派单' });
  await env.hub.send(env.routerId, '把任务派出去');
  const tasks = env.service.workerTasks.list({ projectId: env.projectId });
  expect(tasks).toHaveLength(1);
  return tasks[0]!.id;
}

// ── AC1 + AC3（happy）+ AC8/AC9（单任务成功静默不触发）───────────────────────

describe('完整一轮「派单 → 完成」（AC1 / AC3 / AC8 / AC9a）', () => {
  it('Router 经真工具派外部单：请求体工具集收窄；任务 queued→preflight→running→done 且 result_summary 非空；单任务成功零播报', async () => {
    const taskId = await dispatchViaTool({
      title: '登录页',
      goal: '实现登录页与表单校验',
      executor: E2E_MODEL,
      permission_mode: 'default',
    });

    // AC1：Router 每一轮请求体的工具集合严格 = {dispatch_task, task_status}，执行类工具缺席
    expect(env.provider.requests.length).toBeGreaterThanOrEqual(2);
    for (const req of env.provider.requests) {
      expect(new Set(req.tools.map((t) => t.name))).toEqual(new Set(['dispatch_task', 'task_status']));
      const names = req.tools.map((t) => t.name);
      for (const forbidden of ['run_command', 'write_file', 'edit_file', 'read_file', 'glob_search', 'grep_search']) {
        expect(names).not.toContain(forbidden);
      }
    }

    // AC3（happy）：终态收敛 + 摘要来自 Worker 会话产出
    await waitFor(() => env.service.workerTasks.get(taskId).status === 'done', 15000, 'task done');
    const row = env.service.workerTasks.get(taskId);
    expect(row.failure_kind).toBeNull();
    expect(row.result_summary ?? '').toContain('实现登录页');
    // preflight 通过 = 恰好一次「进程拉起」（工厂调用计数）
    expect(factoryCalls).toBe(1);

    // AC8/AC9a：单任务成功 = silent，不触发 Router 播报（routerSends 只含测试派单那一条）
    expect(env.routerSends()).toBe(1);
    const undelivered = env.service.inbox.listUndelivered(env.routerId);
    expect(undelivered).toHaveLength(1);
    expect(undelivered[0]!.severity).toBe('silent');
  });
});

// ── AC3（失败分支）：exit≠0 且无产出 → failed(runtime) ──────────────────────

describe('AC3 失败分支：外部退出码非 0 且无产出', () => {
  it('done{exitCode:3} 无产出 → runError → failed(runtime)，result_summary 为空，失败进 inbox batch', async () => {
    const task = env.dispatcher.dispatch({
      projectId: env.projectId,
      routerSessionId: env.routerId,
      title: '会退出的任务',
      goal: 'goal-exit-3',
      executor: BAD_MODEL,
      permission_mode: 'default',
    });
    await env.dispatcher.claimSlot();
    await waitFor(() => env.service.workerTasks.get(task.id).status === 'failed', 15000, 'failed');
    const row = env.service.workerTasks.get(task.id);
    expect(row.failure_kind).toBe('runtime');
    expect(row.result_summary).toBeNull();
    const items = env.service.inbox.listUndelivered(env.routerId);
    expect(items[0]!.kind).toBe('task_failed');
    expect(items[0]!.severity).toBe('batch');
  });
});

// ── AC4：preflight 失败 → needs_decision，零进程 ────────────────────────────

describe('AC4：preflight 失败的链路面（fake detect 拒绝）', () => {
  it('needs_decision + attempt 不递增 + 1 条 interrupt + 零进程；interrupt 播报立即触发（AC8/AC9）', async () => {
    env.setPreflight(() => Promise.resolve({ ok: false, reason: 'login_required', message: '登录态缺失' }));
    const task = env.dispatcher.dispatch({
      projectId: env.projectId,
      routerSessionId: env.routerId,
      title: '登录态缺失任务',
      goal: 'goal-preflight-fail',
      executor: E2E_MODEL,
      permission_mode: 'default',
    });
    await env.dispatcher.claimSlot();

    const row = env.service.workerTasks.get(task.id);
    expect(row.status).toBe('needs_decision');
    expect(row.attempt).toBe(1); // claim 的 +1；preflight 失败路径不再递增
    expect(env.service.inbox.listUndelivered(env.routerId)).toHaveLength(1);
    expect(factoryCalls).toBe(0); // 无任何 CLI 进程被拉起

    // AC8：needs_decision 必为 interrupt；AC9：interrupt 播报立即（无需 2 条终态窗口）
    const sent = await env.dispatcher.pumpDigest(env.routerId);
    expect(sent).toBe(true);
    expect(env.routerSendInputs().at(-1)).toContain('需要你决定');
    expect(env.routerSendInputs().at(-1)).toContain('登录态缺失任务');
  });
});

// ── AC5：并发上限 ────────────────────────────────────────────────────────────

describe('AC5：一次派 10 个任务，任一时刻 running ≤ maxConcurrentWorkers', () => {
  it('恰好 3 个 running、7 个 queued；释放后全部收敛；全程 isRunning 零调用', async () => {
    holdWorkerRuns();
    const tasks: string[] = [];
    for (let i = 0; i < 10; i++) {
      const t = env.dispatcher.dispatch({
        projectId: env.projectId,
        routerSessionId: env.routerId,
        title: `任务${i}`,
        goal: `g-${i}`,
        executor: E2E_MODEL,
        permission_mode: 'default',
      });
      tasks.push(t.id);
    }
    await env.dispatcher.claimSlot();

    const running = env.service.workerTasks.list({ projectId: env.projectId, status: 'running' });
    const queued = env.service.workerTasks.list({ projectId: env.projectId, status: 'queued' });
    expect(running.length).toBe(3);
    expect(queued.length).toBe(7);

    releaseWorkerRuns();
    await waitFor(
      () => tasks.every((id) => env.service.workerTasks.get(id).status === 'done'),
      20000,
      'all 10 done',
    );
    expect(env.isRunningCalls()).toBe(0); // 调度层全程未碰 isRunning（红线）
  });
});

// ── AC6：台账进真实 Router 提示词 ───────────────────────────────────────────

describe('AC6：20 任务后台账注入 Router 提示词（真实 buildPrompt 链）', () => {
  it('estTokens ≤ 4000；提示词含台账头与最近 5 条终态；最旧任务与 goal 正文（messages 内容）不出现', async () => {
    const long = '长'.repeat(300);
    const tasks: string[] = [];
    for (let i = 0; i < 20; i++) {
      const t = env.dispatcher.dispatch({
        projectId: env.projectId,
        routerSessionId: env.routerId,
        title: `任务${String(i).padStart(2, '0')}`,
        goal: `开发模块${i}：${long}`,
        executor: E2E_MODEL,
        permission_mode: 'default',
      });
      tasks.push(t.id);
    }
    // 派发泵在收敛后自动补槽，最终全部终态（顺带复核 AC5 的补槽链）
    await env.dispatcher.claimSlot();
    await waitFor(
      () => tasks.every((id) => env.service.workerTasks.get(id).status === 'done'),
      25000,
      'all 20 done',
    );

    // 台账纯函数口径：estTokens ≤ 4000（AC6 的数值判据）
    const ledger = buildRouterLedger({
      tasks: env.service.workerTasks.list({ projectId: env.projectId }),
      interrupts: env.service.inbox.listUndelivered(env.routerId),
    });
    expect(ledger.estTokens).toBeLessThanOrEqual(4000);

    // 真实提示词：下一轮 Router 请求注入台账段
    env.provider.push({ text: '好的，我看到了台账' });
    await env.hub.send(env.routerId, '现在进度如何');
    const lastReq = env.provider.requests.at(-1)!;
    const promptText = lastReq.messages.map((m) => m.content).join('\n');
    expect(promptText).toContain('[系统] 台账');
    expect(promptText).toContain('最近完成');
    // 裁剪可见：完成桶只留最近 5 条——最旧任务（任务00）整行不出现
    expect(promptText).not.toContain('任务00');
    expect(promptText).toContain('任务19');
    // 红线（§8.2 禁止项）：goal 正文（messages 内容）不进台账
    expect(promptText).not.toContain(long.slice(0, 50));
  });
});

// ── AC2：运行态互斥（真实 hub 单槽）────────────────────────────────────────

describe('AC2：Worker 运行中 → Router 不 409；同一 Worker 仍互斥', () => {
  it('外部 Worker 挂起运行时：向 Router 发消息正常完成；向同一 Worker 再发抛 already running', async () => {
    holdWorkerRuns();
    const taskId = await dispatchViaTool({
      title: '慢任务',
      goal: 'HOLD_W 实现导出功能',
      executor: E2E_MODEL,
      permission_mode: 'default',
    });
    const ws = env.service.workerTasks.get(taskId).worker_session_id!;
    await waitFor(() => env.hub.peekRunning(ws), 15000, 'worker running');

    // Worker 运行中 → Router 可继续接指令（不 409）
    await expect(env.hub.send(env.routerId, '推进如何')).resolves.toBeUndefined();
    // 同一 Worker 再发 → 409 的来源：单槽互斥
    await expect(env.hub.send(ws, '并发指令')).rejects.toThrow('session is already running');

    releaseWorkerRuns();
    await waitFor(() => env.service.workerTasks.get(taskId).status === 'done', 15000, 'done');
  });
});

// ── AC9：播报触发语义（真实 hub 计数）───────────────────────────────────────

describe('AC9：digest 触发次数与 C3 运行中让位', () => {
  // 语义对齐（T2c 实现口径）：task_done 收敛落 silent（永不进播报文本），失败落 batch；
  // C2 的「≥2 条终态」窗口由 batch 条目存在时才生效——成功-only 的批次零播报
  //（「搞定了不打扰」）。本用例：1 成（silent）+ 1 败（batch）→ 2 条终态触发 1 条 digest。
  it('≥2 条终态且 Router 空闲恰好触发 1 次（silent 不进播报文本）；重复 pump 4 次仍 1 次；Router 运行中不触发只留 inbox，空闲后补播恰好 1 次', async () => {
    const digestSends = () => env.routerSendInputs().filter((c) => c.includes('[系统] 任务播报'));
    // 第一批：A 成（silent）+ B 败（batch）→ 恰好 1 条 digest（本用例不经 Router 派单）
    const a = env.dispatcher.dispatch({ projectId: env.projectId, routerSessionId: env.routerId, title: '任务A', goal: 'ga', executor: E2E_MODEL, permission_mode: 'default' });
    const b = env.dispatcher.dispatch({ projectId: env.projectId, routerSessionId: env.routerId, title: '任务B', goal: 'gb', executor: BAD_MODEL, permission_mode: 'default' });
    await env.dispatcher.claimSlot();
    await waitFor(
      () => env.service.workerTasks.get(a.id).status === 'done' && env.service.workerTasks.get(b.id).status === 'failed',
      15000,
      'A/B terminal',
    );
    await waitFor(() => digestSends().length === 1, 8000, 'first digest');
    expect(digestSends()[0]).toContain('任务B'); // batch（失败）进播报
    expect(digestSends()[0]).not.toContain('任务A'); // silent（成功）不进播报文本

    // 幂等：同批条目连调 4 次不再发送
    for (let i = 0; i < 4; i++) {
      expect(await env.dispatcher.pumpDigest(env.routerId)).toBe(false);
    }
    expect(digestSends().length).toBe(1);

    // C3：Router 运行中（挂起的 Router 轮）→ 新终态不触发，条目留 inbox
    env.provider.holdOn('HOLD_ROUTER');
    const routerRun = env.hub.send(env.routerId, 'HOLD_ROUTER 请长篇分析').catch(() => undefined);
    await waitFor(() => env.hub.peekRunning(env.routerId), 15000, 'router running');

    const c = env.dispatcher.dispatch({ projectId: env.projectId, routerSessionId: env.routerId, title: '任务C', goal: 'gc', executor: E2E_MODEL, permission_mode: 'default' });
    const d = env.dispatcher.dispatch({ projectId: env.projectId, routerSessionId: env.routerId, title: '任务D', goal: 'gd', executor: BAD_MODEL, permission_mode: 'default' });
    await env.dispatcher.claimSlot();
    await waitFor(
      () => env.service.workerTasks.get(c.id).status === 'done' && env.service.workerTasks.get(d.id).status === 'failed',
      15000,
      'C/D terminal',
    );
    // 给 onRunFinished → pumpDigest 的异步链一点时间；断言它被 C3 挡住：
    // 未送达 = A/C 的 silent（2）+ D 的 batch（1）；其中 batch/interrupt 只有 D
    await waitFor(() => env.service.inbox.listUndelivered(env.routerId).length === 3, 3000, 'undelivered C/D');
    expect(digestSends().length).toBe(1); // 运行中不触发

    // Router 轮结束 → 空闲 → 推进时钟过 C4 防抖 → 补播恰好 1 次
    env.provider.unhold();
    await routerRun;
    clockNow += 61_000;
    expect(await env.dispatcher.pumpDigest(env.routerId)).toBe(true);
    expect(digestSends().length).toBe(2);
    expect(digestSends()[1]).toContain('任务D');
    const pending = env.service.inbox
      .listUndelivered(env.routerId)
      .filter((i) => i.severity === 'batch' || i.severity === 'interrupt');
    expect(pending).toHaveLength(0); // batch/interrupt 全部送达；silent 仍在（永不触发语义）
  });
});

// ── AC7：内置 kill / 外部降级 suspect（真实链路 + runtime 同款看门狗注入）────

describe('AC7：内置 Worker 越界 kill；外部 Worker 同场景只降级 suspect', () => {
  it('内置：abort + failed(watchdog_l2) 不重试；外部：不 kill，markSuspect 落 flag + silent', async () => {
    holdWorkerRuns();
    env.provider.holdOn('HOLD_I'); // 内置 Worker 挂起（goal 含标记）
    const internal = env.dispatcher.dispatch({
      projectId: env.projectId,
      routerSessionId: env.routerId,
      title: '内置越界任务',
      goal: 'HOLD_I 写 /etc/passwd',
    });
    const external = env.dispatcher.dispatch({
      projectId: env.projectId,
      routerSessionId: env.routerId,
      title: '外部越界任务',
      goal: 'HOLD_W 写 /etc/passwd',
      executor: E2E_MODEL,
      permission_mode: 'default',
    });
    await env.dispatcher.claimSlot();
    await waitFor(
      () =>
        env.service.workerTasks.get(internal.id).status === 'running' &&
        env.service.workerTasks.get(external.id).status === 'running',
      15000,
      'both running',
    );
    const iws = env.service.workerTasks.get(internal.id).worker_session_id!;
    const ews = env.service.workerTasks.get(external.id).worker_session_id!;
    // 越界信号：内置走 file_changes（F-24 落点）；外部防御性同样记录（真实外部 CLI 不会有此落点）
    env.service.changes.record(iws, { tool: 'write_file', path: '/etc/passwd', before: null, after: 'x' });
    env.service.changes.record(ews, { tool: 'write_file', path: '/etc/passwd', before: null, after: 'x' });

    await watchdogTick(env.dispatcher, {
      listFileChanges: (sessionId) => env.service.changes.list(sessionId).map((c) => ({ path: c.path })),
      getWorkRoot: (sessionId) => env.hub.resolveSessionWorkRoot(sessionId) ?? null,
    });

    // 内置：立即 kill，不重试
    const irow = env.service.workerTasks.get(internal.id);
    expect(irow.status).toBe('failed');
    expect(irow.failure_kind).toBe('watchdog_l2');
    expect(irow.attempt).toBe(1);
    expect(env.aborted).toContain(iws);
    const iItems = env.service.inbox.listUndelivered(env.routerId);
    expect(iItems[0]!.severity).toBe('interrupt'); // L2 kill 必 interrupt（AC8）

    // 外部：不 kill（L2a 无 file_changes 落点不适用，§9.1）
    expect(env.service.workerTasks.get(external.id).status).toBe('running');
    expect(env.aborted).not.toContain(ews);

    // 降级出口 = L3 标记接口：suspect + silent，不中断运行
    env.dispatcher.markSuspect(external.id);
    const erow = env.service.workerTasks.get(external.id);
    expect(erow.status).toBe('running');
    expect(erow.watchdog_flag).toBe('suspect');
    const eItems = env.service.inbox.listUndelivered(env.routerId);
    expect(eItems.some((i) => i.severity === 'silent')).toBe(true);

    releaseWorkerRuns();
  });
});

// ── bootstrap 重启收敛（§18-1，DoD 手工项的自动化等价）──────────────────────

describe('bootstrap：服务重启后僵尸任务收敛', () => {
  it('旧进程遗留的 running 行在新进程的 Dispatcher.bootstrap() 下标 failed(runtime) + inbox batch', async () => {
    holdWorkerRuns();
    const t = env.dispatcher.dispatch({
      projectId: env.projectId,
      routerSessionId: env.routerId,
      title: '重启遗留任务',
      goal: 'goal-restart',
      executor: E2E_MODEL,
      permission_mode: 'default',
    });
    await env.dispatcher.claimSlot();
    expect(env.service.workerTasks.get(t.id).status).toBe('running');

    // 模拟重启：新进程的 hub 看不到旧运行态（peekRunning 恒 false）
    const restarted = new Dispatcher({
      workerTasks: env.service.workerTasks,
      inbox: env.service.inbox,
      send: async () => undefined,
      peekRunning: () => false,
      isRunning: () => false,
      abort: () => undefined,
    });
    restarted.bootstrap();

    const row = env.service.workerTasks.get(t.id);
    expect(row.status).toBe('failed');
    expect(row.failure_kind).toBe('runtime');
    const items = env.service.inbox.listUndelivered(env.routerId);
    expect(items[0]!.kind).toBe('task_failed');
    expect(JSON.stringify(items[0]!.payload)).toContain('bootstrap');
    // 旧运行随后收敛：幂等（不再改写已失败行）
    releaseWorkerRuns();
    await env.settle();
    expect(env.service.workerTasks.get(t.id).status).toBe('failed');
  });
});
