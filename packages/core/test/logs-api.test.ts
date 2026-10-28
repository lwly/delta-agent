/**
 * F-41 运行日志 —— /api/logs 端点单测：
 * 尾读 limit / 未注入 runLog 404 / SSE stream 连入补发尾部 + 后续推送。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ChatMessage, ChatRequest, StreamEvent } from '@delta/shared';
import type { LLMProvider } from '@delta/shared';
import { SessionService } from '../src/session/service.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { SessionHub } from '../src/server/hub.js';
import { createWebServer } from '../src/server/http.js';
import { RunLog } from '../src/logging/logger.js';

class NoopProvider implements LLMProvider {
  readonly id = 'noop';
  async *chat(_req: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: 'done' };
  }
  estimateTokens(messages: ChatMessage[]): number {
    return messages.length;
  }
}

let tmp = '';
let server: ReturnType<typeof createWebServer>;
let base = '';
let runLog: RunLog;

function startServer(withRunLog: boolean): Promise<void> {
  return new Promise((resolve) => {
    const service = new SessionService(path.join(tmp, 'db.sqlite'));
    service.ensureProject(tmp);
    const hub = new SessionHub({
      service,
      registry: new ToolRegistry(),
      resolveProvider: async () => new NoopProvider(),
      ...(withRunLog ? { runLog } : {}),
    });
    server = createWebServer({
      service,
      hub,
      port: 0,
      ...(withRunLog ? { runLog } : {}),
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-logs-api-'));
  runLog = new RunLog({ ringSize: 10 });
  let tick = 0;
  // 固定递增时钟：条目时间正序可断言
  (runLog as unknown as { now: () => Date }).now = () => new Date(Date.UTC(2026, 9, 28, 8, 0, 0, tick++));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const api = async (method: string, p: string) => {
  const res = await fetch(`${base}${p}`, { method });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
};

describe('F-41 /api/logs 端点', () => {
  it('runLog 未装配 → 404（能力未装配口径）', async () => {
    await startServer(false);
    expect((await api('GET', '/api/logs')).status).toBe(404);
    expect((await api('GET', '/api/logs/stream')).status).toBe(404);
  });

  it('GET /api/logs → tail 条目；limit 裁剪生效', async () => {
    await startServer(true);
    for (let i = 0; i < 6; i++) runLog.append('info', 'hub', `m${i}`);
    const all = await api('GET', '/api/logs');
    expect(all.status).toBe(200);
    expect((all.json.items as Array<{ message: string }>).map((e) => e.message)).toEqual([
      'm0',
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
    ]);

    const few = await api('GET', '/api/logs?limit=2');
    expect((few.json.items as Array<{ message: string }>).map((e) => e.message)).toEqual(['m4', 'm5']);
  });

  it('GET /api/logs/stream → 连入补发尾部，随后 append 实时推送；断开退订', async () => {
    await startServer(true);
    runLog.append('info', 'hub', 'before-stream');

    const res = await fetch(`${base}/api/logs/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const readFrame = async (): Promise<string> => {
      while (!buf.includes('\n\n')) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      const idx = buf.indexOf('\n\n');
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      return frame;
    };

    // ① 连入补发：已有尾部
    const first = JSON.parse((await readFrame()).replace(/^data: /, '')) as { message: string };
    expect(first.message).toBe('before-stream');

    // ② 后续 append 实时推送
    runLog.append('warn', 'cron', 'live-entry');
    const second = JSON.parse((await readFrame()).replace(/^data: /, '')) as { message: string; level: string };
    expect(second.message).toBe('live-entry');
    expect(second.level).toBe('warn');

    await reader.cancel();
  });

  it('经 runLog 写入的条目进入环形缓冲（tail 可回读）', async () => {
    await startServer(true);
    runLog.append('error', 'hub', 'boom', 'sid-1');
    const r = await api('GET', '/api/logs?limit=1');
    const item = (r.json.items as Array<Record<string, unknown>>)[0]!;
    expect(item.level).toBe('error');
    expect(item.sessionId).toBe('sid-1');
    expect(item.message).toBe('boom');
  });
});
