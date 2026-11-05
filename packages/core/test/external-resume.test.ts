/**
 * F-55 Task 13：会话续跑单测（docs/design-f55-external-cli-agents.md §8）。
 *
 * 覆盖：
 *  1. external_session 上报 → onExternalSession 回调收到 id；缺省（无回调）不崩。
 *  2. 令牌失效降级：带令牌续跑 + 首轮「未建立会话 + 无产出 + 非零退出」→ 丢弃令牌重跑，
 *     prompt = delta 历史摘要 + 本次输入，提示 error（fatal:false）仅一次，done 恰一次；
 *     首轮上游 fatal error 降级为 fatal:false（重建成功不以 fatal 告终，AC-55-8），
 *     降级轮再失败则 fatal 照常透传（最多一轮 fallback）。
 *  3. 降级不触发（防误伤三条）：首轮成功 / 无令牌 / 会话已建立但 exit 3 → 均只跑一次。
 *  4. 持久化：store.setSessionExternal 落库 + getSession 读回 external_id/external_agent 两列。
 *  5. 超长 history（>8000 字符）→ 摘要截断保尾。
 *
 * adapter 用多脚本 AsyncGenerator（每次 run 消费下一个脚本），零真实 CLI、零协议解析。
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AgentEvent, ChatMessage } from '@delta/shared';
import { runExternalAgent } from '../src/engine/external.js';
import type { RunContext } from '../src/engine/react.js';
import { registerExternalAdapter } from '../src/external/registry.js';
import type { ExternalAgentAdapter, ExternalAgentSpec, ExternalEvent } from '../src/external/types.js';
import { SessionService } from '../src/session/service.js';

const MODEL = 'cli:fake';
const RESUME_NOTICE = '外部会话 resume 令牌失效';

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
  resumeSessionId: string | undefined;
}

/** 多脚本 adapter：第 n 次 run() 消费 runs[n]，记录每次入参 */
function multiRunAdapter(runs: ExternalEvent[][]): ExternalAgentAdapter & { captures: RunCapture[] } {
  const self: ExternalAgentAdapter & { captures: RunCapture[] } = {
    spec: baseSpec(),
    captures: [],
    run: async function* (req) {
      self.captures.push({ prompt: req.prompt, resumeSessionId: req.resumeSessionId });
      const script = runs[Math.min(self.captures.length - 1, runs.length - 1)] ?? [];
      for (const ev of script) yield ev;
    },
  };
  return self;
}

/** 极简 RunContext：只填 runExternalAgent 用到的字段 */
function makeCtx(opts: {
  externalResume?: { externalId: string; agentId: string };
  onExternalSession?: (externalId: string) => void;
} = {}): RunContext {
  const controller = new AbortController();
  return {
    sessionId: 's_test',
    projectId: 'p_test',
    mode: 'react',
    model: MODEL,
    systemPrompt: '',
    maxTurns: 1,
    signal: controller.signal,
    provider: {} as never,
    registry: {} as never,
    toolContext: {
      projectRoot: '/tmp/fake-project',
      signal: controller.signal,
      confirm: async () => ({ kind: 'allow' }) as never,
    },
    budget: {} as never,
    windowTokens: 100_000,
    ...(opts.externalResume ? { externalResume: opts.externalResume } : {}),
    ...(opts.onExternalSession ? { onExternalSession: opts.onExternalSession } : {}),
  } as unknown as RunContext;
}

async function collect(ctx: RunContext, history: ChatMessage[], input = '继续任务'): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of runExternalAgent(ctx, history, input)) events.push(ev);
  return events;
}

// ── 1. external_session 上报 ─────────────────────────────────────────────────

