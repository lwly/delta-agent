import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentEvent, ChatMessage, ChatRequest, LLMProvider, StreamEvent, ToolCall, ConfirmDecision } from '@delta/shared';
import { SessionService } from '../src/session/service.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ProviderManager } from '../src/llm/manager.js';
import { SessionHub, createWebServer } from '../src/server/index.js';
import type { SessionHubDeps } from '../src/server/hub.js';

/** Scripted mock provider（与 react.test 同思路；delayMs 模拟慢响应） */
class MockProvider implements LLMProvider {
  readonly id = 'mock';
  constructor(
    private script: Array<{ text?: string; toolCalls?: ToolCall[] }>,
    private delayMs = 0,
  ) {}
  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const next = this.script.shift();
    if (!next) {
      yield { type: 'error', message: 'mock exhausted', retriable: false };
      return;
    }
    if (next.text) {
      for (const chunk of next.text.match(/.{1,4}/gs) ?? []) {
        yield { type: 'text_delta', text: chunk };
      }
    }
    for (const [i, c] of (next.toolCalls ?? []).entries()) {
      yield { type: 'tool_call_delta', index: i, id: c.id, name: c.name, argsDelta: c.argsJson };
    }
    yield { type: 'usage', input: 20, output: 8 };
    yield { type: 'done' };
  }
  estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((n, m) => n + m.content.length, 0);
  }
}

let tmp = '';
let service: SessionService;
let projectId: string;
let sessionId: string;
let server: ReturnType<typeof createWebServer>;
let base = '';
let provider: MockProvider;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-web-'));
  // 项目根带 README，供 prompt 组装读取
  await fs.writeFile(path.join(tmp, 'README.md'), '# demo 项目');
  service = new SessionService(path.join(tmp, 'db.sqlite'));
  projectId = service.ensureProject(tmp).id;
  sessionId = service.createSession(projectId, { title: 't1' }).id;
  provider = new MockProvider([]);
  const deps: SessionHubDeps = {
    service,
    registry: new ToolRegistry(),
    resolveProvider: async () => provider,
  };
  const hub = new SessionHub(deps);
  server = createWebServer({ service, hub, port: 0, providers: new ProviderManager(path.join(tmp, 'models.json')) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
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

/** 收集 SSE 直到谓词满足或超时 */
async function collectSse(p: string, stop: (ev: Record<string, unknown>) => boolean, timeoutMs = 3000): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  const ctrl = new AbortController();
  const res = await fetch(`${base}${p}`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const ev = JSON.parse(line.slice(6)) as Record<string, unknown>;
        events.push(ev);
        if (stop(ev)) {
          ctrl.abort();
          return events;
        }
      }
    }
  } catch {
    // aborted → 返回已收集事件
  } finally {
    clearTimeout(timer);
  }
  return events;
}

afterEach(async () => {
  server.close();
  service.close();
});

describe('projects / sessions REST', () => {
  it('GET /api/projects 列表含会话计数', async () => {
    const r = await api('GET', '/api/projects');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject([expect.objectContaining({ id: projectId, session_count: 1 })]);
  });

  it('POST /api/projects 注册新项目', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-proj-'));
    const r = await api('POST', '/api/projects', { root: dir });
    expect(r.json).toMatchObject({ name: path.basename(dir) });
  });

  it('会话 CRUD：创建/详情/重命名/删除进回收站', async () => {
    const created = await api('POST', `/api/projects/${projectId}/sessions`, { title: 'web 会话' });
    const sid = (created.json as { id: string }).id;

    const detail = await api('GET', `/api/sessions/${sid}`);
    expect((detail.json as { session: { title: string } }).session.title).toBe('web 会话');

    await api('PATCH', `/api/sessions/${sid}`, { title: '改名' });
    const after = await api('GET', `/api/sessions/${sid}`);
    expect((after.json as { session: { title: string } }).session.title).toBe('改名');

    await api('DELETE', `/api/sessions/${sid}`);
    expect(await api('GET', `/api/trash`)).toMatchObject({
      json: [expect.objectContaining({ kind: 'session', id: sid })],
    } as never);

    await api('POST', `/api/trash/restore/session/${sid}`);
    expect((await api('GET', `/api/sessions/${sid}`)).status).toBe(200);
  });

  it('项目移除需 confirmName 完全一致', async () => {
    const r1 = await api('DELETE', `/api/projects/${projectId}`, { confirmName: 'wrong' });
    expect(r1.status).toBe(400);
    const r2 = await api('DELETE', `/api/projects/${projectId}`, { confirmName: path.basename(tmp) });
    expect(r2.status).toBe(200);
  });
});

