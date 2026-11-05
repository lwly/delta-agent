/**
 * F-55 Task 5：hub 第 4 引擎分支（外部会话）集成单测。
 *
 * 覆盖：
 *  1. 端到端一轮：cli:fake 会话 → 假 CLI 场景 → 消息/usage 落库 + 事件流 done；
 *     resolveProvider 传 throw 函数，断言外部路径完全没碰它（无 Key 可跑）。
 *  2. 能力降级旁证：记忆蒸馏跳过（debug 日志断言）。
 *     取舍说明：ctx 在 send() 内部构造不外露，ctx.subagent === undefined 无法直接断言；
 *     外部引擎（runExternalAgent）不消费 subagent，行为侧无差分可观测，task_unavailable
 *     本身由 task-tool 既有单测覆盖——故以「蒸馏跳过的 debug 留痕」为可测旁证。
 *  3. DELTA_FAKE_CLI 环境变量命中 → 模块加载自动注册 cli:fake（e2e 装配路径）。
 *  4. 回归护栏：普通 provider 会话（ScriptedFakeProvider）recordUsage billing='metered'。
 */
import { afterAll, beforeEach, describe, expect, it, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ChatMessage, ChatRequest, LLMProvider, StreamEvent } from '@delta/shared';
import { SessionService } from '../src/session/service.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { SessionHub, type HubEvent } from '../src/server/hub.js';
import { registerExternalAdapter } from '../src/external/registry.js';
import { ScriptedExternalAdapter } from '../src/external/scripted.js';
import { ScriptedFakeProvider } from '../src/llm/fake-provider.js';
import type { LogEntry, LogLevel, RunLogSink } from '../src/logging/logger.js';

let tmp = '';
let service: SessionService;
let projectId = '';

/** F-41 runLog 伪造 sink：收集日志供降级断言 */
const logs: LogEntry[] = [];
const runLog: RunLogSink = {
  append(level: LogLevel, source: string, message: string, sessionId?: string) {
    logs.push({ ts: '', level, source, message, sessionId });
  },
};

/** 会炸的 resolveProvider：外部路径若碰到它，测试立即失败 */
const explodingResolveProvider = async (): Promise<LLMProvider> => {
  throw new Error('resolveProvider 不应被外部会话调用');
};

function makeHub(resolveProvider: () => Promise<LLMProvider>): SessionHub {
  return new SessionHub({
    service,
    registry: new ToolRegistry(),
    resolveProvider,
    runLog,
  });
}

/** 写场景 JSON 文件并打开 DELTA_FAKE_CLI，注册 ScriptedExternalAdapter */
async function useFakeCli(scenario: unknown[]): Promise<string> {
  const scenarioPath = path.join(tmp, 'scenario.json');
  await fs.writeFile(scenarioPath, JSON.stringify(scenario));
  process.env.DELTA_FAKE_CLI = scenarioPath;
  // 重复注册 = 同 id 覆盖（注册表语义），保证本测试实例的 adapter 生效
  registerExternalAdapter(new ScriptedExternalAdapter());
  return scenarioPath;
}

/** 订阅收集 hub 事件 */
function collectEvents(hub: SessionHub, sessionId: string): HubEvent[] {
  const events: HubEvent[] = [];
  hub.subscribe(sessionId, (ev) => events.push(ev));
  return events;
}

const usageRows = (sessionId: string) =>
  service.store.db
    .prepare(
      'SELECT turn, input_tokens, output_tokens, cost_usd, model, billing FROM usage WHERE session_id = ? ORDER BY turn',
    )
    .all(sessionId) as Array<{
    turn: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    model: string;
    billing: string;
  }>;

const ENV_KEYS = ['DELTA_FAKE_CLI', 'FAKE_CLI_SCRIPT'] as const;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-ext-hub-'));
  service = new SessionService(path.join(tmp, 'db.sqlite'));
  projectId = service.ensureProject(tmp).id;
  logs.length = 0;
});

afterEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  service.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

afterAll(async () => {
  vi.restoreAllMocks();
});

// ── 1. 端到端一轮（provider 零触碰）──────────────────────────────────────────