describe('external_session 上报（§8）', () => {
  it('adapter 产 external_session → onExternalSession 回调收到 id，不产出任何事件', async () => {
    const reported: string[] = [];
    const adapter = multiRunAdapter([
      [
        { type: 'external_session', id: 'cli-sess-42' },
        { type: 'text', text: 'hi' },
        { type: 'done', exitCode: 0 },
      ],
    ]);
    registerExternalAdapter(adapter);
    const events = await collect(makeCtx({ onExternalSession: (id) => reported.push(id) }), []);

    expect(reported).toEqual(['cli-sess-42']);
    // external_session 本身不产出事件（映射规则不变）
    expect(events.map((e) => e.type)).toEqual(['turn_start', 'text_delta', 'done']);
  });

  it('未注入 onExternalSession（缺省）→ 不崩，事件流正常收尾', async () => {
    const adapter = multiRunAdapter([
      [
        { type: 'external_session', id: 'cli-sess-1' },
        { type: 'done', exitCode: 0 },
      ],
    ]);
    registerExternalAdapter(adapter);
    const events = await collect(makeCtx(), []);
    expect(events.at(-1)?.type).toBe('done');
  });
});

// ── 2. 令牌失效降级（§8.4 核心）───────────────────────────────────────────────

describe('令牌失效降级（§8.4）', () => {
  const HISTORY: ChatMessage[] = [
    { role: 'user', content: '历史第一条：请读取配置文件' },
    { role: 'assistant', content: '历史第二条：已完成配置迁移' },
  ];

  it('首轮（未建会话+无产出+exit 3）→ 丢弃令牌重跑，prompt 含历史摘要与本次输入，done 恰一次', async () => {
    const adapter = multiRunAdapter([
      // 首轮：带令牌，CLI 不认令牌直接失败（无 text、无 external_session、exit 3）
      [
        { type: 'error', message: 'session not found', fatal: true },
        { type: 'done', exitCode: 3 },
      ],
      // 重跑：摘要重建上下文后正常完成
      [
        { type: 'text', text: '重建上下文后完成' },
        { type: 'done', exitCode: 0 },
      ],
    ]);
    registerExternalAdapter(adapter);
    const ctx = makeCtx({ externalResume: { externalId: 'tok-stale', agentId: MODEL } });
    const events = await collect(ctx, HISTORY, '继续任务');

    // adapter 被调用两次：首轮带令牌，重跑丢弃令牌
    expect(adapter.captures).toHaveLength(2);
    expect(adapter.captures[0]).toMatchObject({ prompt: '继续任务', resumeSessionId: 'tok-stale' });
    expect(adapter.captures[1]).toMatchObject({ resumeSessionId: undefined });
    // 第二次 prompt = delta 历史摘要 + 本次输入（两条历史压缩片段 + input 都在）
    const fallbackPrompt = adapter.captures[1]!.prompt;
    expect(fallbackPrompt).toContain('user: 历史第一条：请读取配置文件');
    expect(fallbackPrompt).toContain('assistant: 历史第二条：已完成配置迁移');
    expect(fallbackPrompt).toContain('继续任务');

    // 降级提示 error（fatal:false）恰一次
    const notices = events.filter((e) => e.type === 'error' && e.message.includes(RESUME_NOTICE));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ fatal: false });

    // 重跑结果正常产出；最终 done 恰一次
    expect(events.some((e) => e.type === 'text_delta' && e.text === '重建上下文后完成')).toBe(true);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('history 为空 → 重跑 prompt 退化为本次输入原文', async () => {
    const adapter = multiRunAdapter([
      [{ type: 'done', exitCode: 3 }],
      [{ type: 'text', text: 'ok' }, { type: 'done', exitCode: 0 }],
    ]);
    registerExternalAdapter(adapter);
    await collect(makeCtx({ externalResume: { externalId: 'tok-stale', agentId: MODEL } }), [], '原始输入');

    expect(adapter.captures[1]!.prompt).toBe('原始输入');
  });

  it('超长 history（摘要 >8000 字符）→ 摘要截断保尾，重跑 prompt 不超上限', async () => {
    // 摘要逐条压成「role: 内容前 200 字」：60 条 200+ 字符消息，总摘要 > 8000
    const longHistory: ChatMessage[] = [
      { role: 'user', content: 'HEAD_被截掉的前缀' + 'A'.repeat(300) },
      ...Array.from({ length: 58 }, (_, i) => ({ role: 'user' as const, content: `第${i}条：` + 'M'.repeat(180) })),
      { role: 'assistant', content: 'TAIL_SENTINEL_结尾要点' + 'B'.repeat(300) },
    ];
    const adapter = multiRunAdapter([
      [{ type: 'done', exitCode: 3 }],
      [{ type: 'text', text: 'ok' }, { type: 'done', exitCode: 0 }],
    ]);
    registerExternalAdapter(adapter);
    await collect(makeCtx({ externalResume: { externalId: 'tok-stale', agentId: MODEL } }), longHistory, '继续');

    const prompt = adapter.captures[1]!.prompt;
    // 截断标记顶在摘要开头；prompt ≤ 上限 + 标记 + input（余量 1k）
    expect(prompt.startsWith('（delta 历史过长，前')).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(8_000 + 1_000);
    // 保尾：末段内容保留，头部前缀被截掉
    expect(prompt).toContain('TAIL_SENTINEL_结尾要点');
    expect(prompt).not.toContain('HEAD_被截掉的前缀');
    expect(prompt).toContain('继续');
  });

  it('resume + 首轮 fatal + 降级重建成功 → 全流无 fatal:true error（首轮 fatal 已降级），done 恰一次', async () => {
    // AC-55-8 headless 语义：首轮上游 fatal error 降级为 fatal:false，重建成功后
    // 整个 turn 不以 fatal 告终（runHeadless 不记 fatalMessage / failed 退出码）
    const adapter = multiRunAdapter([
      [{ type: 'error', message: 'session not found', fatal: true }, { type: 'done', exitCode: 3 }],
      [{ type: 'text', text: '重建成功' }, { type: 'done', exitCode: 0 }],
    ]);
    registerExternalAdapter(adapter);
    const events = await collect(makeCtx({ externalResume: { externalId: 'tok-stale', agentId: MODEL } }), HISTORY, '继续任务');

    // 原始 fatal message 保留但降级为 fatal:false
    const sessionNotFound = events.filter((e) => e.type === 'error' && e.message === 'session not found');
    expect(sessionNotFound).toHaveLength(1);
    expect(sessionNotFound[0]).toMatchObject({ fatal: false });
    // 全事件流不存在 fatal:true 的 error
    expect(events.some((e) => e.type === 'error' && e.fatal === true)).toBe(false);
    // 降级提示（fatal:false）恰一次
    const notices = events.filter((e) => e.type === 'error' && e.message.includes(RESUME_NOTICE));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ fatal: false });
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('resume + 首轮 fatal + 降级轮也 fatal → 最终有 fatal:true error（来自第二轮），done 恰一次', async () => {
    // 最多一轮 fallback：第二轮真实失败照常 fatal 透传（不降级、不重试）
    const adapter = multiRunAdapter([
      [{ type: 'error', message: 'session not found', fatal: true }, { type: 'done', exitCode: 3 }],
      [{ type: 'error', message: 'rebuild boom', fatal: true }, { type: 'done', exitCode: 3 }],
    ]);
    registerExternalAdapter(adapter);
    const events = await collect(makeCtx({ externalResume: { externalId: 'tok-stale', agentId: MODEL } }), HISTORY, '继续任务');

    // 第一轮 fatal 已降级
    expect(events.some((e) => e.type === 'error' && e.message === 'session not found' && e.fatal === true)).toBe(false);
    // 第二轮 fatal 原样保留
    const fatalErrors = events.filter((e) => e.type === 'error' && e.fatal === true);
    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]).toMatchObject({ message: 'rebuild boom' });
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('done');
  });
});