describe('对话运行（SSE 桥）', () => {
  it('send → SSE 收到 text_delta 与 done；消息落库', async () => {
    provider.script.push({ text: '最终答案AB' });
    const ssePromise = collectSse(`/api/sessions/${sessionId}/events`, (ev) => ev.type === 'done');

    const kicked = await api('POST', `/api/sessions/${sessionId}/messages`, { input: '你好' });
    expect(kicked.status).toBe(202);

    const events = await ssePromise;
    const types = events.map((e) => e.type);
    expect(types).toContain('text_delta');
    expect(types).toContain('done');
    expect(types[0]).toBe('state'); // 订阅时立即收到 state

    // 落库校验
    const detail = (await api('GET', `/api/sessions/${sessionId}`)).json as { messages: ChatMessage[] };
    const roles = detail.messages.map((m) => m.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
    const assistant = detail.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.content).toBe('最终答案AB');
  });

  it('运行中重复发起返回 409', async () => {
    provider.script.push({ text: '慢响应' });
    provider.delayMs = 300;
    void api('POST', `/api/sessions/${sessionId}/messages`, { input: 'first' });
    await new Promise((r) => setTimeout(r, 50));
    const second = await api('POST', `/api/sessions/${sessionId}/messages`, { input: 'second' });
    expect(second.status).toBe(409);
    await api('POST', `/api/sessions/${sessionId}/abort`);
  });

  it('高危工具触发 confirm_request，决策回填后继续执行', async () => {
    provider.script.push({
      toolCalls: [{ id: 'c1', name: 'write_file', argsJson: JSON.stringify({ path: 'out.txt', content: 'hi' }) }],
    });
    provider.script.push({ text: '写入完成' });

    const ssePromise = collectSse(`/api/sessions/${sessionId}/events`, (ev) => {
      if (ev.type === 'confirm_request') {
        // 收到确认请求 → 回填 allow
        void api('POST', `/api/sessions/${sessionId}/confirm`, {
          requestId: (ev.request as { id: string }).id,
          decision: { kind: 'allow' },
        });
      }
      return ev.type === 'done';
    }, 5000);

    await api('POST', `/api/sessions/${sessionId}/messages`, { input: '写个文件' });
    const events = await ssePromise;
    expect(events.some((e) => e.type === 'confirm_request')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    // 文件确实写出（工具真执行了）
    expect(await fs.readFile(path.join(tmp, 'out.txt'), 'utf-8')).toBe('hi');
  });

  it('abort 中止运行（state → false）', async () => {
    provider.script.push({ text: 'x'.repeat(400) });
    provider.delayMs = 300;
    await api('POST', `/api/sessions/${sessionId}/messages`, { input: 'go' });
    await new Promise((r) => setTimeout(r, 50));
    const r = await api('POST', `/api/sessions/${sessionId}/abort`);
    expect(r.json).toMatchObject({ ok: true });
  });
});

describe('search 端点', () => {
  it('GET /api/search?q= 命中标题与内容', async () => {
    service.appendMessage(sessionId, { role: 'user', content: '关于 WebSocket 重连的讨论' });
    const r = await api('GET', `/api/search?q=WebSocket`);
    expect((r.json as Array<{ id: string }>).map((x) => x.id)).toContain(sessionId);
  });
});

describe('providers 端点（设置中心）', () => {
  it('CRUD + 启停/默认/排序；Key 不回显（仅掩码）', async () => {
    const added = await api('PUT', '/api/providers/deepseek', { apiKey: 'sk-test-1234567890', model: 'deepseek-chat' });
    expect(added.status).toBe(200);

    const list = (await api('GET', '/api/providers')).json as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'deepseek', enabled: true, default: false });
    expect(String(list[0]!.keyMasked)).not.toContain('sk-test-1234567890');

    await api('POST', '/api/providers/deepseek/default');
    expect(((await api('GET', '/api/providers')).json as Array<Record<string, unknown>>)[0]!.default).toBe(true);

    await api('POST', '/api/providers/deepseek/enable', { enabled: false });
    expect(((await api('GET', '/api/providers')).json as Array<Record<string, unknown>>)[0]!.enabled).toBe(false);

    await api('DELETE', '/api/providers/deepseek');
    expect(((await api('GET', '/api/providers')).json as unknown[])).toHaveLength(0);
  });

  it('空 apiKey 被拒绝', async () => {
    const r = await api('PUT', '/api/providers/foo', { apiKey: '' });
    expect(r.status).toBe(400);
  });
});

