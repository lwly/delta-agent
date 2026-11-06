/**
 * F-58 T4b：6 个调度 HTTP 端点契约测试（design-f58 §14）+ 两处既有端点护栏（裁决 Q1/Q3）
 * + dispose 不留孤儿任务（runtime 装配判据 4）。
 * 复用 external-agents-api.test.ts 的真服务基建（tmp SQLite + port 0）；dispatcher 用
 * fake send/peekRunning 装配（不 spawn 进程、不触碰真实 Provider）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import type { ChatMessage, ChatRequest, LLMProvider, StreamEvent } from '@delta/shared';
import { SessionService } from '../src/session/service.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { SessionHub, createWebServer } from '../src/server/index.js';
import type { SessionHubDeps } from '../src/server/hub.js';
import { createServeRuntime, type ServeRuntime } from '../src/index.js';
import { Dispatcher } from '../src/router/dispatcher.js';

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
let server: ReturnType<typeof createWebServer>;
let base = '';
let svc: SessionService;

/** fake hub 侧记录（send/abort 计数；peekRunning 恒 false = 无真实运行） */
const fake = {
  sends: [] as Array<{ sessionId: string; input: string }>,
  aborted: [] as string[],
  isRunningCalls: { n: 0 },
  workerSessions: [] as Array<{ id: string; projectId: string; taskId: string }>,
  reset() {
    this.sends = [];
    this.aborted = [];
    this.workerSessions = [];
  },
};

function buildDispatcher(service: SessionService): Dispatcher {
  let wsSeq = 0;
  return new Dispatcher({
    workerTasks: service.workerTasks,
    inbox: service.inbox,
    send: async (sessionId, input) => {
      fake.sends.push({ sessionId, input });
    },
    peekRunning: () => false,
    isRunning: () => {
      fake.isRunningCalls.n += 1;
      return false;
    },
    abort: (sessionId) => {
      fake.aborted.push(sessionId);
    },
    preflight: () => Promise.resolve({ ok: true }),
    createWorkerSession: (projectId, o) => {
      const rec = { id: `ws-${++wsSeq}`, projectId, taskId: o.taskId };
      fake.workerSessions.push(rec);
      return rec;
    },
    getRouterModel: () => 'mock-model',
    maxConcurrentWorkers: 3,
  });
}

interface Started {
  service: SessionService;
  projectId: string;
}

