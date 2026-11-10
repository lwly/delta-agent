/**
 * F-55 Tier A ACP 适配器单测（docs/design-f55-external-cli-agents.md §2/§3/§9）：
 *  - 全部走 spawnExternal + fake-acp-agent.mjs fixture（JSON-RPC over stdio），零网络、零真实 CLI；
 *  - 场景经 FAKE_ACP_SCRIPT env 注入 fixture（adapter 镜像为子进程 env，对齐 DELTA_FAKE_CLI 先例）；
 *  - fatal 判定归映射引擎（engine/external.ts），本层只透传退出码。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpExternalAdapter } from '../src/external/acp.js';
import type { ExternalAgentSpec, ExternalEvent } from '../src/external/types.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-acp-agent.mjs');
const NODE = process.execPath;

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'yz-ext-acp-'));
});
afterEach(async () => {
  delete process.env.FAKE_ACP_SCRIPT;
  await rm(tmp, { recursive: true, force: true });
});

function makeSpec(): ExternalAgentSpec {
  return {
    id: 'acp:fake',
    kind: 'acp',
    command: NODE,
    args: [FIXTURE],
    tier: 'A',
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
}

/** 跑一轮会话并收集事件（done 即止） */
async function runScenario(adapter: AcpExternalAdapter, scenario: Record<string, unknown>, opts: RunOptions = {}): Promise<ExternalEvent[]> {
  const events: ExternalEvent[] = [];
  for await (const ev of startScenario(adapter, scenario, opts)) {
    events.push(ev);
    if (ev.type === 'done') break;
  }
  return events;
}

/** 写场景文件 + 置 FAKE_ACP_SCRIPT 后返回原始事件迭代器（供测试中途 abort / respondPermission） */
async function* startScenario(adapter: AcpExternalAdapter, scenario: Record<string, unknown>, opts: RunOptions = {}): AsyncGenerator<ExternalEvent> {
  const scenarioPath = await writeScenario(scenario);
  process.env.FAKE_ACP_SCRIPT = scenarioPath;
  yield* adapter.run({
    prompt: opts.prompt ?? 'hi',
    cwd: tmp,
    permissionMode: 'default',
    signal: opts.signal ?? new AbortController().signal,
  });
}

const update = (sessionUpdate: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'update',
  params: { sessionId: 'fake-acp-session-1', update: { sessionUpdate, ...extra } },
});

