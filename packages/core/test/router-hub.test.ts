/**
 * F-58 T3：hub 接缝单测（design-f58 §4.1 / §9.3 / §13）。
 *
 * 覆盖：
 *  1. AC1：Router 会话（kind='router'）跑一轮，fake provider 捕获的 ChatRequest.tools
 *     集合等于 {dispatch_task, task_status}，执行类工具全部缺席。
 *     手法说明：dispatch_task/task_status 的真实实现属 T4（tools/builtin/dispatch.ts），
 *     本文件向 registry 注册两个同名**最小 stub 工具**（schema 为空 object、execute 恒 ok），
 *     只验证「注册表收窄把哪些名字放进请求体」这一结构事实，不依赖工具行为。
 *  2. AC2：Worker 运行中向 Router 发消息不 409；向同一 Worker 发消息仍 409。
 *     http.ts:1026 的 409 直接源自 hub.isRunning（单槽 running Map），本任务不改 http.ts，
 *     故用 hub 层 API 验证运行态互斥语义：跨会话 send 正常完成、同会话并发 send 抛
 *     'session is already running'。
 *  3. peekRunning 零副作用（§9.3 核心回归）：超 31 分钟伪 entry → true、running 表不清理、
 *     不推 run_error；isRunning 问一次仍按既有语义回收（行为零变化）。
 *  4. onRunFinished 在 done / failed(异常) / aborted 三条路径都被调用且参数正确。
 *  5. send 入口防御：kind='router' + 外部模型 → run_error 拒绝，零副作用（不落消息不占运行态）。
 *  6. 收窄交集：Router 会话同时绑定专家时，专家白名单 ∩ Router 允许集（不得互相覆盖）。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type {
  ChatMessage,
  ChatRequest,
  LLMProvider,
  StreamEvent,
  ToolCall,
} from '@delta/shared';
import { SessionService } from '../src/session/service.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { SessionHub, type HubEvent, type SessionHubDeps } from '../src/server/hub.js';
import { registerExternalAdapter } from '../src/external/registry.js';
import { ScriptedExternalAdapter } from '../src/external/scripted.js';

// ── 测试脚手架 ───────────────────────────────────────────────────────────────

/** 捕获型 fake provider：记录每个 ChatRequest 的工具名 + 可选工具调用脚本 */
class CapturingProvider implements LLMProvider {
  readonly id = 'capture';
  readonly requests: ChatRequest[] = [];

  constructor(private readonly script: Array<{ text?: string; toolCalls?: ToolCall[] }> = []) {}

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(req);
    const next = this.script.shift();
    if (!next) {
      yield { type: 'text_delta', text: '完成' };
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

/** 固定延时 provider：制造「运行中」窗口（与 worktree-hub.test.ts 的 MockProvider 同思路）。
 * 仅对包含 slowMarker 的输入延时——多会话共用一个 hub 时 Worker 慢、Router 快，AC2 竞态可控 */
class DelayProvider implements LLMProvider {
  readonly id = 'delay';
  delayMs = 0;
  slowMarker = '慢任务';

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const last = req.messages[req.messages.length - 1];
    const slow =
      this.delayMs > 0 && typeof last?.content === 'string' && last.content.includes(this.slowMarker);
    if (slow) await new Promise((r) => setTimeout(r, this.delayMs));
    yield { type: 'text_delta', text: `ok:${req.messages.length}` };
    yield { type: 'usage', input: 10, output: 5 };
    yield { type: 'done' };
  }

  estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((n, m) => n + m.content.length, 0);
  }
}

/** 会炸的 provider：断言防御路径完全不触达 provider */
const explodingProvider = async (): Promise<LLMProvider> => {
  throw new Error('resolveProvider 不应被调用');
};

let tmp = '';
let service: SessionService;
let projectId = '';

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-router-hub-'));
  service = new SessionService(path.join(tmp, 'db.sqlite'));
  projectId = service.ensureProject(tmp).id;
});

