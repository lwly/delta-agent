/**
 * F-22 定时任务 —— /api/cron 端点单测：
 * 清单 / 新增（400 校验）/ 编辑 / 删除 / 404 / 立即运行（202 + 后台执行 + 轮询可见）
 * / 未配置执行器时 400 / 存储隔离（cronHomeDir 注入临时目录）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ChatMessage, ChatRequest, LLMProvider, StreamEvent } from '@y-zero/shared';
import { SessionService } from '../src/session/service.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { SessionHub, createWebServer } from '../src/server/index.js';
import { loadCronJobs } from '../src/cron/store.js';
import type { CronExecutor } from '../src/cron/runner.js';

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
let home = '';
let server: ReturnType<typeof createWebServer>;
let base = '';
let executorCalls: string[];

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-cron-web-'));
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-cron-home-'));
  executorCalls = [];
  const service = new SessionService(path.join(tmp, 'db.sqlite'));
  service.ensureProject(tmp);
  const hub = new SessionHub({
    service,
    registry: new ToolRegistry(),
    resolveProvider: async () => new NoopProvider(),
  });
  const executor: CronExecutor = async (job) => {
    executorCalls.push(job.name);
    return { status: 'completed', exitCode: 0, sessionId: 's-x', costUsd: 0.01, turns: 1 };
  };
  server = createWebServer({ service, hub, port: 0, cronExecutor: executor, cronHomeDir: home });
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
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
};

describe('F-22 /api/cron 端点', () => {
  it('GET 空清单 → {jobs:[],warnings:[]}', async () => {
    const r = await api('GET', '/api/cron');
    expect(r.status).toBe(200);
    expect(r.json.jobs).toEqual([]);
    expect(r.json.warnings).toEqual([]);
  });

  it('POST 新增 → 200 返回任务；缺字段 → 400；非法 cron → 400', async () => {
    const ok = await api('POST', '/api/cron', { name: 'daily', cron: '@daily', prompt: '整理', cwd: tmp });
    expect(ok.status).toBe(200);
    expect(ok.json.enabled).toBe(true);
    expect(ok.json.next_run_at).toBeTruthy();
    expect(loadCronJobs(home).jobs).toHaveLength(1);

    expect((await api('POST', '/api/cron', { name: 'x', cron: '@daily' })).status).toBe(400);
    expect((await api('POST', '/api/cron', { name: 'x', cron: '61 * * * *', prompt: 'p', cwd: tmp })).status).toBe(400);
    expect((await api('POST', '/api/cron', { name: 'daily', cron: '@daily', prompt: 'p', cwd: tmp })).status).toBe(400);
  });

  it('PATCH 编辑启停与 cron；GET 单任务；DELETE 删除；404', async () => {
    const add = await api('POST', '/api/cron', { name: 'job1', cron: '@daily', prompt: 'p', cwd: tmp });
    const id = String(add.json.id);

    const patched = await api('PATCH', `/api/cron/${id}`, { enabled: false, cron: '0 22 * * *' });
    expect(patched.status).toBe(200);
    expect(patched.json.enabled).toBe(false);
    expect(patched.json.next_run_at).toBeTruthy();

    expect((await api('GET', `/api/cron/${id}`)).json.enabled).toBe(false);
    expect((await api('GET', '/api/cron/ghost')).status).toBe(404);

    expect((await api('DELETE', `/api/cron/${id}`)).status).toBe(200);
    expect((await api('DELETE', `/api/cron/${id}`)).status).toBe(404);
    expect(loadCronJobs(home).jobs).toHaveLength(0);
  });

  it('POST :id/run → 202 后台执行，轮询可见 lastRun 与记录', async () => {
    const add = await api('POST', '/api/cron', { name: 'runme', cron: '@daily', prompt: 'p', cwd: tmp });
    const id = String(add.json.id);
    const run = await api('POST', `/api/cron/${id}/run`);
    expect(run.status).toBe(202);
    expect(executorCalls).toEqual(['runme']);
    // 轮询直到运行记录落盘（后台 fire-and-forget）
    for (let i = 0; i < 50; i++) {
      const job = (await api('GET', `/api/cron/${id}`)).json as Record<string, unknown>;
      if (job.last_run) {
        expect((job.last_run as Record<string, unknown>).status).toBe('completed');
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    const final = (await api('GET', `/api/cron/${id}`)).json as Record<string, unknown>;
    expect(final.last_run).toBeDefined();
    expect(final.running_since).toBeUndefined();
  });

  it('nextRunAt 已过期的任务 run 不推进调度时刻（手动语义）', async () => {
    const add = await api('POST', '/api/cron', { name: 'keep', cron: '@daily', prompt: 'p', cwd: tmp });
    const id = String(add.json.id);
    const nextBefore = String(add.json.next_run_at);
    await api('POST', `/api/cron/${id}/run`);
    await new Promise((r) => setTimeout(r, 50));
    expect(((await api('GET', `/api/cron/${id}`)).json as Record<string, unknown>).next_run_at).toBe(nextBefore);
  });
});

describe('F-22 /api/cron 未配置执行器', () => {
  it('POST :id/run → 400', async () => {
    const service = new SessionService(path.join(tmp, 'db2.sqlite'));
    service.ensureProject(tmp);
    const hub = new SessionHub({ service, registry: new ToolRegistry(), resolveProvider: async () => new NoopProvider() });
    const s2 = createWebServer({ service, hub, port: 0, cronHomeDir: home });
    await new Promise<void>((resolve) => s2.listen(0, '127.0.0.1', resolve));
    const addr = s2.address();
    const b2 = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const res = await fetch(`${b2}/api/cron/any/run`, { method: 'POST' });
    expect(res.status).toBe(400);
    await new Promise<void>((resolve) => s2.close(() => resolve()));
  });
});