describe('AcpExternalAdapter（F-55 Tier A：JSON-RPC over stdio）', () => {
  it('握手 + 一轮完整会话：external_session → text → done exit 0', async () => {
    const adapter = new AcpExternalAdapter(makeSpec());
    const events = await runScenario(adapter, {
      steps: [update('agent_message_chunk', { content: { type: 'text', text: 'hello' } })],
    });
    expect(events).toEqual([
      { type: 'external_session', id: 'fake-acp-session-1' },
      { type: 'text', text: 'hello' },
      { type: 'done', exitCode: 0 },
    ]);
  });

  it('thinking chunk → thinking ExternalEvent（protocolVersion 不一致也宽容不报错）', async () => {
    const adapter = new AcpExternalAdapter(makeSpec());
    const events = await runScenario(adapter, {
      protocolVersion: 99, // 版本协商宽容：agent 返回不同 version 不报错
      steps: [update('agent_thought_chunk', { content: { type: 'text', text: 'pondering' } })],
    });
    expect(events).toContainEqual({ type: 'thinking', text: 'pondering' });
    expect(events[events.length - 1]).toEqual({ type: 'done', exitCode: 0 });
  });

  it('tool_call 缺 rawInput 时回落 title/kind 摘要；tool_call_update 可从顶层 content 取结果', async () => {
    const adapter = new AcpExternalAdapter(makeSpec());
    const events = await runScenario(adapter, {
      steps: [
        update('tool_call', { toolCallId: 't0', title: 'Read README', kind: 'read' }),
        update('tool_call_update', {
          toolCallId: 't0',
          status: 'completed',
          content: { type: 'text', text: 'from-top-level-content' },
        }),
      ],
    });
    expect(events).toContainEqual({
      type: 'tool_use',
      id: 't0',
      name: 'Read README',
      argsJson: '{"title":"Read README","kind":"read","toolCallId":"t0"}',
    });
    expect(events).toContainEqual({
      type: 'tool_result',
      id: 't0',
      ok: true,
      content: 'from-top-level-content',
    });
  });

  it('tool_call + tool_call_update(completed/failed) → tool_use + tool_result；in_progress/pending 忽略', async () => {
    const adapter = new AcpExternalAdapter(makeSpec());
    const events = await runScenario(adapter, {
      steps: [
        update('tool_call', { toolCallId: 't1', title: 'Bash', kind: 'execute', rawInput: { cmd: 'ls' } }),
        update('tool_call_update', { toolCallId: 't1', status: 'in_progress' }), // 中间态：忽略
        update('tool_call_update', { toolCallId: 't1', status: 'completed', output: { content: [{ type: 'text', text: 'out-ok' }] } }),
        update('tool_call', { toolCallId: 't2', title: 'Edit', rawInput: { file: 'a.ts' } }),
        update('tool_call_update', { toolCallId: 't2', status: 'pending' }), // 中间态：忽略
        update('tool_call_update', {
          toolCallId: 't2',
          status: 'failed',
          output: { content: [{ type: 'text', text: 'boom' }, { type: 'image', data: 'xxx' }] },
        }),
      ],
    });
    expect(events).toEqual([
      { type: 'external_session', id: 'fake-acp-session-1' },
      { type: 'tool_use', id: 't1', name: 'Bash', argsJson: '{"cmd":"ls"}' },
      { type: 'tool_result', id: 't1', ok: true, content: 'out-ok' },
      { type: 'tool_use', id: 't2', name: 'Edit', argsJson: '{"file":"a.ts"}' },
      { type: 'tool_result', id: 't2', ok: false, content: 'boom\n{"type":"image","data":"xxx"}' },
      { type: 'done', exitCode: 0 },
    ]);
  });

  it('plan 通知 → plan ExternalEvent（缺 status 宽容为 pending）', async () => {
    const adapter = new AcpExternalAdapter(makeSpec());
    const events = await runScenario(adapter, {
      steps: [
        update('plan', {
          entries: [
            { content: 'step1', status: 'completed' },
            { content: 'step2', status: 'in_progress' },
            { content: 'step3' },
          ],
        }),
      ],
    });
    expect(events).toContainEqual({
      type: 'plan',
      steps: [
        { title: 'step1', status: 'completed' },
        { title: 'step2', status: 'in_progress' },
        { title: 'step3', status: 'pending' },
      ],
    });
  });

  it('未知 sessionUpdate 忽略不崩；非法 JSON 行 → error fatal:false 且会话继续', async () => {
    const adapter = new AcpExternalAdapter(makeSpec());
    const events = await runScenario(adapter, {
      steps: [
        update('future_unknown_thing', { foo: 1 }), // 未知类型：忽略
        { type: 'raw', text: '{"not-json' }, // 非法 JSON：error fatal:false
        update('agent_message_chunk', { content: { type: 'text', text: 'after' } }),
      ],
    });
    const errors = events.filter((e): e is Extract<ExternalEvent, { type: 'error' }> => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].fatal).toBe(false);
    expect(errors[0].message).toContain('{"not-json');
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'after' }]);
    expect(events[events.length - 1]).toEqual({ type: 'done', exitCode: 0 });
  });

  it('permission_request → respondPermission(allow_session) 回包 optionId 对应 allow_always', async () => {
    const adapter = new AcpExternalAdapter(makeSpec());
    const events: ExternalEvent[] = [];
    for await (const ev of startScenario(adapter, {
      steps: [
        update('tool_call', { toolCallId: 't1', title: 'Bash', kind: 'execute', rawInput: { cmd: 'rm' } }),
        {
          type: 'request_permission',
          params: {
            sessionId: 'fake-acp-session-1',
            toolCall: { toolCallId: 't1', title: 'Bash', kind: 'execute', rawInput: { cmd: 'rm' } },
            options: [
              { optionId: 'opt-allow-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'opt-allow-always', name: 'Allow always', kind: 'allow_always' },
              { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' },
            ],
          },
        },
      ],
    })) {
      events.push(ev);
      if (ev.type === 'permission_request') {
        expect(ev.tool).toBe('Bash');
        expect(ev.argsJson).toBe('{"cmd":"rm"}');
        expect(ev.options).toEqual(['opt-allow-once', 'opt-allow-always', 'opt-reject']);
        // id = JSON-RPC 请求 id 字符串化；allow_session → 期望选中 allow_always 类 option
        expect(ev.id).toMatch(/^\d+$/);
        adapter.respondPermission(ev.id, 'allow_session');
      }
      if (ev.type === 'done') break;
    }
    // fixture 把收到的 outcome 回显进下一条 message chunk 的 text
    const outcomeText = events.find((e) => e.type === 'text' && String((e as { text: string }).text).startsWith('permission-outcome:'));
    expect(outcomeText).toBeDefined();
    expect((outcomeText as { text: string }).text).toBe(
      'permission-outcome:{"outcome":"selected","optionId":"opt-allow-always"}',
    );
    expect(events[events.length - 1]).toEqual({ type: 'done', exitCode: 0 });
  });

  it('respondPermission 对未知 id / 已答复 id 均静默不崩（重复应答只回一次）', async () => {
    const adapter = new AcpExternalAdapter(makeSpec());
    expect(() => adapter.respondPermission('no-such-id', 'allow')).not.toThrow();

    let answered = 0;
    const events: ExternalEvent[] = [];
    for await (const ev of startScenario(adapter, {
      steps: [
        {
          type: 'request_permission',
          params: {
            sessionId: 'fake-acp-session-1',
            toolCall: { toolCallId: 't1', title: 'Bash', kind: 'execute' },
            options: [
              { optionId: 'opt-allow-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' },
            ],
          },
        },
      ],
    })) {
      events.push(ev);
      if (ev.type === 'permission_request') {
        answered++;
        adapter.respondPermission(ev.id, 'reject');
        adapter.respondPermission(ev.id, 'allow'); // 已答复：静默忽略，fixture 只收到一次回包
      }
      if (ev.type === 'done') break;
    }
    expect(answered).toBe(1);
    const outcomes = events.filter((e) => e.type === 'text' && String((e as { text: string }).text).startsWith('permission-outcome:'));
    expect(outcomes).toHaveLength(1);
    expect((outcomes[0] as { text: string }).text).toBe(
      'permission-outcome:{"outcome":"selected","optionId":"opt-reject"}',
    );
  });

  it('abort：session/cancel 通知到达 fixture（stderr 记录）→ 进程退出 → done', async () => {
    const adapter = new AcpExternalAdapter(makeSpec());
    const ac = new AbortController();
    const events: ExternalEvent[] = [];
    for await (const ev of startScenario(adapter, { steps: [{ type: 'delay', ms: 10000 }] }, { signal: ac.signal })) {
      events.push(ev);
      if (ev.type === 'external_session') ac.abort(); // 会话建立后立刻 abort
      if (ev.type === 'done') break;
    }
    expect(events[events.length - 1]).toEqual({ type: 'done', exitCode: 0 });
    // fixture 收到 session/cancel 通知后写 stderr 并退出
    expect(adapter.stderrTail().join('\n')).toContain('recv: session/cancel');
  });

  it('prompt 回包即本轮结束：常驻 agent 不退出也照样 done（cursor-agent「答完不停」回归）', async () => {
    const adapter = new AcpExternalAdapter(makeSpec());
    const events = await runScenario(adapter, {
      steps: [update('agent_message_chunk', { content: { type: 'text', text: 'hello' } })],
      keepAlive: true, // fixture 回包后不退出：done 必须由适配器在回包时立即产出
    });
    expect(events).toEqual([
      { type: 'external_session', id: 'fake-acp-session-1' },
      { type: 'text', text: 'hello' },
      { type: 'done', exitCode: 0 },
    ]);
  });

  it('exit 非 0 且无产出 → done exit N（fatal 判定归映射引擎，本层只透传）', async () => {
    const adapter = new AcpExternalAdapter(makeSpec());
    const events = await runScenario(adapter, { steps: [{ type: 'exit', code: 3 }] });
    expect(events).toEqual([
      { type: 'external_session', id: 'fake-acp-session-1' },
      { type: 'done', exitCode: 3 },
    ]);
  });

  it('stderrTail 透传 fixture 的 stderr 输出（环形缓冲非空）', async () => {
    const adapter = new AcpExternalAdapter(makeSpec());
    await runScenario(adapter, { steps: [{ type: 'stderr', text: 'acp-stderr-marker' }] });
    expect(adapter.stderrTail().join('\n')).toContain('acp-stderr-marker');
  });
});

