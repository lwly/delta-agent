/**
 * 架构收口 T8 —— 路由表对照表用例（判据 1/2）。
 *
 * 判据 1：搬迁前后端点的状态码 / 响应体形状逐条对照——本文件用一张表驱动用例
 * 覆盖三组（cron 6 / worker-tasks 6 / sessions 22）全部搬迁端点，断言值取自
 * 搬迁前 if/else 实现的既有行为（cron-server / router-http / server 既有用例
 * 零改动同时通过，构成「搬迁前后一致」的交叉验证）。
 * 判据 2：assertRouteDecls 对漏声明 auth 的路由启动即抛错（单元级可测断言）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ChatMessage, ChatRequest, LLMProvider, StreamEvent } from '@delta/shared';
import { SessionService } from '../src/session/service.js';
import { SessionHub, createWebServer } from '../src/server/index.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { Dispatcher } from '../src/router/dispatcher.js';
import { assertRouteDecls, matchRoute, type RouteDef } from '../src/server/routes.js';

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

let tmp = '';
let cronHome = '';
let server: ReturnType<typeof createWebServer>;
let base = '';
let svc: SessionService;
let pid = '';
let sid = '';
/** cron 运行闸门：第一轮 run 挂起（模拟运行中），测试尾部放行 */
let releaseCronRun: (() => void) | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-routes-'));
  cronHome = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-routes-cron-'));
  svc = new SessionService(path.join(tmp, 'db.sqlite'));
  pid = svc.ensureProject(tmp).id;
  sid = svc.createSession(pid, { title: 'T8 对照表会话' }).id;
  const hub = new SessionHub({
    service: svc,
    registry: new ToolRegistry(),
    resolveProvider: async () => new MockProvider(),
  });
  // 轻量 dispatcher：fake send / peekRunning=false（与 router-http 同款脚手架）
  const dispatcher = new Dispatcher({
    workerTasks: svc.workerTasks,
    inbox: svc.inbox,
    send: async () => undefined,
    peekRunning: () => false,
    isRunning: () => false,
    abort: () => true,
    createWorkerSession: (p) => ({ id: `ws-${p}` }),
  });
  server = createWebServer({
    service: svc,
    hub,
    port: 0,
    cronHomeDir: cronHome,
    // 运行闸门：executor 等 releaseCronRun 才完成（409 重复运行断言的前提）
    cronExecutor: async () => {
      await new Promise<void>((r) => (releaseCronRun = r));
      return { status: 'completed' as const, exitCode: 0 };
    },
    dispatcher,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(async () => {
  releaseCronRun?.();
  await new Promise<void>((r) => server.close(() => r()));
  svc.close();
});

const call = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, text, headers: res.headers };
};

describe('T8 路由表：matcher 与启动断言（判据 2）', () => {
  it('静态段优先于通配段；段数不一致不匹配；method 不匹配不命中', () => {
    const defs: RouteDef[] = [
      { method: 'GET', pattern: 'api/x/:id', auth: 'token', handler: async () => undefined },
      { method: 'GET', pattern: 'api/x/static', auth: 'token', handler: async () => undefined },
      { method: 'POST', pattern: 'api/x/static', auth: 'token', handler: async () => undefined },
    ];
    // 静态优先
    expect(matchRoute(defs, 'GET', ['api', 'x', 'static'])!.def.pattern).toBe('api/x/static');
    // 通配兜底
    expect(matchRoute(defs, 'GET', ['api', 'x', 'other'])!.def.pattern).toBe('api/x/:id');
    // method 不匹配 → 不命中（落到 POST 定义之外）
    expect(matchRoute(defs, 'DELETE', ['api', 'x', 'static'])).toBeNull();
    // 段数不一致 → 不匹配
    expect(matchRoute(defs, 'GET', ['api', 'x'])).toBeNull();
    expect(matchRoute(defs, 'GET', ['api', 'x', 'static', 'extra'])).toBeNull();
  });

  it('漏声明 auth 的路由：assertRouteDecls 启动即抛错（判据 2 可测断言）', () => {
    const bad = [
      { method: 'GET', pattern: 'api/new-endpoint', handler: async () => undefined },
    ] as unknown as RouteDef[];
    expect(() => assertRouteDecls(bad, 'test')).toThrow(/未声明 auth/);
    // 正常声明不抛
    expect(() =>
      assertRouteDecls([
        { method: 'GET', pattern: 'api/ok', auth: 'token', handler: async () => undefined },
      ], 'test'),
    ).not.toThrow();
  });
});

