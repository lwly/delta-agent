/**
 * F-55 外部 Agent HTTP 端点契约测试（GET /api/external-agents）
 *
 * 复用 models-routing-api.test.ts 的真服务基建（tmp SQLite + 注入 externalDetect）：
 * 真探测会跑 `--version` 子进程并写 ~/.delta/external.json，单测注入隔离
 * （ServeOptions.externalDetect），断言基准：docs/design-f55-external-cli-agents.md §10 + AC-55-7
 * （探测失败静默空态，不弹错误）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ChatMessage, ChatRequest, LLMProvider, StreamEvent } from '@delta/shared';
import { SessionService } from '../src/session/service.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { SessionHub, createWebServer } from '../src/server/index.js';
import type { SessionHubDeps } from '../src/server/hub.js';
import type { DetectedAgent, KnownAgentDef } from '../src/external/detect.js';

class MockProvider implements LLMProvider {
  readonly id = 'mock';
  async *chat(_req: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: 'text_delta', text: 'ok' };
    yield { type: 'usage', input: 1, output: 1 };
    yield { type: 'done' };
  }
  estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((n, m) => n + m.content.length, 0);
  }
}

/** 构造一条 Claude Code 形状的探测产出（loginStateFiles 指向不存在的文件 → loginState 可确定性断言 false） */
function fakeDetected(): DetectedAgent {
  const def: KnownAgentDef = {
    id: 'cli:claude-code',
    kind: 'stream-json-jsonl',
    tier: 'B',
    executable: 'claude',
    probeArgs: ['--version'],
    loginStateFiles: ['__delta_f55_test_no_such_file__'],
    permissionArgs: {
      plan: ['--permission-mode', 'plan'],
      default: [],
      yolo: ['--dangerously-skip-permissions'],
    },
    resumeArgs: (sessionId) => ['--resume', sessionId],
    mcpArgs: (configPath) => ['--mcp-config', configPath],
  };
  return { def, command: '/usr/local/bin/claude', version: '2.1.168', source: 'path' };
}

let tmp = '';
let server: ReturnType<typeof createWebServer>;
let base = '';

/** 启动服务并注入探测器（每用例独立启动，探测副作用不触碰真实 HOME/PATH） */
async function startServer(detector: () => Promise<DetectedAgent[]>): Promise<void> {
  const service = new SessionService(path.join(tmp, 'db.sqlite'));
  const deps: SessionHubDeps = {
    service,
    registry: new ToolRegistry(),
    resolveProvider: async () => new MockProvider(),
  };
  const hub = new SessionHub(deps);
  server = createWebServer({ service, hub, port: 0, externalDetect: detector });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-external-agents-'));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(tmp, { recursive: true, force: true });
});

const api = async (p: string) => {
  const res = await fetch(`${base}${p}`);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
};

describe('GET /api/external-agents', () => {
  it('探测命中 → agents 数组字段齐全（id/command/version/source/tier/登录态/三档支持度）', async () => {
    await startServer(async () => [fakeDetected()]);
    const { status, json } = await api('/api/external-agents');
    expect(status).toBe(200);
    const agents = json.agents as Array<Record<string, unknown>>;
    expect(Array.isArray(agents)).toBe(true);
    expect(agents).toHaveLength(1);
    const a = agents[0]!;
    expect(a.id).toBe('cli:claude-code');
    expect(a.command).toBe('/usr/local/bin/claude');
    expect(a.version).toBe('2.1.168');
    expect(a.source).toBe('path');
    expect(a.tier).toBe('B');
    // loginStateFiles 指向不存在文件 → false（确定性断言，不触碰真实 HOME）
    expect(a.loginState).toBe(false);
    // permissionArgs.plan / yolo 非空 → true
    expect(a.planSupported).toBe(true);
    expect(a.yoloSupported).toBe(true);
  });

  it('plan 档空数组（Codex 形状）→ planSupported false', async () => {
    const d = fakeDetected();
    d.def = { ...d.def, id: 'cli:codex', tier: 'C', permissionArgs: { plan: [], default: [], yolo: ['--yolo'] } };
    await startServer(async () => [d]);
    const { status, json } = await api('/api/external-agents');
    expect(status).toBe(200);
    const agents = json.agents as Array<Record<string, unknown>>;
    expect(agents[0]!.planSupported).toBe(false);
    expect(agents[0]!.yoloSupported).toBe(true);
  });

  it('空探测 → agents: []（200 空态，不弹错误）', async () => {
    await startServer(async () => []);
    const { status, json } = await api('/api/external-agents');
    expect(status).toBe(200);
    expect(json.agents).toEqual([]);
  });

  it('探测抛错 → 静默降级 agents: []（AC-55-7：不弹错误）', async () => {
    await startServer(async () => {
      throw new Error('probe exploded');
    });
    const { status, json } = await api('/api/external-agents');
    expect(status).toBe(200);
    expect(json.agents).toEqual([]);
  });
});
