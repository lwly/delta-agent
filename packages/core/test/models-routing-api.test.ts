/**
 * F-42 模型路由 HTTP 端点契约测试（GET/PUT /api/models/routing）
 *
 * 复用 server.test.ts 的真服务基建（tmp SQLite + ProviderManager 注入临时 models.json），
 * 断言基准：docs/design-f41-f53-next-round.md F-42 节（D3：与 provider CRUD 同源校验，不旁路）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ChatMessage, ChatRequest, LLMProvider, StreamEvent, ToolCall } from '@delta/shared';
import { SessionService } from '../src/session/service.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ProviderManager } from '../src/llm/manager.js';
import { SessionHub, createWebServer } from '../src/server/index.js';
import type { SessionHubDeps } from '../src/server/hub.js';

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
void ({} as ToolCall); // 保持与 server.test.ts 同款 import 面（类型仅引用）

let tmp = '';
let modelsFile = '';
let server: ReturnType<typeof createWebServer>;
let base = '';

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-routing-'));
  await fs.writeFile(path.join(tmp, 'README.md'), '# demo 项目');
  const service = new SessionService(path.join(tmp, 'db.sqlite'));
  const projectId = service.ensureProject(tmp).id;
  service.createSession(projectId, { title: 't1' });
  const deps: SessionHubDeps = {
    service,
    registry: new ToolRegistry(),
    resolveProvider: async () => new MockProvider(),
  };
  const hub = new SessionHub(deps);
  modelsFile = path.join(tmp, 'models.json');
  server = createWebServer({ service, hub, port: 0, providers: new ProviderManager(modelsFile) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(tmp, { recursive: true, force: true });
});

const api = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
};

describe('GET /api/models/routing', () => {
  it('未配置时返回缺省关闭态 + KNOWN_TASK_KINDS', async () => {
    const { status, json } = await api('GET', '/api/models/routing');
    expect(status).toBe(200);
    expect((json.knownKinds as string[])).toEqual(
      expect.arrayContaining(['distill', 'classify', 'summarize', 'subagent']),
    );
    expect(json.routing).toEqual({ enabled: false, rules: {} });
  });
});

describe('PUT /api/models/routing', () => {
  it('保存规则并持久化到 models.json（新 ProviderManager 同文件可读回）', async () => {
    const put = await api('PUT', '/api/models/routing', {
      enabled: true,
      rules: {
        summarize: { model: 'small-model' },
        distill: { provider: 'gw', model: ' m2 ' },
      },
    });
    expect(put.status).toBe(200);
    expect(put.json.ok).toBe(true);
    // provider 空白归一：distill 保留 provider；model trim
    const routing = put.json.routing as { enabled: boolean; rules: Record<string, { provider?: string; model: string }> };
    expect(routing.enabled).toBe(true);
    expect(routing.rules.summarize).toEqual({ model: 'small-model' });
    expect(routing.rules.distill).toEqual({ provider: 'gw', model: 'm2' });

    // 落盘校验：同文件新开 ProviderManager 读回（CLI/Web 共用同一配置）
    const mgr2 = new ProviderManager(modelsFile);
    expect(mgr2.getRouting()?.enabled).toBe(true);
    expect(mgr2.getRouting()?.rules.summarize?.model).toBe('small-model');
  });

  it('rules 缺省沿用现值（仅切开关）；关闭后规则保留', async () => {
    await api('PUT', '/api/models/routing', {
      enabled: true,
      rules: { summarize: { model: 'small-model' } },
    });
    const off = await api('PUT', '/api/models/routing', { enabled: false });
    expect(off.status).toBe(200);
    const routing = off.json.routing as { enabled: boolean; rules: Record<string, unknown> };
    expect(routing.enabled).toBe(false);
    expect(routing.rules.summarize).toBeDefined();
  });

  it('启用但无任何有效规则 → 400（与 CLI routing-on 拒绝语义一致）', async () => {
    const { status, json } = await api('PUT', '/api/models/routing', { enabled: true, rules: {} });
    expect(status).toBe(400);
    expect(String(json.error)).toContain('至少一条规则');
  });

  it('空 model 规则被丢弃：全为空时启用 → 400；否则静默剔除', async () => {
    const bad = await api('PUT', '/api/models/routing', {
      enabled: true,
      rules: { summarize: { model: '   ' } },
    });
    expect(bad.status).toBe(400);

    const ok = await api('PUT', '/api/models/routing', {
      enabled: false,
      rules: { summarize: { model: '' }, distill: { model: 'm1' } },
    });
    expect(ok.status).toBe(200);
    const routing = ok.json.routing as { rules: Record<string, unknown> };
    expect(routing.rules.summarize).toBeUndefined();
    expect(routing.rules.distill).toBeDefined();
  });

  it('setRouting 非法规则（model 非字符串）→ 400（沿用既有校验文案）', async () => {
    const { status, json } = await api('PUT', '/api/models/routing', {
      enabled: true,
      rules: { summarize: { model: 123 as unknown as string } },
    });
    expect(status).toBe(400);
    expect(String(json.error)).toContain('model 不能为空');
  });

  it('与 provider CRUD 同文件共存不互踩（AC-42-3 口径）', async () => {
    await api('PUT', '/api/models/routing', {
      enabled: true,
      rules: { summarize: { model: 'small-model' } },
    });
    // 写 provider（同 models.json 文件）
    const prov = await api('PUT', '/api/providers/gw', { apiKey: 'sk-test', model: 'm1' });
    expect(prov.status).toBe(200);
    // routing 仍在
    const get = await api('GET', '/api/models/routing');
    const routing = get.json.routing as { enabled: boolean; rules: Record<string, { model: string }> };
    expect(routing.enabled).toBe(true);
    expect(routing.rules.summarize?.model).toBe('small-model');
  });
});
