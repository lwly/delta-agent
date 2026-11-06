/**
 * F-58 T2 测试脚手架：fake hub + 临时 SQLite + 预装配 Dispatcher。
 * 设计稿 §16：dispatcher 单测全部走 fake hub，不 spawn 真 CLI 进程、不依赖网络；
 * T5 的台账/任务台测试复用本文件。
 *
 * FakeHub 刻意记录 isRunning 调用次数：router/ 任何代码调用 isRunning 都是红线 bug
 * （§9.3 zombieReap 会回收超 30 分钟会话），用例据此断言。
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SessionService } from '../../src/session/service.js';
import {
  Dispatcher,
  type DispatcherDeps,
  type PreflightFn,
  type RunFinishedOutcome,
} from '../../src/router/dispatcher.js';
import type { PreflightResult } from '../../src/router/types.js';

export interface FakeSendRecord {
  sessionId: string;
  input: string;
}

export class FakeHub {
  sends: FakeSendRecord[] = [];
  /** 模拟 hub.running：测试手工增删，peekRunning 纯读 */
  running = new Set<string>();
  aborted: string[] = [];
  isRunningCalls = 0;
  /** 置位后下一次 send 抛错（_digest 回滚用例），随后自动清除 */
  sendError: Error | null = null;
  /** 每次 send 的同步/异步副作用钩子（防自激用例：send 期间注入新条目） */
  sendImpl?: (rec: FakeSendRecord) => void | Promise<void>;

  async send(sessionId: string, input: string): Promise<void> {
    const rec: FakeSendRecord = { sessionId, input };
    this.sends.push(rec);
    if (this.sendError) {
      const e = this.sendError;
      this.sendError = null;
      throw e;
    }
    await this.sendImpl?.(rec);
  }

  peekRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  isRunning(sessionId: string): boolean {
    this.isRunningCalls += 1;
    return this.running.has(sessionId);
  }

  abort(sessionId: string): void {
    this.aborted.push(sessionId);
    this.running.delete(sessionId);
  }

  sendCount(sessionId?: string): number {
    return sessionId ? this.sends.filter((s) => s.sessionId === sessionId).length : this.sends.length;
  }
}

export interface WorkerSessionRecord {
  id: string;
  projectId: string;
  taskId: string;
  title: string;
  model: string;
}

export interface DispatcherEnv {
  svc: SessionService;
  hub: FakeHub;
  dispatcher: Dispatcher;
  projectId: string;
  routerId: string;
  /** fake createWorkerSession 的落点（断言「不建会话」与 model 推导） */
  workerSessions: WorkerSessionRecord[];
  /** 派单便捷方法（默认内部引擎） */
  dispatch(overrides?: Partial<{ title: string; goal: string; priority: number; executor: string | null; permissionMode: 'plan' | 'default' | 'yolo'; dependsOn: string[]; roleLabel: string | null }>): ReturnType<Dispatcher['dispatch']>;
  /** onRunFinished 便捷出参 */
  outcome(overrides?: Partial<RunFinishedOutcome>): RunFinishedOutcome;
  dispose(): Promise<void>;
}

export interface CreateDispatcherEnvOpts {
  maxConcurrentWorkers?: number;
  routerModel?: string;
  defaultModel?: string;
  preflight?: PreflightFn;
  getResultSummary?: (workerSessionId: string) => string | null;
  extraDeps?: Partial<DispatcherDeps>;
}

const dirs: string[] = [];

/** 一套完整测试环境：临时库 + 项目 + Router 会话 + fake hub 装配的 Dispatcher */
export async function createDispatcherEnv(opts: CreateDispatcherEnvOpts = {}): Promise<DispatcherEnv> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-f58-dispatcher-'));
  dirs.push(dir);
  const svc = new SessionService(path.join(dir, 'test.db'));
  const projectId = svc.ensureProject('/tmp/demo-f58-dispatcher').id;
  const router = svc.createSession(projectId, { title: '总管', model: opts.routerModel });
  svc.store.setSessionKind(router.id, 'router');
  const hub = new FakeHub();
  const workerSessions: WorkerSessionRecord[] = [];
  let wsSeq = 0;

  const dispatcher = new Dispatcher({
    workerTasks: svc.workerTasks,
    inbox: svc.inbox,
    send: (sessionId, input) => hub.send(sessionId, input),
    peekRunning: (sessionId) => hub.peekRunning(sessionId),
    isRunning: (sessionId) => hub.isRunning(sessionId),
    abort: (sessionId) => hub.abort(sessionId),
    preflight: opts.preflight,
    createWorkerSession: (pid, o) => {
      const rec: WorkerSessionRecord = { id: `ws-${++wsSeq}`, projectId: pid, ...o };
      workerSessions.push(rec);
      return { id: rec.id };
    },
    getRouterModel: () => opts.routerModel ?? null,
    defaultModel: opts.defaultModel,
    maxConcurrentWorkers: opts.maxConcurrentWorkers ?? 3,
    getResultSummary: opts.getResultSummary,
    ...opts.extraDeps,
  });

  return {
    svc,
    hub,
    dispatcher,
    projectId,
    routerId: router.id,
    workerSessions,
    dispatch(overrides = {}) {
      return dispatcher.dispatch({
        projectId,
        routerSessionId: router.id,
        title: overrides.title ?? '登录页',
        goal: overrides.goal ?? '实现登录页与表单校验',
        priority: overrides.priority,
        executor: overrides.executor ?? null,
        permission_mode: overrides.permissionMode,
        depends_on: overrides.dependsOn,
        role_label: overrides.roleLabel,
      });
    },
    outcome(overrides = {}) {
      return { aborted: false, durationMs: 1000, ...overrides };
    },
    async dispose() {
      await fs.rm(dir, { recursive: true, force: true });
      const i = dirs.indexOf(dir);
      if (i >= 0) dirs.splice(i, 1);
    },
  };
}

/** 无操作 preflight（外部 executor 直接放行，状态机用例不关心门禁时用） */
export const preflightPass: PreflightFn = () => Promise.resolve({ ok: true } satisfies PreflightResult);

/** 全局兜底清理（防用例自建环境后忘 dispose） */
export async function cleanupAllDirs(): Promise<void> {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
}