async function startServer(withDispatcher: boolean): Promise<Started> {
  svc = new SessionService(path.join(tmp, `db-${withDispatcher}.sqlite`));
  const deps: SessionHubDeps = {
    service: svc,
    registry: new ToolRegistry(),
    resolveProvider: async () => new MockProvider(),
  };
  const hub = new SessionHub(deps);
  const dispatcher = withDispatcher ? buildDispatcher(svc) : undefined;
  server = createWebServer({ service: svc, hub, port: 0, ...(dispatcher ? { dispatcher } : {}) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const projectId = svc.ensureProject('/tmp/demo-f58-http').id;
  return { service: svc, projectId };
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-f58-http-'));
  fake.reset();
  fake.isRunningCalls = { n: 0 };
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  svc.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

const api = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`${base}${p}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
};

// ── POST /api/projects/:id/router（取或建，幂等）─────────────────────────────

describe('POST /api/projects/:id/router', () => {
  it('建 Router 会话（kind=router、固定 plan 档）；重复调用幂等返回同一会话', async () => {
    const { projectId } = await startServer(true);
    const first = await api('POST', `/api/projects/${projectId}/router`, {});
    expect(first.status).toBe(200);
    const s1 = first.json.session as Record<string, unknown>;
    expect(s1.kind).toBe('router');
    expect((await api('GET', `/api/sessions/${s1.id}/permission`)).json.mode).toBe('plan');
    const second = await api('POST', `/api/projects/${projectId}/router`, {});
    expect((second.json.session as Record<string, unknown>).id).toBe(s1.id); // 幂等
  });

  it('外部模型不能当 Router（§4.4 拦截点 1）→ 400；项目不存在 → 404', async () => {
    const { projectId } = await startServer(true);
    const bad = await api('POST', `/api/projects/${projectId}/router`, { model: 'cli:codebuddy' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain('外部模型');
    expect((await api('POST', '/api/projects/nope/router', {})).status).toBe(404);
  });
});

// ── GET/POST /api/projects/:id/worker-tasks ─────────────────────────────────

describe('GET/POST /api/projects/:id/worker-tasks', () => {
  it('POST dispatch:true → queued 并立即派发；缺省 → draft（§7.4）；列表支持 status/limit 过滤', async () => {
    const { projectId } = await startServer(true);
    await api('POST', `/api/projects/${projectId}/router`, {});
    const queued = await api('POST', `/api/projects/${projectId}/worker-tasks`, {
      title: '任务A', goal: 'ga', dispatch: true,
    });
    expect(queued.status).toBe(200);
    expect((queued.json.task as Record<string, unknown>).status).toBe('queued');
    // 派发泵已跑：内置 executor 无前置 → 建会话 + running（fake send 不收敛，保持 running）
    expect(fake.workerSessions).toHaveLength(1);

    const draft = await api('POST', `/api/projects/${projectId}/worker-tasks`, { title: '任务B', goal: 'gb' });
    expect((draft.json.task as Record<string, unknown>).status).toBe('draft');

    const list = await api('GET', `/api/projects/${projectId}/worker-tasks`);
    expect((list.json.tasks as unknown[]).length).toBe(2);
    // 任务A 已被派发泵认领（内置 executor 无前置，fake send 不收敛 → 保持 running）
    const running = await api('GET', `/api/projects/${projectId}/worker-tasks?status=running`);
    expect((running.json.tasks as unknown[]).length).toBe(1);
    expect((running.json.tasks as Array<Record<string, unknown>>)[0]!.worker_session_id).toBe('ws-1');
    const drafts = await api('GET', `/api/projects/${projectId}/worker-tasks?status=draft`);
    expect((drafts.json.tasks as Array<Record<string, unknown>>).length).toBe(1);
    expect(drafts.json.tasks![0]!.depends_on).toEqual([]); // WorkerTaskView 投影（JSON 已解析）
    expect((await api('GET', `/api/projects/${projectId}/worker-tasks?status=bogus`)).status).toBe(400);
    expect((await api('GET', '/api/projects/nope/worker-tasks')).status).toBe(404);
    expect((await api('POST', '/api/projects/nope/worker-tasks', { title: 't', goal: 'g' })).status).toBe(404);
  });

  it('手工建任务校验失败 → 400（body 同 dispatch_task 的 parseDispatchArgs）', async () => {
    const { projectId } = await startServer(true);
    const bad = await api('POST', `/api/projects/${projectId}/worker-tasks`, { title: 't', executor: 'cli:x' });
    expect(bad.status).toBe(400); // 缺 goal + 外部 executor 缺 permission_mode
    expect((await api('POST', `/api/projects/${projectId}/worker-tasks`, { title: 't', goal: 'g', executor: 'weird' })).status).toBe(400);
  });
});

// ── POST /api/worker-tasks/:id/decision | /cancel ────────────────────────────

describe('POST /api/worker-tasks/:id/decision 与 /cancel', () => {
  it('decision：400 非法值 / 404 不存在 / 409 非 needs_decision / retry 成功且 attempt+1', async () => {
    const { projectId, service } = await startServer(true);
    await api('POST', `/api/projects/${projectId}/router`, {});
    const created = await api('POST', `/api/projects/${projectId}/worker-tasks`, { title: 't', goal: 'g', dispatch: true });
    const id = (created.json.task as Record<string, unknown>).id as string;

    expect((await api('POST', `/api/worker-tasks/${id}/decision`, { decision: 'nope' })).status).toBe(400);
    expect((await api('POST', '/api/worker-tasks/wt-nope/decision', { decision: 'retry' })).status).toBe(404);
    expect((await api('POST', `/api/worker-tasks/${id}/decision`, { decision: 'retry' })).status).toBe(409); // running 非 needs_decision

    // 构造 needs_decision：running → 无法直达，用 queued → preflight → needs_decision
    const t2 = await api('POST', `/api/projects/${projectId}/worker-tasks`, { title: 't2', goal: 'g2', dispatch: true });
    const id2 = (t2.json.task as Record<string, unknown>).id as string;
    // 任务A 已占满槽位？maxConcurrent=3，id2 会被派发——先取消它再走状态机
    await api('POST', `/api/worker-tasks/${id2}/cancel`, {});
    expect((await api('POST', `/api/worker-tasks/${id2}/cancel`, {})).status).toBe(200); // 幂等（终态返回原行）
    expect((await api('POST', `/api/worker-tasks/${id2}/decision`, { decision: 'retry' })).status).toBe(409); // canceled 终态

    const t3 = await api('POST', `/api/projects/${projectId}/worker-tasks`, { title: 't3', goal: 'g3', dispatch: true });
    const id3 = (t3.json.task as Record<string, unknown>).id as string;
    const row3 = service.workerTasks.get(id3);
    expect(row3.status).toBe('running'); // 已被派发泵认领
    expect(row3.attempt).toBe(1);
    // 直接经 store 状态机构造 needs_decision 场景（queued→preflight→needs_decision 的合法边已在 T1 覆盖；
    // 经 transition 直达不经 claimSlot，故 attempt 保持 0）
    const t4 = service.workerTasks.create({ projectId, routerSessionId: row3.router_session_id, title: 't4', goal: 'g4', status: 'queued' });
    service.workerTasks.transition(t4.id, 'preflight');
    const nd = service.workerTasks.transition(t4.id, 'needs_decision');
    expect(nd.attempt).toBe(0);
    const retried = await api('POST', `/api/worker-tasks/${t4.id}/decision`, { decision: 'retry' });
    expect(retried.status).toBe(200);
    const view = retried.json.task as Record<string, unknown>;
    expect(view.status).toBe('queued');
    expect(view.attempt).toBe(1); // retry = attempt+1
  });

  it('cancel：queued → canceled（200）；running → abort 被调且 canceled；404 不存在', async () => {
    const { projectId, service } = await startServer(true);
    await api('POST', `/api/projects/${projectId}/router`, {});
    const created = await api('POST', `/api/projects/${projectId}/worker-tasks`, { title: 't', goal: 'g', dispatch: true });
    const id = (created.json.task as Record<string, unknown>).id as string;
    expect((await api('POST', '/api/worker-tasks/wt-nope/cancel', {})).status).toBe(404);

    const t2 = await api('POST', `/api/projects/${projectId}/worker-tasks`, { title: 't2', goal: 'g2', dispatch: true });
    const id2 = (t2.json.task as Record<string, unknown>).id as string;
    const row2 = service.workerTasks.get(id2);
    expect(row2.status).toBe('running');
    const cancelled = await api('POST', `/api/worker-tasks/${id2}/cancel`, {});
    expect(cancelled.status).toBe(200);
    expect((cancelled.json.task as Record<string, unknown>).status).toBe('canceled');
    expect(fake.aborted).toContain(row2.worker_session_id); // running 先 abort 再迁移
    expect(service.workerTasks.get(id2).status).toBe('canceled');
  });
});

// ── GET /api/projects/:id/inbox?delivered=0 ──────────────────────────────────

describe('GET /api/projects/:id/inbox', () => {
  it('未送达条目；无 Router 会话返回空态；delivered 非法值 400；404 项目', async () => {
    const { projectId } = await startServer(true);
    expect((await api('GET', `/api/projects/${projectId}/inbox?delivered=0`)).json.items).toEqual([]);
    await api('POST', `/api/projects/${projectId}/router`, {});
    const router = svc.listSessions(projectId).find((s) => s.kind === 'router')!;
    svc.inbox.append({ routerSessionId: router.id, kind: 'task_done', severity: 'silent', payload: {} });
    svc.inbox.append({ routerSessionId: router.id, kind: 'needs_decision', severity: 'interrupt', payload: { reason: 'x' } });
    const res = await api('GET', `/api/projects/${projectId}/inbox?delivered=0`);
    expect(res.status).toBe(200);
    expect((res.json.items as unknown[]).length).toBe(2);
    expect((await api('GET', `/api/projects/${projectId}/inbox?delivered=1`)).status).toBe(400);
    expect((await api('GET', '/api/projects/nope/inbox?delivered=0')).status).toBe(404);
  });
});

// ── 两处既有端点护栏（裁决 Q1/Q3）────────────────────────────────────────────

describe('既有端点护栏', () => {
  it('PATCH /api/sessions/:id 只接受 model/title——kind/role_label/task_id 写入被无视（Q1）', async () => {
    const { projectId } = await startServer(true);
    const { json } = await api('POST', `/api/projects/${projectId}/router`, {});
    const routerId = (json.session as Record<string, unknown>).id as string;
    const patch = await api('PATCH', `/api/sessions/${routerId}`, {
      kind: 'chat', role_label: 'hijacked', task_id: 'wt-evil', title: '新标题',
    });
    expect(patch.status).toBe(200);
    const after = (await api('GET', `/api/sessions/${routerId}/meta`)).json.session as Record<string, unknown>;
    expect(after.kind).toBe('router'); // kind 无写入口
    expect(after.role_label).toBeNull();
    expect(after.task_id).toBeNull();
    expect(after.title).toBe('新标题'); // model/title 仍是合法字段
  });

  it('PATCH /api/sessions/:id/permission 对 kind=router 返回 400（Q3：固定 plan 档）', async () => {
    const { projectId } = await startServer(true);
    const { json } = await api('POST', `/api/projects/${projectId}/router`, {});
    const routerId = (json.session as Record<string, unknown>).id as string;
    const denied = await api('PATCH', `/api/sessions/${routerId}/permission`, { mode: 'yolo' });
    expect(denied.status).toBe(400);
    expect((await api('GET', `/api/sessions/${routerId}/permission`)).json.mode).toBe('plan');
    // 普通会话不受影响
    const s = svc.createSession(projectId, {});
    expect((await api('PATCH', `/api/sessions/${s.id}/permission`, { mode: 'yolo' })).status).toBe(200);
  });
});

// ── 能力未装配 501（对齐 F-54 口径）──────────────────────────────────────────

describe('调度能力未装配 → 501', () => {
  it('6 个端点在无 dispatcher 时一律 501', async () => {
    const { projectId } = await startServer(false);
    expect((await api('POST', `/api/projects/${projectId}/router`, {})).status).toBe(501);
    expect((await api('GET', `/api/projects/${projectId}/worker-tasks`)).status).toBe(501);
    expect((await api('POST', `/api/projects/${projectId}/worker-tasks`, { title: 't', goal: 'g' })).status).toBe(501);
    expect((await api('POST', '/api/worker-tasks/wt-x/decision', { decision: 'retry' })).status).toBe(501);
    expect((await api('POST', '/api/worker-tasks/wt-x/cancel', {})).status).toBe(501);
    expect((await api('GET', `/api/projects/${projectId}/inbox?delivered=0`)).status).toBe(501);
  });
});

// ── dispose 不留孤儿任务（runtime 装配判据 4）────────────────────────────────

describe('runtime dispose 收敛', () => {
  it('dispose 后 running/preflight 行全部收敛 failed(runtime)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-f58-dispose-'));
    const dbPath = path.join(dir, 'agent.db');
    let rt: ServeRuntime | undefined;
    try {
      rt = await createServeRuntime({
        port: 0,
        dbPath,
        cronHomeDir: dir,
        skillsHomeDir: dir,
        configHomeDir: dir,
      });
      // 直接向同一库写入孤儿行（不触发派发链路，避免真实 Provider 依赖）：
      // 一行 running（带 worker_session_id）、一行 preflight（无会话）
      const db = new Database(dbPath);
      const now = Date.now();
      db.prepare(
        `INSERT INTO worker_tasks (id, project_id, router_session_id, title, goal, permission_mode, status,
           priority, depends_on, artifacts, attempt, created_at, updated_at)
         VALUES ('wt-orphan-running', 'p', 'r', 't', 'g', 'default', 'running', 1, '[]', '[]', 1, ?, ?)`,
      ).run(now, now);
      db.prepare('UPDATE worker_tasks SET worker_session_id = ? WHERE id = ?').run('ws-ghost', 'wt-orphan-running');
      db.prepare(
        `INSERT INTO worker_tasks (id, project_id, router_session_id, title, goal, permission_mode, status,
           priority, depends_on, artifacts, attempt, created_at, updated_at)
         VALUES ('wt-orphan-preflight', 'p', 'r', 't2', 'g2', 'default', 'preflight', 1, '[]', '[]', 1, ?, ?)`,
      ).run(now, now);
      db.close();

      await rt.dispose();
      rt = undefined;

      const check = new Database(dbPath);
      const rows = check.prepare(`SELECT id, status, failure_kind FROM worker_tasks ORDER BY id`).all() as Array<{
        id: string; status: string; failure_kind: string | null;
      }>;
      check.close();
      expect(rows).toEqual([
        { id: 'wt-orphan-preflight', status: 'failed', failure_kind: 'runtime' },
        { id: 'wt-orphan-running', status: 'failed', failure_kind: 'runtime' },
      ]);
    } finally {
      await rt?.dispose().catch(() => undefined);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