describe('T8 对照表：cron 组（6 端点）', () => {
  it('状态码 / 响应体形状逐条对照', async () => {
    // GET /api/cron → 200 {jobs, warnings, workspaces}
    const list = await call('GET', '/api/cron');
    expect(list.status).toBe(200);
    expect(list.json).toMatchObject({ jobs: [], warnings: [] });
    expect(Array.isArray((list.json as { workspaces: string[] }).workspaces)).toBe(true);

    // POST /api/cron → 200 job（含 name/cron/prompt/cwd/enabled/created_at）
    const created = await call('POST', '/api/cron', {
      name: 't8', cron: '30 8 * * *', prompt: 'p', cwd: tmp, project_id: pid,
    });
    expect(created.status).toBe(200);
    const job = created.json as Record<string, unknown>;
    expect(job.name).toBe('t8');
    expect(job.cron).toBe('30 8 * * *');
    expect(job.project_id).toBe(pid);
    expect(job.enabled).toBe(true);
    const jobId = String(job.id);

    // GET /api/cron/:id → 200 单任务；未知 id → 404
    const one = await call('GET', `/api/cron/${jobId}`);
    expect(one.status).toBe(200);
    expect((one.json as Record<string, unknown>).id).toBe(jobId);
    expect((await call('GET', '/api/cron/ghost')).status).toBe(404);

    // POST /api/cron/:id/run → 202 {ok, running:true}（已配执行器）
    const run = await call('POST', `/api/cron/${jobId}/run`);
    expect(run.status).toBe(202);
    expect(run.json).toMatchObject({ ok: true, running: true });
    // 运行中再 run → 409
    expect((await call('POST', `/api/cron/${jobId}/run`)).status).toBe(409);

    // PATCH /api/cron/:id → 200（enabled=false）；非法表达式 → 400
    const patched = await call('PATCH', `/api/cron/${jobId}`, { enabled: false });
    expect(patched.status).toBe(200);
    expect((patched.json as Record<string, unknown>).enabled).toBe(false);
    expect((await call('PATCH', `/api/cron/${jobId}`, { cron: 'bad expr' })).status).toBe(400);

    // DELETE /api/cron/:id → 200 {ok:true}；再删 → 404
    expect((await call('DELETE', `/api/cron/${jobId}`)).json).toMatchObject({ ok: true });
    expect((await call('DELETE', `/api/cron/${jobId}`)).status).toBe(404);
  });
});