// ── 3. 降级不触发（防误伤三条）───────────────────────────────────────────────

describe('降级不触发（防误伤）', () => {
  it('带令牌但首轮成功（有 text 产出）→ 只跑一次', async () => {
    const adapter = multiRunAdapter([
      [{ type: 'text', text: '成功' }, { type: 'done', exitCode: 0 }],
    ]);
    registerExternalAdapter(adapter);
    await collect(makeCtx({ externalResume: { externalId: 'tok-ok', agentId: MODEL } }), [], '继续任务');
    expect(adapter.captures).toHaveLength(1);
  });

  it('无 externalResume 且首轮 fatal → 只跑一次（不重试）', async () => {
    const adapter = multiRunAdapter([
      [{ type: 'error', message: 'boom', fatal: true }, { type: 'done', exitCode: 3 }],
    ]);
    registerExternalAdapter(adapter);
    const events = await collect(makeCtx(), [], '继续任务');
    expect(adapter.captures).toHaveLength(1);
    // 无令牌不降级：无提示 error
    expect(events.some((e) => e.type === 'error' && e.message.includes(RESUME_NOTICE))).toBe(false);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('带令牌 + 首轮已建立外部会话（有 external_session）但 exit 3 → 只跑一次（失败另有原因）', async () => {
    const adapter = multiRunAdapter([
      [
        { type: 'external_session', id: 'cli-sess-7' },
        { type: 'done', exitCode: 3 },
      ],
    ]);
    registerExternalAdapter(adapter);
    await collect(makeCtx({ externalResume: { externalId: 'tok-ok', agentId: MODEL } }), [], '继续任务');
    expect(adapter.captures).toHaveLength(1);
  });
});

// ── 4. 持久化（store 层）────────────────────────────────────────────────────

describe('resume 令牌持久化（store）', () => {
  it('setSessionExternal 落库 + getSession 读回 external_id/external_agent 两列', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'yz-ext-resume-'));
    try {
      const service = new SessionService(path.join(tmp, 'db.sqlite'));
      const projectId = service.ensureProject(tmp).id;
      const session = service.createSession(projectId, { model: 'cli:fake', mode: 'react' });

      // 初始：两列为 NULL
      let row = service.getSession(session.id)!;
      expect(row.external_id).toBeNull();
      expect(row.external_agent).toBeNull();

      // 写入 → 读回
      service.setSessionExternal(session.id, 'cli-sess-42', 'cli:fake');
      row = service.getSession(session.id)!;
      expect(row.external_id).toBe('cli-sess-42');
      expect(row.external_agent).toBe('cli:fake');

      // 覆盖式更新（claude --resume 会返回新 session id）
      service.setSessionExternal(session.id, 'cli-sess-43', 'cli:fake');
      row = service.getSession(session.id)!;
      expect(row.external_id).toBe('cli-sess-43');

      service.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('listSessions / searchSessions 等 SELECT 同步带出新列（SESSION_COLUMNS 共用清单）', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'yz-ext-resume-'));
    try {
      const service = new SessionService(path.join(tmp, 'db.sqlite'));
      const projectId = service.ensureProject(tmp).id;
      const session = service.createSession(projectId, { model: 'cli:fake', mode: 'react' });
      service.setSessionExternal(session.id, 'cli-sess-x', 'cli:fake');

      expect(service.listSessions(projectId)[0]).toMatchObject({
        external_id: 'cli-sess-x',
        external_agent: 'cli:fake',
      });
      service.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── 5. 降级路径整体回归 ──────────────────────────────────────────────────────

describe('降级重跑整体路径回归', () => {
  it('fallback 触发（首轮失败→重跑成功）经 try/finally 收尾不抛错，done 恰一次', async () => {
    // 回归点：runExternalAgent 重构后 done 产出收拢到外层 try，finally（MCP 临时文件
    // 清理）覆盖「首轮失败 + 重跑成功」双轮路径
    const adapter = multiRunAdapter([
      [{ type: 'done', exitCode: 3 }],
      [{ type: 'text', text: 'ok' }, { type: 'done', exitCode: 0 }],
    ]);
    registerExternalAdapter(adapter);
    const events = await collect(makeCtx({ externalResume: { externalId: 'tok-stale', agentId: MODEL } }), [], '继续');
    expect(events.at(-1)?.type).toBe('done');
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });
});
