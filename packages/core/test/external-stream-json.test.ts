/**
 * F-55 Tier B Claude stream-json 适配器单测（docs/design-f55-external-cli-agents.md §2/§6/§7）：
 *  - 全部走 spawnExternal + fake-claude.mjs fixture（stdout JSONL），零网络、零真实 CLI；
 *  - 场景经 FAKE_CLAUDE_SCRIPT env 注入 fixture（adapter 镜像为子进程 env，对齐 FAKE_ACP_SCRIPT 先例）；
 *  - spawn 参数断言经 fixture 的 stderr argv 透传 + adapter.stderrTail()（最简通道）；
 *  - fatal 判定归映射引擎（engine/external.ts），本层只透传退出码；total_cost_usd 一律忽略（§7 口径）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamJsonExternalAdapter } from '../src/external/stream-json.js';
import type { ExternalAgentSpec, ExternalEvent } from '../src/external/types.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');
const NODE = process.execPath;

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'yz-ext-claude-'));
});
afterEach(async () => {
  delete process.env.FAKE_CLAUDE_SCRIPT;
  await rm(tmp, { recursive: true, force: true });
});

function makeSpec(extra: Partial<ExternalAgentSpec> = {}): ExternalAgentSpec {
  return {
    id: 'cli:claude-code',
    kind: 'stream-json-jsonl',
    command: NODE,
    args: [FIXTURE],
    tier: 'B',
    version: 'fake',
    // fixture 无权限 flags 语义，三档全空（真实 claude 的 flags 由 detect 的 KNOWN_AGENTS 提供）
    permissionArgs: { plan: [], default: [], yolo: [] },
    ...extra,
  };
}

async function writeScenario(scenario: Record<string, unknown>): Promise<string> {
  const p = path.join(tmp, `scenario-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(p, JSON.stringify(scenario));
  return p;
}

/** 跑一轮会话并收集事件（done 即止） */
async function runScenario(
  adapter: StreamJsonExternalAdapter,
  scenario: Record<string, unknown>,
  opts: {
    prompt?: string;
    permissionMode?: 'plan' | 'default' | 'yolo';
    resumeSessionId?: string;
    mcpConfigPath?: string;
  } = {},
): Promise<ExternalEvent[]> {
  const scenarioPath = await writeScenario(scenario);
  process.env.FAKE_CLAUDE_SCRIPT = scenarioPath;
  const events: ExternalEvent[] = [];
  for await (const ev of adapter.run({
    prompt: opts.prompt ?? 'hi',
    cwd: tmp,
    permissionMode: opts.permissionMode ?? 'default',
    resumeSessionId: opts.resumeSessionId,
    mcpConfigPath: opts.mcpConfigPath,
    signal: new AbortController().signal,
  })) {
    events.push(ev);
    if (ev.type === 'done') break;
  }
  return events;
}

/** 从 stderr 环形缓冲里取 fixture 透传的 argv JSON（spawn 参数断言通道） */
function spawnedArgs(adapter: StreamJsonExternalAdapter): string[] {
  const line = adapter.stderrTail().find((l) => l.startsWith('[fake-claude] argv:'));
  if (!line) throw new Error(`fixture 未透传 argv（stderrTail=${JSON.stringify(adapter.stderrTail())}）`);
  return JSON.parse(line.slice('[fake-claude] argv:'.length)) as string[];
}

// ── 事件样例（claude 2.1.168 stream-json 实测形状） ─────────────────────────

const initEvent = {
  type: 'system',
  subtype: 'init',
  session_id: 'fake-claude-session-1',
  model: 'claude-fake',
  tools: [],
  mcp_servers: [],
};

const fullSessionLines = [
  { event: initEvent },
  {
    event: {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'let me look' },
          { type: 'text', text: 'hello world' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    },
  },
  {
    event: {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: 'file1\nfile2' },
        ],
      },
    },
  },
  {
    event: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      usage: { input_tokens: 120, output_tokens: 45 },
      total_cost_usd: 0.01,
    },
  },
];