describe('T8 对照表：worker-tasks 组（6 端点）', () => {
  it('状态码 / 响应体形状逐条对照', async () => {
    // POST /api/projects/:id/router → 200 {session}（幂等；kind=router）
    const router1 = await call('POST', `/api/projects/${pid}/router`, {});
    expect(router1.status).toBe(200);
    const s1 = (router1.json as { session: { id: string; kind?: string } }).session;
    expect(s1.kind).toBe('router');
    const router2 = await call('POST', `/api/projects/${pid}/router`, {});
    expect((router2.json as { session: { id: string } }).session.id).toBe(s1.id);

    // POST /api/projects/:id/worker-tasks → 200 {task}（手工建，落 draft）
    const created = await call('POST', `/api/projects/${pid}/worker-tasks`, { title: 'T8 任务', goal: 'g' });
    expect(created.status).toBe(200);
    const task = (created.json as { task: Record<string, unknown> }).task;
    expect(task.status).toBe('draft');
    expect(task.project_id).toBe(pid);
    const taskId = String(task.id);

    // GET /api/projects/:id/worker-tasks → 200 {tasks:[...]}; 非法 status → 400
    const list = await call('GET', `/api/projects/${pid}/worker-tasks`);
    expect(list.status).toBe(200);
    expect((list.json as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id)).toContain(taskId);
    expect((await call('GET', `/api/projects/${pid}/worker-tasks?status=bogus`)).status).toBe(400);

    // GET /api/projects/:id/inbox?delivered=0 → 200 {items:[]}；其它 delivered 值 → 400
    const inbox = await call('GET', `/api/projects/${pid}/inbox?delivered=0`);
    expect(inbox.status).toBe(200);
    expect(inbox.json).toMatchObject({ items: [] });
    expect((await call('GET', `/api/projects/${pid}/inbox?delivered=1`)).status).toBe(400);

    // POST /api/worker-tasks/:id/decision → 非法值 400；非 needs_decision（draft）→ 409
    expect((await call('POST', `/api/worker-tasks/${taskId}/decision`, { decision: 'bogus' })).status).toBe(400);
    expect((await call('POST', `/api/worker-tasks/${taskId}/decision`, { decision: 'accept' })).status).toBe(409);

    // POST /api/worker-tasks/:id/cancel → 200 {task}（dispatch:true 落 queued → 可取消）
    const queued = await call('POST', `/api/projects/${pid}/worker-tasks`, { title: '可取消', goal: 'g', dispatch: true });
    expect(queued.status).toBe(200);
    const queuedId = String((queued.json as { task: { id: string } }).task.id);
    const cancelled = await call('POST', `/api/worker-tasks/${queuedId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect((cancelled.json as { task: { status: string } }).task.status).toBe('canceled');
    // draft 状态机不允许直接取消 → 409
    expect((await call('POST', `/api/worker-tasks/${taskId}/cancel`)).status).toBe(409);
    // 不存在的任务 → 404
    expect((await call('POST', '/api/worker-tasks/ghost/cancel')).status).toBe(404);
  });
});

describe('T8 对照表：sessions 组（22 端点）', () => {
  it('状态码 / 响应体形状逐条对照', async () => {
    // GET /api/sessions/:id → 200 {session, messages}
    const one = await call('GET', `/api/sessions/${sid}`);
    expect(one.status).toBe(200);
    expect((one.json as { session: { id: string } }).session.id).toBe(sid);
    expect(Array.isArray((one.json as { messages: unknown[] }).messages)).toBe(true);

    // GET meta → 200 {session}
    const meta = await call('GET', `/api/sessions/${sid}/meta`);
    expect(meta.status).toBe(200);
    expect((meta.json as { session: { id: string } }).session.id).toBe(sid);

    // GET messages → 200 {messages, has_more, next_before}
    const msgs = await call('GET', `/api/sessions/${sid}/messages`);
    expect(msgs.status).toBe(200);
    expect((msgs.json as { has_more: boolean }).has_more).toBe(false);

    // GET messages/:seq/content → 空历史 404；非整数 seq → 400
    expect((await call('GET', `/api/sessions/${sid}/messages/0/content`)).status).toBe(404);
    expect((await call('GET', `/api/sessions/${sid}/messages/abc/content`)).status).toBe(400);

    // PATCH → 200 {ok:true}（改名）
    expect((await call('PATCH', `/api/sessions/${sid}`, { title: 'T8 改名' })).json).toMatchObject({ ok: true });

    // GET / PATCH permission
    expect((await call('GET', `/api/sessions/${sid}/permission`)).json).toMatchObject({ mode: 'default' });
    const perm = await call('PATCH', `/api/sessions/${sid}/permission`, { mode: 'yolo' });
    expect(perm.status).toBe(200);
    expect(perm.json).toMatchObject({ ok: true, mode: 'yolo' });
    expect((await call('PATCH', `/api/sessions/${sid}/permission`, { mode: 'bogus' })).status).toBe(400);

    // GET runs → 200 []；runs/:seq → 404
    expect(await call('GET', `/api/sessions/${sid}/runs`).then((r) => r.json)).toEqual([]);
    expect((await call('GET', `/api/sessions/${sid}/runs/1`)).status).toBe(404);

    // GET export → 200（md 文件响应头）；非法 format → 400
    const exp = await call('GET', `/api/sessions/${sid}/export?format=md`);
    expect(exp.status).toBe(200);
    expect(exp.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect((await call('GET', `/api/sessions/${sid}/export?format=xml`)).status).toBe(400);

    // GET git → 200（非 repo：isRepo:false）；GET branches → 400（非 repo）
    const git = await call('GET', `/api/sessions/${sid}/git`);
    expect(git.status).toBe(200);
    expect((git.json as { isRepo: boolean }).isRepo).toBe(false);
    expect((await call('GET', `/api/sessions/${sid}/branches`)).status).toBe(400);

    // POST checkout（无 branch/newBranch → 400）
    expect((await call('POST', `/api/sessions/${sid}/checkout`, {})).status).toBe(400);

    // GET background-tasks → 501（能力未装配，对齐 terminal 口径）
    expect((await call('GET', `/api/sessions/${sid}/background-tasks`)).status).toBe(501);

    // POST messages → 202 {ok, running:true}；空 input → 400
    const msg = await call('POST', `/api/sessions/${sid}/messages`, { input: '你好' });
    expect(msg.status).toBe(202);
    expect(msg.json).toMatchObject({ ok: true, running: true });
    await new Promise((r) => setTimeout(r, 50)); // 让 mock provider 跑完，避免占用 running
    expect((await call('POST', `/api/sessions/${sid}/messages`, { input: '' })).status).toBe(400);

    // POST abort → 200 {ok}（未运行 = false）
    expect((await call('POST', `/api/sessions/${sid}/abort`)).json).toMatchObject({ ok: false });

    // POST pause → 409（未在执行中）
    expect((await call('POST', `/api/sessions/${sid}/pause`)).status).toBe(409);

    // POST fork → after_index 非法 400
    expect((await call('POST', `/api/sessions/${sid}/fork`, { after_index: -1 })).status).toBe(400);

    // POST terminal → 501（能力未装配）
    expect((await call('POST', `/api/sessions/${sid}/terminal`)).status).toBe(501);

    // POST confirm / answer / plan → 无 pending → 404
    expect((await call('POST', `/api/sessions/${sid}/confirm`, { requestId: 'x', decision: 'allow' })).status).toBe(404);
    expect((await call('POST', `/api/sessions/${sid}/answer`, { requestId: 'x', answer: 'y' })).status).toBe(404);
    expect((await call('POST', `/api/sessions/${sid}/plan`, { requestId: 'x', decision: { kind: 'approve' } })).status).toBe(404);

    // DELETE → 200 {ok:true}（用一次性会话；ghost id 软删幂等同为 200，legacy 同口径）
    const tmpSid = svc.createSession(pid, { title: 'T8 待删' }).id;
    expect((await call('DELETE', `/api/sessions/${tmpSid}`)).json).toMatchObject({ ok: true });
    expect((await call('DELETE', '/api/sessions/ghost')).status).toBe(200);
  });

  it('worker-tasks 组在 dispatcher 未装配时 501（能力未装配口径保留）', async () => {
    const hub = new SessionHub({
      service: svc,
      registry: new ToolRegistry(),
      resolveProvider: async () => new MockProvider(),
    });
    const srv2 = createWebServer({ service: svc, hub, port: 0, cronHomeDir: cronHome });
    await new Promise<void>((r) => srv2.listen(0, '127.0.0.1', r));
    const addr = srv2.address();
    const base2 = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    try {
      const res = await fetch(`${base2}/api/projects/${pid}/worker-tasks`);
      expect(res.status).toBe(501);
      expect(await res.json()).toMatchObject({ error: '调度能力未装配' });
    } finally {
      srv2.close();
    }
  });
});
