/** F-53 消息/会话分页端点测试（AC-53-2 / AC-53-3 / AC-53-4） */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ChatMessage } from '@delta/shared';
import { SessionService } from '../src/session/service.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { SessionHub, createWebServer } from '../src/server/index.js';
import type { SessionHubDeps } from '../src/server/hub.js';

let tmp = '';
let projectId = '';
let service: SessionService;
let server: ReturnType<typeof createWebServer>;
let base = '';
let sessionId = '';

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-msg-page-'));
  service = new SessionService(path.join(tmp, 'db.sqlite'));
  projectId = service.ensureProject(tmp).id;
  const s = service.createSession(projectId, { title: 'page-test' });
  sessionId = s.id;
  const deps: SessionHubDeps = {
    service,
    registry: new ToolRegistry(),
    resolveProvider: async () => {
      throw new Error('not used');
    },
  };
  const hub = new SessionHub(deps);
  server = createWebServer({ service, hub, port: 0, skillsHomeDir: tmp, configHomeDir: tmp });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(tmp, { recursive: true, force: true });
});

const api = async (method: string, p: string) => {
  const res = await fetch(`${base}${p}`, { method });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
};

/** 落库 N 条 user 消息（内容含序号便于断言） */
function seedMessages(n: number): void {
  for (let i = 1; i <= n; i++) {
    const m: ChatMessage = { role: 'user', content: `msg-${i}` };
    service.appendMessage(sessionId, m);
  }
}

describe('GET /api/sessions/:id/messages（F-53 游标分页）', () => {
  it('首屏（无参数）只返回最近一屏，升序 + has_more + next_before', async () => {
    seedMessages(120);
    const { status, json } = await api('GET', `/api/sessions/${sessionId}/messages?limit=50`);
    expect(status).toBe(200);
    const msgs = json.messages as Array<{ seq: number; message: ChatMessage }>;
    expect(msgs).toHaveLength(50);
    expect(msgs[0]!.message.content).toBe('msg-71'); // 最近 50 条的起点
    expect(msgs[49]!.message.content).toBe('msg-120');
    expect(json.has_more).toBe(true);
    expect(json.next_before).toBe(msgs[0]!.seq);
  });

  it('before 向上翻页：返回紧邻上一页', async () => {
    seedMessages(120);
    const first = (await api('GET', `/api/sessions/${sessionId}/messages?limit=50`)).json as unknown as {
      messages: Array<{ seq: number; message: ChatMessage }>;
      next_before: number;
    };
    const { status, json } = await api('GET', `/api/sessions/${sessionId}/messages?limit=50&before=${first.next_before}`);
    expect(status).toBe(200);
    const msgs = json.messages as Array<{ seq: number; message: ChatMessage }>;
    expect(msgs).toHaveLength(50);
    expect(msgs[0]!.message.content).toBe('msg-21');
    expect(msgs[49]!.message.content).toBe('msg-70');
    expect(json.has_more).toBe(true);
  });

  it('after 增量拉取：只返回游标之后的消息（done 校准口径）', async () => {
    seedMessages(60);
    const first = (await api('GET', `/api/sessions/${sessionId}/messages?limit=50`)).json as unknown as {
      messages: Array<{ seq: number; message: ChatMessage }>;
    };
    const lastSeq = first.messages[first.messages.length - 1]!.seq;
    service.appendMessage(sessionId, { role: 'user', content: 'msg-61' });
    const { status, json } = await api('GET', `/api/sessions/${sessionId}/messages?after=${lastSeq}`);
    expect(status).toBe(200);
    const msgs = json.messages as Array<{ seq: number; message: ChatMessage }>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.message.content).toBe('msg-61');
    expect(msgs[0]!.seq).toBe(lastSeq + 1);
  });

  it('limit 边界：钳制到 1..500；404 会话不存在', async () => {
    seedMessages(3);
    const few = await api('GET', `/api/sessions/${sessionId}/messages?limit=2`);
    expect((few.json.messages as unknown[]).length).toBe(2);
    const { status } = await api('GET', `/api/sessions/nope/messages?limit=10`);
    expect(status).toBe(404);
  });

  it('tool 大输出摘要化：content 截断 + contentTruncated 标记；全文按 seq 懒加载', async () => {
    const big = 'x'.repeat(6000);
    service.appendMessage(sessionId, { role: 'assistant', content: 'run', toolCalls: [{ id: 'call-1', name: 'run_command', argsJson: '{}' }] });
    service.appendMessage(sessionId, { role: 'tool', content: big, toolCallId: 'call-1' });
    const page = (await api('GET', `/api/sessions/${sessionId}/messages?limit=10`)).json as unknown as {
      messages: Array<{ seq: number; message: ChatMessage }>;
    };
    const tool = page.messages.find((m) => m.message.role === 'tool')!;
    expect(tool.message.content.length).toBeLessThan(2000);
    expect(tool.message.contentTruncated).toBe(true);
    expect(tool.message.contentLength).toBe(6000);
    // 小输出不摘要化
    const normal = page.messages.find((m) => m.message.role === 'assistant')!;
    expect(normal.message.contentTruncated).toBeUndefined();
    // 懒加载端点返回全文
    const full = await api('GET', `/api/sessions/${sessionId}/messages/${tool.seq}/content`);
    expect(full.status).toBe(200);
    expect((full.json.message as ChatMessage).content).toBe(big);
  });

  it('懒加载端点：seq 非法 400 / 不存在 404', async () => {
    seedMessages(2);
    const bad = await api('GET', `/api/sessions/${sessionId}/messages/abc/content`);
    expect(bad.status).toBe(400);
    const missing = await api('GET', `/api/sessions/${sessionId}/messages/999/content`);
    expect(missing.status).toBe(404);
  });
});

describe('GET /api/projects/:id/sessions?limit=（F-53 会话分页）', () => {
  it('limit 模式返回分页结构；不带 limit 保持全量数组', async () => {
    for (let i = 0; i < 7; i++) {
      const s = service.createSession(projectId, { title: `s-${i}` });
      // 同毫秒并列由复合游标（updated_at|id）兜底，不丢页
      service.renameSession(s.id, `s-${i}`);
    }
    const all = await api('GET', `/api/projects/${projectId}/sessions`);
    expect(Array.isArray(all.json)).toBe(true);
    const paged = await api('GET', `/api/projects/${projectId}/sessions?limit=5`);
    const body = paged.json as unknown as {
      sessions: Array<{ title: string }>;
      has_more: boolean;
      next_cursor: string | null;
    };
    expect(body.sessions).toHaveLength(5);
    expect(body.has_more).toBe(true);
    expect(body.next_cursor).toBeTruthy();
    const next = await api(
      'GET',
      `/api/projects/${projectId}/sessions?limit=5&before=${encodeURIComponent(body.next_cursor!)}`,
    );
    const nextBody = next.json as unknown as { sessions: Array<{ title: string }>; has_more: boolean };
    expect(nextBody.sessions.length).toBeGreaterThanOrEqual(2);
    expect(nextBody.has_more).toBe(false);
  });
});
