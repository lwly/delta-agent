/**
 * F-54 会话内后台任务 —— HTTP 端点单测：
 * 未装配 501（能力未装配口径）/ 列表按会话过滤 / DELETE 终止运行中任务 / 未知任务 404。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ChatMessage, ChatRequest, StreamEvent, LLMProvider } from '@delta/shared';
import { SessionService } from '../src/session/service.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { SessionHub } from '../src/server/hub.js';
import { createWebServer } from '../src/server/http.js';
import { BackgroundTaskManager } from '../src/session/background-tasks.js';

class NoopProvider implements LLMProvider {
  readonly id = 'noop';
  async *chat(_req: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: 'done' };
  }
  estimateTokens(messages: ChatMessage[]): number {
    return messages.length;
  }
}

const isWin = process.platform === 'win32';

let tmp = '';
let server: ReturnType<typeof createWebServer>;
let base = '';
let bg: BackgroundTaskManager;

function startServer(withBg: boolean): Promise<void> {
  return new Promise((resolve) => {
    const service = new SessionService(path.join(tmp, 'db.sqlite'));
    service.ensureProject(tmp);
    const hub = new SessionHub({
      service,
      registry: new ToolRegistry(),
      resolveProvider: async () => new NoopProvider(),
      ...(withBg ? { backgroundTasks: bg } : {}),
    });
    server = createWebServer({
      service,
      hub,
      port: 0,
      ...(withBg ? { backgroundTasks: bg } : {}),
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-bg-api-'));
  bg = new BackgroundTaskManager();
});

afterEach(async () => {
  bg.killAll();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const api = async (method: string, p: string) => {
  const res = await fetch(`${base}${p}`, { method });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
};

describe('F-54 /api/sessions/:id/background-tasks 端点', () => {
  it('未装配 → 501（能力未装配口径，对齐 terminal）', async () => {
    await startServer(false);
    expect((await api('GET', '/api/sessions/s1/background-tasks')).status).toBe(501);
    expect((await api('DELETE', '/api/sessions/s1/background-tasks/bg_x')).status).toBe(501);
  });

  it.runIf(isWin)('win32 跳过（spawn 语义测试只在 POSIX 验证）', () => {
    expect(true).toBe(true);
  });

  it.skipIf(isWin)('GET 列表按会话过滤；DELETE 终止运行中任务', async () => {
    await startServer(true);
    const id = bg.start('s1', 'sleep 30', tmp, '长任务');
    bg.start('s2', 'sleep 30', tmp);

    const list = await api('GET', '/api/sessions/s1/background-tasks');
    expect(list.status).toBe(200);
    const items = list.json as Array<{ id: string; description: string; status: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(id);
    expect(items[0]!.description).toBe('长任务');
    expect(items[0]!.status).toBe('running');

    const kill = await api('DELETE', `/api/sessions/s1/background-tasks/${id}`);
    expect(kill.status).toBe(200);
    expect(kill.json).toEqual({ ok: true });

    const killAgain = await api('DELETE', `/api/sessions/s1/background-tasks/${id}`);
    expect(killAgain.status).toBe(404);
  });

  it.skipIf(isWin)('DELETE 跨会话 id → 404', async () => {
    await startServer(true);
    const id = bg.start('s1', 'sleep 30', tmp);
    expect((await api('DELETE', `/api/sessions/s2/background-tasks/${id}`)).status).toBe(404);
  });
});