describe('providers 表单态端点（POST /api/providers/test 与 /models）', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('探测连通与拉取模型均不落盘', async () => {
    const realFetch = globalThis.fetch;
    const upstream = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/models')) {
        expect((init!.headers as Record<string, string>).authorization).toBe('Bearer sk-form');
        return new Response(JSON.stringify({ data: [{ id: 'm2' }, { id: 'm1' }] }), { status: 200 });
      }
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    // 只拦截发往 mock 网关的请求，测试服务器自身请求走真实 fetch
    vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) =>
      String(url).includes('gw.example.com')
        ? upstream(url, init)
        : realFetch(url as Parameters<typeof realFetch>[0], init as Parameters<typeof realFetch>[1]),
    );

    const models = await api('POST', '/api/providers/models', { id: 'gw-x', apiKey: 'sk-form', baseUrl: 'https://gw.example.com/v1' });
    expect(models.json).toMatchObject({ ok: true, models: ['m1', 'm2'] });

    const probe = await api('POST', '/api/providers/test', { id: 'gw-x', apiKey: 'sk-form', baseUrl: 'https://gw.example.com/v1' });
    expect(probe.json).toMatchObject({ ok: true });

    // 表单态不落盘
    expect(((await api('GET', '/api/providers')).json as unknown[])).toHaveLength(0);
  });
});

describe('回收站批量彻底删除（POST /api/trash/purge-batch）', () => {
  it('批量清除：混合 project+session，返回 purged 与空 failed', async () => {
    const created = await api('POST', `/api/projects/${projectId}/sessions`, { title: 'b1' });
    const sid = (created.json as { id: string }).id;
    await api('DELETE', `/api/sessions/${sid}`);
    await api('DELETE', `/api/projects/${projectId}`, { confirmName: path.basename(tmp) });

    const r = await api('POST', '/api/trash/purge-batch', {
      items: [
        { kind: 'project', id: projectId },
        { kind: 'session', id: sid },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, purged: 2, failed: [] });
    expect(await api('GET', '/api/trash')).toMatchObject({ json: [] } as never);
  });

  it('部分失败：不存在的条目计入 failed，其余照常清除，仍返回 200', async () => {
    const created = await api('POST', `/api/projects/${projectId}/sessions`, { title: 'b2' });
    const sid = (created.json as { id: string }).id;
    await api('DELETE', `/api/sessions/${sid}`);

    const r = await api('POST', '/api/trash/purge-batch', {
      items: [
        { kind: 'session', id: sid },
        { kind: 'session', id: 'no-such-id' },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, purged: 1 });
    expect((r.json.failed as unknown[])[0]).toMatchObject({ kind: 'session', id: 'no-such-id' });
  });

  it('items 为空或含非对象条目 → 400', async () => {
    expect((await api('POST', '/api/trash/purge-batch', { items: [] })).status).toBe(400);
    expect((await api('POST', '/api/trash/purge-batch', {})).status).toBe(400);
    expect(
      (await api('POST', '/api/trash/purge-batch', { items: [{ kind: 'session' }] })).status,
    ).toBe(400);
    expect(
      (await api('POST', '/api/trash/purge-batch', { items: [{ kind: 'folder', id: 'x' }] })).status,
    ).toBe(400); // 非法 kind 值同样拒绝
  });
});

// ── settings/budget（会话预算设置端点）───────────────────────────────────────

describe('settings/budget 端点', () => {
  it('GET 返回默认；PUT 校验并持久化（configHomeDir 隔离）；非法值 400', async () => {
    const home2 = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-budget-'));
    const hub2 = new SessionHub({ service, registry: new ToolRegistry(), resolveProvider: async () => provider });
    const srv2 = createWebServer({
      service,
      hub: hub2,
      port: 0,
      providers: new ProviderManager(path.join(tmp, 'm2.json')),
      configHomeDir: home2,
    });
    await new Promise<void>((r) => srv2.listen(0, '127.0.0.1', r));
    const addr = srv2.address();
    const base2 = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const call = async (method: string, p: string, body?: unknown) => {
      const res = await fetch(`${base2}${p}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    };
    try {
      // 未设置 → 空 + defaults
      const g1 = await call('GET', '/api/settings/budget');
      expect(g1.status).toBe(200);
      expect(g1.json.defaults).toMatchObject({ maxTokens: 200_000, maxCostUsd: 0.7 });
      // 写入（camelCase）+ 读回
      const p1 = await call('PUT', '/api/settings/budget', { maxTokens: 1_000_000, maxCostUsd: 2.5 });
      expect(p1.status).toBe(200);
      expect(p1.json).toMatchObject({ ok: true, maxTokens: 1_000_000, maxCostUsd: 2.5 });
      const g2 = await call('GET', '/api/settings/budget');
      expect(g2.json.maxTokens).toBe(1_000_000);
      // snake_case 双读 + null 清除
      const p2 = await call('PUT', '/api/settings/budget', { max_tokens: null });
      expect(p2.status).toBe(200);
      const g3 = await call('GET', '/api/settings/budget');
      expect(g3.json.maxTokens).toBeUndefined();
      expect(g3.json.maxCostUsd).toBe(2.5);
      // 非法值 → 400
      const bad = await call('PUT', '/api/settings/budget', { maxTokens: -5 });
      expect(bad.status).toBe(400);
    } finally {
      srv2.close();
      await fs.rm(home2, { recursive: true, force: true });
    }
  });
});