afterEach(async () => {
  service.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

function makeRegistryWithStubs(): ToolRegistry {
  // T4 已落地真实 dispatch_task/task_status（tools/builtin/dispatch.ts），注册表自带，
  // T3 时期的 stub 注入不再需要（未装配 dispatcher 时真实工具自带明确报错口径）
  return new ToolRegistry();
}

function makeRouterSession(model = 'test-model'): string {
  const s = service.createSession(projectId, { model, mode: 'react' });
  service.store.setSessionKind(s.id, 'router');
  return s.id;
}

/** 轮询等待条件成立（等待「运行中」窗口用，避免固定 sleep） */
async function waitFor(cond: () => boolean, timeoutMs = 5000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 伪 entry 注入：直接往私有 running 表塞一条超时记录（peekRunning 零副作用测试用） */
function runningMap(hub: SessionHub): Map<string, { ac: AbortController; startedAt: number }> {
  return (hub as unknown as { running: Map<string, { ac: AbortController; startedAt: number }> })
    .running;
}

function collectEvents(hub: SessionHub, sessionId: string): HubEvent[] {
  const events: HubEvent[] = [];
  hub.subscribe(sessionId, (ev) => events.push(ev));
  return events;
}

// ── AC1：Router 会话工具集收窄 ───────────────────────────────────────────────

describe('AC1：Router 注册表收窄（design §4.1 L-结构层）', () => {
  it('Router 会话跑一轮：请求体工具集合 = {dispatch_task, task_status}，执行类工具全部缺席', async () => {
    const provider = new CapturingProvider([
      // 第一轮：调用 dispatch_task（允许集内，走 RestrictedRegistry 执行真实 T4 工具）
      { toolCalls: [{ id: 'c1', name: 'dispatch_task', argsJson: JSON.stringify({ title: 't', goal: 'g' }) }] },
      { text: '已派单' },
    ]);
    const deps: SessionHubDeps = {
      service,
      registry: makeRegistryWithStubs(),
      resolveProvider: async () => provider,
      // 关闭记忆蒸馏：distill 会向同一 provider 发 tools:[] 的辅助请求，污染「请求体工具集」断言
      autoDistill: false,
    };
    const hub = new SessionHub(deps);
    const routerId = makeRouterSession();
    const events = collectEvents(hub, routerId);

    await hub.send(routerId, '把登录页做掉');

    // 每个捕获到的请求：工具名集合严格等于允许集
    expect(provider.requests.length).toBeGreaterThanOrEqual(1);
    for (const req of provider.requests) {
      expect(new Set(req.tools.map((t) => t.name))).toEqual(new Set(['dispatch_task', 'task_status']));
    }
    // 执行类工具全部缺席（AC1 点名的六个 + run_command）
    const names = provider.requests[0]!.tools.map((t) => t.name);
    for (const forbidden of ['run_command', 'write_file', 'edit_file', 'read_file', 'glob_search', 'grep_search']) {
      expect(names).not.toContain(forbidden);
    }
    // 收窄后 dispatch_task 仍可执行（真实 T4 工具；hub 未注入 dispatcher → 明确报错口径，tool 消息落库）
    expect(events.some((e) => e.type === 'done')).toBe(true);
    const history = service.getHistory(routerId);
    expect(history.some((m) => m.role === 'tool' && m.content.includes('未装配调度器'))).toBe(true);
  });

  it('普通 chat 会话不收窄：注册表全量可见（零回归护栏）', async () => {
    const provider = new CapturingProvider();
    const registry = makeRegistryWithStubs();
    const hub = new SessionHub({ service, registry, resolveProvider: async () => provider, autoDistill: false });
    const chatId = service.createSession(projectId, { model: 'test-model', mode: 'react' }).id;

    await hub.send(chatId, '普通对话');

    const names = provider.requests[0]!.tools.map((t) => t.name);
    expect(names).toContain('run_command');
    expect(names).toContain('write_file');
    expect(names).toContain('dispatch_task');
  });

  it('Router + 专家白名单并存 → 取交集，不得互相覆盖（计划改动 a 的组合约束）', async () => {
    // 项目层专家：tools 声明 [dispatch_task, write_file]（write_file 必须被 Router 收窄压掉）
    const dir = path.join(tmp, '.delta', 'experts', 'sched-expert');
    await fs.mkdir(path.join(dir, 'agents'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'expert.json'),
      JSON.stringify({
        name: 'sched-expert',
        version: '1.0.0',
        description: 'd',
        author: { name: 't' },
        expertType: 'agent',
        agentName: 'sched-expert-agent',
        agents: ['agents/sched-expert-agent.md'],
        displayName: { en: 'sched', zh: '调度' },
        profession: { en: 'P', zh: '调度' },
        tools: ['dispatch_task', 'write_file'],
      }),
    );
    await fs.writeFile(
      path.join(dir, 'agents', 'sched-expert-agent.md'),
      '---\nname: sched-expert-agent\ndescription: x\ndisplayName_zh: 调度\nprofession_zh: 调度\n---\n\n正文',
    );

    const provider = new CapturingProvider();
    const hub = new SessionHub({
      service,
      registry: makeRegistryWithStubs(),
      resolveProvider: async () => provider,
      autoDistill: false,
    });
    const s = service.createSession(projectId, {
      model: 'test-model',
      mode: 'react',
      expert: 'sched-expert',
      expertType: 'agent',
    });
    service.store.setSessionKind(s.id, 'router');

    await hub.send(s.id, '派单');

    // 专家收窄 {dispatch_task, write_file} ∩ Router {dispatch_task, task_status} = {dispatch_task}
    expect(new Set(provider.requests[0]!.tools.map((t) => t.name))).toEqual(new Set(['dispatch_task']));
  });
});

// ── AC2：运行态互斥语义（hub 层验证，http.ts:1026 不改）──────────────────────

describe('AC2：Worker 运行中 → Router 不 409；同一 Worker 仍互斥', () => {
  it('跨会话并行发送正常完成；同会话并发 send 抛 already running；peekRunning 与 isRunning 同步', async () => {
    const provider = new DelayProvider();
    const hub = new SessionHub({ service, registry: new ToolRegistry(), resolveProvider: async () => provider });
    const workerId = service.createSession(projectId, { model: 'test-model', mode: 'react' }).id;
    const routerId = makeRouterSession();

    provider.delayMs = 250;
    const workerRun = hub.send(workerId, '慢任务').catch(() => undefined);
    await waitFor(() => hub.isRunning(workerId), 5000, 'enter running state');

    // 运行态观测：peekRunning 与 isRunning 在活跃运行期间口径一致
    expect(hub.peekRunning(workerId)).toBe(true);

    // Worker 运行中 → 向 Router 发消息不 409（正常完成）
    await expect(hub.send(routerId, '给 Router 的指令')).resolves.toBeUndefined();

    // 向同一 Worker 再发 → 409 的 hub 层来源：单槽互斥
    await expect(hub.send(workerId, '并发指令')).rejects.toThrow('session is already running');

    await workerRun;
    await waitFor(() => !hub.isRunning(workerId), 5000, 'run finished');
    expect(hub.peekRunning(workerId)).toBe(false);
  });
});

// ── peekRunning 零副作用（§9.3 核心回归）────────────────────────────────────

describe('peekRunning 零副作用 vs isRunning 既有语义（裁决 Q4）', () => {
  it('超 31 分钟伪 entry：peekRunning=true 且不清理不推 run_error；isRunning 问一次即按既有语义回收', () => {
    const hub = new SessionHub({
      service,
      registry: new ToolRegistry(),
      resolveProvider: explodingProvider,
    });
    const sid = service.createSession(projectId, { model: 'test-model', mode: 'react' }).id;
    const events = collectEvents(hub, sid);
    // 伪 entry：startedAt 超 31 分钟（模拟一个跑超 30 分钟的 Worker）
    runningMap(hub).set(sid, { ac: new AbortController(), startedAt: Date.now() - 31 * 60_000 });

    // peekRunning：纯读——返回 true、running 表未被清理、未推 run_error
    expect(hub.peekRunning(sid)).toBe(true);
    expect(runningMap(hub).has(sid)).toBe(true);
    expect(events.some((e) => e.type === 'run_error')).toBe(false);

    // isRunning 行为零变化：问一次即触发既有 zombieReap（回收 + run_error「僵尸运行清理」）
    expect(hub.isRunning(sid)).toBe(false);
    expect(runningMap(hub).has(sid)).toBe(false);
    const reapErrors = events.filter(
      (e): e is Extract<HubEvent, { type: 'run_error'; message: string }> =>
        e.type === 'run_error' && e.message.includes('僵尸运行清理'),
    );
    expect(reapErrors).toHaveLength(1);
  });
});

// ── onRunFinished 三条路径透传 ───────────────────────────────────────────────

describe('onRunFinished：done / failed(异常) / aborted 三路径（design §13）', () => {
  function makeHubWithSpy(onRunFinished: SessionHubDeps['onRunFinished']): SessionHub {
    return new SessionHub({
      service,
      registry: new ToolRegistry(),
      resolveProvider: async () => new DelayProvider(),
      onRunFinished,
    });
  }

  it('done 路径：runError=undefined、aborted=false、durationMs≥0', async () => {
    const spy = vi.fn();
    const hub = makeHubWithSpy(spy);
    const sid = service.createSession(projectId, { model: 'test-model', mode: 'react' }).id;

    await hub.send(sid, '正常完成');

    expect(spy).toHaveBeenCalledTimes(1);
    const [calledId, outcome] = spy.mock.calls[0] as [string, { runError?: string; aborted: boolean; durationMs: number }];
    expect(calledId).toBe(sid);
    expect(outcome.runError).toBeUndefined();
    expect(outcome.aborted).toBe(false);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('failed 路径：provider 解析抛异常 → runError 透传异常消息', async () => {
    // 手法说明：引擎对 chat 流内抛错按可重试退避（最长 1s+2s+4s），不适合做确定性失败源；
    // resolveProvider 抛错落在 send 的 try 内 → catch 落 runError，路径确定
    const spy = vi.fn();
    const hub = new SessionHub({
      service,
      registry: new ToolRegistry(),
      resolveProvider: async () => {
        throw new Error('resolveProvider boom');
      },
      onRunFinished: spy,
    });
    const sid = service.createSession(projectId, { model: 'test-model', mode: 'react' }).id;

    await hub.send(sid, '会炸的任务');

    expect(spy).toHaveBeenCalledTimes(1);
    const [, outcome] = spy.mock.calls[0] as [string, { runError?: string; aborted: boolean; durationMs: number }];
    expect(outcome.runError).toContain('resolveProvider boom');
    expect(outcome.aborted).toBe(false);
  });

  it('failed 路径：外部引擎 error{fatal} → runError 置值（F-58 AC3 收敛链，exit≠0 无产出 → failed(runtime)）', async () => {
    // 手法说明：外部引擎「exit≠0 且无产出」不发异常，而是沿事件流发 error{fatal:true} + done
    // （engine/external.ts:441）；hub 必须把 fatal 事件写进 runError，否则 onRunFinished 收到
    // 空 runError，dispatcher 会把任务误标 done 而非 failed(runtime)。
    // 走 ScriptedExternalAdapter + fake-cli.mjs（同 external-hub.test.ts 手法，真启子进程）
    const scenarioPath = path.join(tmp, 'scenario-f58-exit3.json');
    await fs.writeFile(
      scenarioPath,
      JSON.stringify([{ type: 'exit', code: 3 }]),
    );
    const prevFakeCli = process.env.DELTA_FAKE_CLI;
    process.env.DELTA_FAKE_CLI = scenarioPath;
    registerExternalAdapter(new ScriptedExternalAdapter());
    try {
      const spy = vi.fn();
      const hub = new SessionHub({
        service,
        registry: new ToolRegistry(),
        resolveProvider: async () => {
          throw new Error('resolveProvider 不应被外部会话调用');
        },
        onRunFinished: spy,
      });
      const sid = service.createSession(projectId, { model: 'cli:fake', mode: 'react' }).id;

      await hub.send(sid, '退出码非零的任务');

      expect(spy).toHaveBeenCalledTimes(1);
      const [, outcome] = spy.mock.calls[0] as [string, { runError?: string; aborted: boolean; durationMs: number }];
      // engine/external.ts 的 fatal 文案：`外部 agent 进程退出（exit 3）`
      expect(outcome.runError).toContain('exit 3');
      expect(outcome.aborted).toBe(false);
    } finally {
      if (prevFakeCli === undefined) delete process.env.DELTA_FAKE_CLI;
      else process.env.DELTA_FAKE_CLI = prevFakeCli;
    }
  });

  it('aborted 路径：运行中 abort → aborted=true', async () => {
    const spy = vi.fn();
    const provider = new DelayProvider();
    const hub = new SessionHub({
      service,
      registry: new ToolRegistry(),
      resolveProvider: async () => provider,
      onRunFinished: spy,
    });
    const sid = service.createSession(projectId, { model: 'test-model', mode: 'react' }).id;

    provider.delayMs = 400;
    provider.slowMarker = ''; // 该测试单会话独占 provider，所有调用都延时以留出 abort 窗口
    const run = hub.send(sid, '会被中止的任务').catch(() => undefined);
    await waitFor(() => hub.peekRunning(sid), 5000, 'enter running state');
    hub.abort(sid);
    await run;

    expect(spy).toHaveBeenCalledTimes(1);
    const [, outcome] = spy.mock.calls[0] as [string, { runError?: string; aborted: boolean; durationMs: number }];
    expect(outcome.aborted).toBe(true);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── send 入口防御（design §4.4 拦截点 2）────────────────────────────────────

describe('send 入口防御：Router 会话 + 外部模型', () => {
  it('kind=router 且 model=cli:* → run_error 拒绝；零副作用（不占运行态、不落消息、不碰 provider）', async () => {
    const hub = new SessionHub({
      service,
      registry: new ToolRegistry(),
      resolveProvider: explodingProvider,
    });
    const routerId = makeRouterSession('cli:fake');
    const events = collectEvents(hub, routerId);

    // 拒绝以正常返回收尾（不抛错：事件流已携带失败原因）
    await expect(hub.send(routerId, '试图用外部 agent 当 Router')).resolves.toBeUndefined();

    const runErrors = events.filter((e) => e.type === 'run_error');
    expect(runErrors).toHaveLength(1);
    expect(runErrors[0]!.type === 'run_error' && runErrors[0]!.message).toContain('不允许使用外部模型');
    // 零副作用：未进运行态、用户消息未落库
    expect(hub.peekRunning(routerId)).toBe(false);
    expect(service.getHistory(routerId)).toEqual([]);
  });

  it('外部模型但 kind=chat：不受防御影响（走既有第 4 引擎路径，零回归）', async () => {
    const provider = new CapturingProvider();
    const hub = new SessionHub({ service, registry: new ToolRegistry(), resolveProvider: async () => provider });
    // 普通 chat 会话挂外部模型只会走到引擎层（无 adapter 时发 external_agent_not_found），
    // 这里只断言入口防御没有误伤：send 未被 run_error 拒绝在入口
    const chatId = service.createSession(projectId, { model: 'cli:unknown', mode: 'react' }).id;
    const events = collectEvents(hub, chatId);

    await hub.send(chatId, '外部会话');

    const entryReject = events.find(
      (e) => e.type === 'run_error' && (e as { message: string }).message.includes('不允许使用外部模型'),
    );
    expect(entryReject).toBeUndefined();
    expect(service.getHistory(chatId)[0]!.content).toBe('外部会话');
  });
});