describe('AcpExternalAdapter 认证流（codebuddy -32000 实测：自动 authenticate + 登录链接直出）', () => {
  it('session/new 认证错 → auth_required + authenticate → auth_url 事件 → 重试 session/new 成功，会话正常跑通', async () => {
    const adapter = new AcpExternalAdapter(makeSpec());
    const events = await runScenario(adapter, {
      requireAuth: true,
      authMethods: [
        { id: 'iOA', name: 'iOA 账号' },
        { id: 'external', name: '外部账号' },
      ],
      authUrl: 'https://example.com/login?token=fake-acp',
      steps: [update('agent_message_chunk', { content: { type: 'text', text: 'after-auth' } })],
    });
    expect(events).toEqual([
      { type: 'auth_required', methods: [
        { id: 'iOA', name: 'iOA 账号' },
        { id: 'external', name: '外部账号' },
      ] },
      { type: 'auth_url', url: 'https://example.com/login?token=fake-acp' },
      { type: 'external_session', id: 'fake-acp-session-1' },
      { type: 'text', text: 'after-auth' },
      { type: 'done', exitCode: 0 },
    ]);
  });

  it('params.url 兜底：agent 发 url 字段（非 authUrl）同样产出 auth_url 事件', async () => {
    const adapter = new AcpExternalAdapter(makeSpec());
    const events = await runScenario(adapter, {
      requireAuth: true,
      authMethods: [{ id: 'iOA', name: 'iOA 账号' }],
      authUrl: 'https://example.com/login?via=url-field',
      authUrlParam: 'url',
      steps: [],
    });
    expect(events).toContainEqual({ type: 'auth_url', url: 'https://example.com/login?via=url-field' });
  });

  it('authenticate 失败 → external_auth_failed 带错误原因与 stderr 尾行（不吞 EPERM 类根因），最终 fatal 上抛', async () => {
    const adapter = new AcpExternalAdapter(makeSpec());
    const events = await runScenario(adapter, {
      requireAuth: true,
      authMethods: [{ id: 'iOA', name: 'iOA 账号' }],
      authFail: 'sign in error: EPERM: operation not permitted',
    });
    const failed = events.find((e): e is Extract<ExternalEvent, { type: 'error' }> =>
      e.type === 'error' && e.message.startsWith('external_auth_failed'),
    );
    expect(failed?.fatal).toBe(false);
    expect(failed?.message).toContain('authenticate failed');
    expect(failed?.message).toContain('EPERM: operation not permitted');
    // 最终仍按协议错收尾（fatal，done exit 1）
    const fatal = events.find((e): e is Extract<ExternalEvent, { type: 'error' }> => e.type === 'error' && e.fatal);
    expect(fatal?.message).toContain('ACP 会话失败');
    expect(events[events.length - 1]).toEqual({ type: 'done', exitCode: 1 });
  });

  it('认证错但 agent 未声明 authMethods → 无自动认证，按普通协议错 fatal 上抛', async () => {
    const adapter = new AcpExternalAdapter(makeSpec());
    const events = await runScenario(adapter, { requireAuth: true });
    const err = events.find((e): e is Extract<ExternalEvent, { type: 'error' }> => e.type === 'error');
    expect(err?.fatal).toBe(true);
    expect(err?.message).toContain('-32000');
    expect(events.some((e) => e.type === 'auth_required')).toBe(false);
    expect(events[events.length - 1]).toEqual({ type: 'done', exitCode: 1 });
  });
});
