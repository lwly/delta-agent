/**
 * F-46 会话分叉（copy-on-write）核心逻辑 + HTTP 端点契约测试。
 * 断言基准：docs/prd-f41-f53-next-round.md F-46 节（AC-46-1～5）。
 * 服务层用例走真 SQLite（tmp）；端点用例沿用 server.test.ts 基建。
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

class MockProvider implements LLMProvider {
  readonly id = 'mock';
  async *chat(_req: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: 'text_delta', text: 'E2E_FAKE_DONE：重跑完成。' };
    yield { type: 'usage', input: 10, output: 2 };
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

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-fork-'));
  await fs.writeFile(path.join(tmp, 'README.md'), '# fork demo');
  service = new SessionService(path.join(tmp, 'db.sqlite'));
  projectId = service.ensureProject(tmp).id;
  sessionId = service.createSession(projectId, { title: '源会话', mode: 'react', model: 'm-1' }).id;
  // 历史骨架：u1 a1 u2 a2 u3（fork 点落在 user 消息上）
  service.appendMessage(sessionId, { role: 'user', content: 'u1' });
  service.appendMessage(sessionId, { role: 'assistant', content: 'a1' });
  service.appendMessage(sessionId, { role: 'user', content: 'u2' });
  service.appendMessage(sessionId, { role: 'assistant', content: 'a2' });
  service.appendMessage(sessionId, { role: 'user', content: 'u3' });
});

afterEach(async () => {
  service.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('SessionService.forkSession（AC-46-1 copy-on-write）', () => {
  it('复制 [0, afterIndex) 前缀；原会话只读不动', () => {
    // 分叉点 = index 4（u3）→ 前缀 u1 a1 u2 a2
    const forked = service.forkSession(sessionId, 4);
    expect(forked.id).not.toBe(sessionId);
    const forkedHistory = service.getHistory(forked.id).map((m) => m.content);
    expect(forkedHistory).toEqual(['u1', 'a1', 'u2', 'a2']);
    // 原会话不动
    expect(service.getHistory(sessionId).map((m) => m.content)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3']);
    // 标题带分叉标注（侧栏「来自」语义）
    expect(forked.title).toBe('源会话 · 分叉');
    // 模式/模型继承
    expect(forked.mode).toBe('react');
    expect(forked.model).toBe('m-1');
  });

  it('删除原会话不影响分叉副本（独立消息行，AC-46-4）', () => {
    const forked = service.forkSession(sessionId, 4);
    service.removeSession(sessionId);
    expect(service.getSession(sessionId)).toBeUndefined();
    expect(service.getHistory(forked.id).map((m) => m.content)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('分叉点非 user 消息 → 报错；越界 → 报错（AC-46-2 边界）', () => {
    // index 3 = assistant a2
    expect(() => service.forkSession(sessionId, 3)).toThrow(/user 消息/);
    expect(() => service.forkSession(sessionId, 99)).toThrow(/越界/);
    expect(() => service.forkSession('no-such-session', 1)).toThrow(/not found/);
    // 失败用例不产生任何新会话
    expect(service.listSessions(projectId)).toHaveLength(1);
  });

  it('编辑重发：分叉后以编辑内容作为新会话输入（hub.send 落库验证）', async () => {
    const hub = new SessionHub({
      service,
      registry: new ToolRegistry(),
      resolveProvider: async () => new MockProvider(),
    } as SessionHubDeps);
    const forked = service.forkSession(sessionId, 4);
    // 与端点 run:true 同链路：以编辑内容触发重跑
    await hub.send(forked.id, 'u2-编辑版');
    const history = service.getHistory(forked.id).map((m) => m.content);
    expect(history[history.length - 2]).toBe('u2-编辑版'); // 新输入
    expect(history[history.length - 1]).toContain('E2E_FAKE_DONE'); // 重跑完成
    // 源会话零变化
    expect(service.getHistory(sessionId).map((m) => m.content)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3']);
  });
});

// ── HTTP 端点契约 ────────────────────────────────────────────────────────────

describe('POST /api/sessions/:id/fork', () => {
  let server: ReturnType<typeof createWebServer>;
  let base = '';

  beforeEach(async () => {
    const hub = new SessionHub({
      service,
      registry: new ToolRegistry(),
      resolveProvider: async () => new MockProvider(),
    } as SessionHubDeps);
    server = createWebServer({ service, hub, port: 0 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const api = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };

  it('run=false：仅分叉不重跑，返回新 session_id', async () => {
    const { status, json } = await api('POST', `/api/sessions/${sessionId}/fork`, { after_index: 4, run: false });
    expect(status).toBe(200);
    expect(json.run).toBe(false);
    const forkedId = json.session_id as string;
    expect(service.getHistory(forkedId).map((m) => m.content)).toEqual(['u1', 'a1', 'u2', 'a2']);
    // 不重跑：新会话仍是 4 条（无新输入/回复）
    expect(service.getHistory(forkedId)).toHaveLength(4);
  });

  it('run=true（缺省）：自动重跑，新会话出现 assistant 回复', async () => {
    const { status, json } = await api('POST', `/api/sessions/${sessionId}/fork`, { after_index: 4 });
    expect(status).toBe(200);
    expect(json.run).toBe(true);
    const forkedId = json.session_id as string;
    // 轮询等重跑落库（异步 fire-and-forget）
    for (let i = 0; i < 40; i++) {
      const h = service.getHistory(forkedId);
      if (h.some((m) => m.role === 'assistant' && m.content.includes('E2E_FAKE_DONE'))) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const history = service.getHistory(forkedId).map((m) => m.content);
    expect(history).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'E2E_FAKE_DONE：重跑完成。']);
    // content 覆盖：编辑内容替代原消息文本
    const { json: j2 } = await api('POST', `/api/sessions/${sessionId}/fork`, {
      after_index: 4,
      content: 'u3-编辑版',
    });
    const h2 = service.getHistory(j2.session_id as string);
    expect(h2[h2.length - 1]!.content).toBe('u3-编辑版');
  });

  it('非法分叉点 → 400（含错误文案透传）', async () => {
    const bad1 = await api('POST', `/api/sessions/${sessionId}/fork`, { after_index: 3 });
    expect(bad1.status).toBe(400);
    expect(String(bad1.json.error)).toContain('user 消息');
    const bad2 = await api('POST', `/api/sessions/${sessionId}/fork`, { after_index: -1 });
    expect(bad2.status).toBe(400);
  });
});