describe('外部会话端到端（cli:fake）', () => {
  it('一轮完成：消息落库 / usage billing=subscription / 事件流 done；resolveProvider 全程未被调用', async () => {
    // 场景：text 两段 + tool_use + tool_result + usage + done，exit 0
    await useFakeCli([
      { type: 'stdout', text: JSON.stringify({ type: 'text', text: '第一段回复' }) },
      { type: 'stdout', text: JSON.stringify({ type: 'text', text: '第二段回复' }) },
      {
        type: 'stdout',
        text: JSON.stringify({
          type: 'tool_use',
          id: 'call_1',
          name: 'read_file',
          argsJson: JSON.stringify({ path: 'note.txt' }),
        }),
      },
      {
        type: 'stdout',
        text: JSON.stringify({ type: 'tool_result', id: 'call_1', ok: true, content: 'note 内容' }),
      },
      { type: 'stdout', text: JSON.stringify({ type: 'usage', input: 120, output: 30 }) },
      { type: 'stdout', text: JSON.stringify({ type: 'done', exitCode: 0 }) },
      { type: 'exit', code: 0 },
    ]);

    const session = service.createSession(projectId, { model: 'cli:fake', mode: 'react' });
    const hub = makeHub(explodingResolveProvider);
    const events = collectEvents(hub, session.id);

    await hub.send(session.id, '帮我读一下 note.txt');

    // 消息落库：user / assistant(toolCalls) / tool 一一配对，内容与场景一致
    const history: ChatMessage[] = service.getHistory(session.id);
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(history[0]!.content).toBe('帮我读一下 note.txt');
    expect(history[1]!.content).toBe('第一段回复第二段回复');
    expect(history[1]!.toolCalls).toEqual([
      { id: 'call_1', name: 'read_file', argsJson: JSON.stringify({ path: 'note.txt' }) },
    ]);
    expect(history[2]!.toolCallId).toBe('call_1');
    expect(history[2]!.content).toBe('note 内容');

    // usage：billing='subscription'、cost_usd=0（订阅口径，§7）
    expect(usageRows(session.id)).toEqual([
      {
        turn: 1,
        input_tokens: 120,
        output_tokens: 30,
        cost_usd: 0,
        model: 'cli:fake',
        billing: 'subscription',
      },
    ]);

    // 事件流：done 必达且聚合 usage；运行态收敛
    expect(events.some((e) => e.type === 'turn_start')).toBe(true);
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    expect(done && done.type === 'done' && done.usage).toMatchObject({ inputTokens: 120, outputTokens: 30 });
    const lastState = [...events].reverse().find((e) => e.type === 'state');
    expect(lastState).toMatchObject({ running: false });
  });
});

// ── 2. 能力降级旁证 ─────────────────────────────────────────────────────────

describe('外部会话能力降级（§5.2）', () => {
  it('done 后跳过记忆蒸馏并留 debug 日志', async () => {
    await useFakeCli([
      { type: 'stdout', text: JSON.stringify({ type: 'text', text: '只输出文本' }) },
      { type: 'stdout', text: JSON.stringify({ type: 'done', exitCode: 0 }) },
      { type: 'exit', code: 0 },
    ]);

    const session = service.createSession(projectId, { model: 'cli:fake', mode: 'react' });
    const hub = makeHub(explodingResolveProvider);
    await hub.send(session.id, '做个总结');

    const distillLogs = logs.filter((l) => l.sessionId === session.id && l.message.includes('跳过记忆蒸馏'));
    expect(distillLogs.length).toBeGreaterThanOrEqual(1);
    expect(distillLogs[0]!.level).toBe('debug');
  });
});

// ── 3. DELTA_FAKE_CLI 自动注册（e2e 装配路径）────────────────────────────────

describe('DELTA_FAKE_CLI 自动注册', () => {
  it('env 非空时模块加载即注册 cli:fake；未注册的 cli:xxx 由引擎报 external_agent_not_found', async () => {
    // resetModules 得到全新 registry/scripted 模块实例，验证模块加载副作用（注册表语义自包含）
    vi.resetModules();
    process.env.DELTA_FAKE_CLI = path.join(tmp, 'whatever.json');
    try {
      const { resolveExternalAdapter } = await import('../src/external/registry.js');
      await import('../src/external/scripted.js');
      expect(resolveExternalAdapter('cli:fake')).toBeDefined();
      expect(resolveExternalAdapter('cli:claude-code')).toBeUndefined();
    } finally {
      delete process.env.DELTA_FAKE_CLI;
      vi.resetModules();
    }
  });
});

// ── 5. 会话续跑：external_session 上报持久化（Task 13，§8）─────────────────────

describe('resume 令牌持久化（hub 接线）', () => {
  it('fake-cli 场景含 external_session 行 → send() 后 sessions.external_id/external_agent 落库', async () => {
    await useFakeCli([
      { type: 'stdout', text: JSON.stringify({ type: 'external_session', id: 'cli-sess-42' }) },
      { type: 'stdout', text: JSON.stringify({ type: 'text', text: '已建立 CLI 会话' }) },
      { type: 'stdout', text: JSON.stringify({ type: 'done', exitCode: 0 }) },
      { type: 'exit', code: 0 },
    ]);

    const session = service.createSession(projectId, { model: 'cli:fake', mode: 'react' });
    const hub = makeHub(explodingResolveProvider);
    await hub.send(session.id, '开始任务');

    // 下一轮 send 时 hub 将读回该令牌作为 resumeSessionId（外部 id 只作令牌存储）
    const row = service.getSession(session.id);
    expect(row).toMatchObject({ external_id: 'cli-sess-42', external_agent: 'cli:fake' });
  });
});

// ── 4. 回归护栏：provider 会话不受影响 ───────────────────────────────────────

describe('provider 会话回归护栏', () => {
  it('普通模型会话照常走 LLMProvider，recordUsage billing=metered', async () => {
    const session = service.createSession(projectId, { model: 'gpt-4o-mini', mode: 'react' });
    const hub = makeHub(async () => new ScriptedFakeProvider('scripted'));
    const events = collectEvents(hub, session.id);

    await hub.send(session.id, '读一下 note.txt 然后告诉我');

    // scripted 两轮：工具调用 → 最终答案
    const history = service.getHistory(session.id);
    expect(history[history.length - 1]!.content).toContain('E2E_FAKE_DONE');
    expect(events.some((e) => e.type === 'done')).toBe(true);

    // billing 回退 metered（usage 事件无 billing 字段 → ?? 'metered'）
    const rows = usageRows(session.id);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.billing === 'metered')).toBe(true);
    expect(rows.every((r) => r.cost_usd > 0)).toBe(true);
  });
});