describe('StreamJsonExternalAdapter（F-55 Tier B：claude stream-json JSONL）', () => {
  it('完整一轮：init → external_session；text/thinking/tool_use/tool_result → 对应事件；result → usage（无 costUsd）', async () => {
    const adapter = new StreamJsonExternalAdapter(makeSpec());
    const events = await runScenario(adapter, { lines: fullSessionLines });
    expect(events).toEqual([
      { type: 'external_session', id: 'fake-claude-session-1' },
      { type: 'thinking', text: 'let me look' },
      { type: 'text', text: 'hello world' },
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', argsJson: '{"command":"ls"}' },
      { type: 'tool_result', id: 'toolu_1', ok: true, content: 'file1\nfile2' },
      { type: 'usage', input: 120, output: 45 },
      { type: 'done', exitCode: 0 },
    ]);
    // §7 口径：usage 事件只有 input/output，total_cost_usd 不产生任何 cost 字段
    const usage = events.find((e): e is Extract<ExternalEvent, { type: 'usage' }> => e.type === 'usage');
    expect(Object.keys(usage ?? {}).sort()).toEqual(['input', 'output', 'type']);
  });

  it('tool_result content 为块数组：text 块拼接，其他类型 JSON 序列化占位', async () => {
    const adapter = new StreamJsonExternalAdapter(makeSpec());
    const events = await runScenario(adapter, {
      lines: [
        { event: initEvent },
        {
          event: {
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'toolu_2',
                  is_error: false,
                  content: [
                    { type: 'text', text: 'part-a' },
                    { type: 'image', data: 'base64xxx' },
                    { type: 'text', text: 'part-b' },
                  ],
                },
              ],
            },
          },
        },
        { event: { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } } },
      ],
    });
    expect(events).toContainEqual({
      type: 'tool_result',
      id: 'toolu_2',
      ok: true,
      content: 'part-a\n{"type":"image","data":"base64xxx"}\npart-b',
    });
  });

  it('is_error=true 的 tool_result → ok:false；result.is_error=true → error fatal:false（usage 照常产出）', async () => {
    const adapter = new StreamJsonExternalAdapter(makeSpec());
    const events = await runScenario(adapter, {
      lines: [
        { event: initEvent },
        {
          event: {
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: 'toolu_3', is_error: true, content: 'boom' }],
            },
          },
        },
        {
          event: {
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            usage: { input_tokens: 7, output_tokens: 3 },
          },
        },
      ],
    });
    expect(events).toContainEqual({ type: 'tool_result', id: 'toolu_3', ok: false, content: 'boom' });
    expect(events).toContainEqual({ type: 'usage', input: 7, output: 3 });
    const err = events.find((e): e is Extract<ExternalEvent, { type: 'error' }> => e.type === 'error');
    expect(err?.fatal).toBe(false);
  });

  it('未知 type 与未知块类型忽略；非法 JSON 行 → error fatal:false 且继续消费后续行', async () => {
    const adapter = new StreamJsonExternalAdapter(makeSpec());
    const events = await runScenario(adapter, {
      lines: [
        { event: initEvent },
        { event: { type: 'stream_event', subtype: 'whatever' } }, // 未知顶层 type：忽略
        {
          event: {
            type: 'assistant',
            message: { content: [{ type: 'server_tool_use', id: 'x' }, { type: 'text', text: 'after-unknown' }] },
          },
        },
        { raw: '<<<not json>>>' }, // 非法行：error 不致命
        { event: { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 2, output_tokens: 2 } } },
      ],
    });
    expect(events).toEqual([
      { type: 'external_session', id: 'fake-claude-session-1' },
      { type: 'text', text: 'after-unknown' },
      { type: 'error', message: expect.stringContaining('<<<not json>>>'), fatal: false },
      { type: 'usage', input: 2, output: 2 },
      { type: 'done', exitCode: 0 },
    ]);
  });

  it('exit 3 无产出 → 仅 done exitCode 3（fatal 判定归映射引擎，本层不造 error）', async () => {
    const adapter = new StreamJsonExternalAdapter(makeSpec());
    const events = await runScenario(adapter, { lines: [], exitCode: 3 });
    expect(events).toEqual([{ type: 'done', exitCode: 3 }]);
  });

  it('spawn 参数：-p <prompt> + --output-format stream-json 恒在；mcpConfigPath → --mcp-config <path>；resumeSessionId → --resume <id>', async () => {
    const adapter = new StreamJsonExternalAdapter(
      makeSpec({
        mcpArgs: (configPath) => ['--mcp-config', configPath],
        resumeArgs: (sessionId) => ['--resume', sessionId],
      }),
    );
    await runScenario(
      adapter,
      { lines: [{ event: initEvent }] },
      {
        prompt: 'do things',
        mcpConfigPath: '/tmp/delta-mcp-s1.json',
        resumeSessionId: 'sess-9',
      },
    );
    const args = spawnedArgs(adapter);
    expect(args).toEqual([
      '-p',
      'do things',
      '--output-format',
      'stream-json',
      '--mcp-config',
      '/tmp/delta-mcp-s1.json',
      '--resume',
      'sess-9',
    ]);
  });

  it('mcpConfigPath 缺省或 spec 无 mcpArgs 时不追加 --mcp-config（scripted/无透传场景零影响）', async () => {
    const withMcpArgs = new StreamJsonExternalAdapter(makeSpec({ mcpArgs: (p) => ['--mcp-config', p] }));
    await runScenario(withMcpArgs, { lines: [{ event: initEvent }] });
    expect(spawnedArgs(withMcpArgs)).not.toContain('--mcp-config');

    const withoutMcpArgs = new StreamJsonExternalAdapter(makeSpec());
    await runScenario(withoutMcpArgs, { lines: [{ event: initEvent }] }, { mcpConfigPath: '/tmp/x.json' });
    expect(spawnedArgs(withoutMcpArgs)).not.toContain('--mcp-config');
  });

  it('权限档位 → permissionArgs 追加（plan 档 flags 原样透传）', async () => {
    const adapter = new StreamJsonExternalAdapter(
      makeSpec({ permissionArgs: { plan: ['--permission-mode', 'plan'], default: [], yolo: ['--dangerously-skip-permissions'] } }),
    );
    await runScenario(adapter, { lines: [] }, { permissionMode: 'plan' });
    expect(spawnedArgs(adapter)).toEqual(['-p', 'hi', '--output-format', 'stream-json', '--permission-mode', 'plan']);
  });
});
