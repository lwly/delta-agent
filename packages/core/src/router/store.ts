/**
 * F-58 Router–Worker 调度层：worker_tasks / task_inbox 两表的持久化 store。
 * 与 SessionStore 同库（注入其 SQLite 连接，参照 session/tasks.ts 写法）。
 *
 * 红线（设计稿 §7.1）：
 * - 金额不入 worker_tasks（从 usage 按 session_id 聚合，禁止双写）；
 * - role_label 与 sessions.role_label 只是 UI 标签，store 层不得据此做任何过滤/分支。
 */
import type Database from 'better-sqlite3';
import {
  type DispatchRequest,
  type FailureKind,
  type InboxItem,
  type InboxKind,
  type InboxSeverity,
  type TaskArtifact,
  type WorkerTaskStatus,
  type WorkerTaskRow,
  type WorkerTaskView,
} from './types.js';

export const DEFAULT_MAX_CONCURRENT_WORKERS = 3;

/**
 * 任务状态机合法边（设计稿 §7.4，逐边对齐；不在表内的迁移一律抛错）：
 *   draft → queued | canceled? 不允许——draft 只由 Web 手工表单产生，丢弃走删除
 *   queued → preflight（槽位认领）| canceled（依赖失败/用户取消）
 *   preflight → running | needs_decision
 *   needs_decision → queued（裁决 retry，attempt+1）| canceled | done（裁决 accept）
 *   running → done | failed | canceled
 * 终态（done/failed/canceled）无出边；L3 偏离不改状态（只写 watchdog_flag）。
 */
const VALID_TRANSITIONS: Record<WorkerTaskStatus, WorkerTaskStatus[]> = {
  draft: ['queued'],
  queued: ['preflight', 'canceled'],
  preflight: ['running', 'needs_decision'],
  needs_decision: ['queued', 'canceled', 'done'],
  running: ['done', 'failed', 'canceled'],
  done: [],
  failed: [],
  canceled: [],
};

/** 需要写 finished_at 的目标状态 */
const FINISHED_STATES: ReadonlySet<WorkerTaskStatus> = new Set(['done', 'failed', 'canceled']);

/** 解析 JSON 列；损坏/缺失回退默认值（不抛错，台账与任务台不因脏数据崩溃）。 */
function parseJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function parseArtifacts(raw: string): TaskArtifact[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as TaskArtifact[]) : [];
  } catch {
    return [];
  }
}

/** 行 → DTO 投影（Web 任务台数据源；金额永不入内）。 */
export function toWorkerTaskView(row: WorkerTaskRow): WorkerTaskView {
  let decision: unknown = null;
  if (row.decision_json) {
    try {
      decision = JSON.parse(row.decision_json) as unknown;
    } catch {
      decision = null;
    }
  }
  return {
    ...row,
    depends_on: parseJsonArray(row.depends_on),
    artifacts: parseArtifacts(row.artifacts),
    decision,
  };
}

export interface CreateWorkerTaskInput extends DispatchRequest {
  projectId: string;
  routerSessionId: string;
  /** Router 派单一律 'queued'；Web 手工表单可不带 dispatch 落 'draft'（§7.4） */
  status?: 'draft' | 'queued';
}

export interface ListWorkerTaskOpts {
  projectId?: string;
  routerSessionId?: string;
  status?: WorkerTaskStatus;
  limit?: number;
}

/**
 * worker_tasks 表访问层。claimSlot 是单条 UPDATE 的原子认领（并发两次只有一次 changes===1）。
 */
export class WorkerTaskStore {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateWorkerTaskInput): WorkerTaskRow {
    const now = Date.now();
    const status = input.status ?? 'queued';
    const id = cryptoRandomId();
    this.db
      .prepare(
        `INSERT INTO worker_tasks
           (id, project_id, router_session_id, title, goal, acceptance, role_label, executor,
            permission_mode, status, priority, depends_on, artifacts, attempt, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.routerSessionId,
        input.title,
        input.goal,
        input.acceptance ?? null,
        input.role_label ?? null,
        input.executor ?? null,
        input.permission_mode ?? 'default',
        status,
        input.priority ?? 1,
        JSON.stringify(input.depends_on ?? []),
        JSON.stringify([]),
        now,
        now,
      );
    return this.get(id);
  }

  get(id: string): WorkerTaskRow {
    const row = this.db.prepare('SELECT * FROM worker_tasks WHERE id = ?').get(id) as WorkerTaskRow | undefined;
    if (!row) throw new Error(`worker task not found: ${id}`);
    return row;
  }

  find(id: string): WorkerTaskRow | undefined {
    return this.db.prepare('SELECT * FROM worker_tasks WHERE id = ?').get(id) as WorkerTaskRow | undefined;
  }

  /** 按 Worker 会话反查任务（idx_wtasks_session；onRunFinished 收敛的唯一入口）。 */
  findByWorkerSession(workerSessionId: string): WorkerTaskRow | undefined {
    return this.db
      .prepare('SELECT * FROM worker_tasks WHERE worker_session_id = ?')
      .get(workerSessionId) as WorkerTaskRow | undefined;
  }

  /** 台账/任务台数据源：priority DESC, created_at ASC（设计稿 §8.2 第 1 步的桶序）。 */
  list(opts: ListWorkerTaskOpts = {}): WorkerTaskRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.projectId) { where.push('project_id = ?'); args.push(opts.projectId); }
    if (opts.routerSessionId) { where.push('router_session_id = ?'); args.push(opts.routerSessionId); }
    if (opts.status) { where.push('status = ?'); args.push(opts.status); }
    const limit = opts.limit ? Math.max(1, Math.floor(opts.limit)) : undefined;
    const sql = `SELECT * FROM worker_tasks${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY priority DESC, created_at ASC${limit ? ` LIMIT ${limit}` : ''}`;
    return this.db.prepare(sql).all(...args) as WorkerTaskRow[];
  }

  /**
   * 原子认领：queued → preflight，attempt+1（设计稿 §13 时序第 5 步）。
   * 单条 UPDATE ... WHERE status='queued'：并发两次只有一次生效。
   * maxConcurrentWorkers 约束由 dispatcher 层用 countRunning 判定后调用（store 不做计数）。
   */
  claimSlot(taskId: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE worker_tasks SET status = 'preflight', attempt = attempt + 1, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(Date.now(), taskId);
    return r.changes === 1;
  }

  /**
   * 受状态机保护的迁移：非法边抛错（T2a 的非法迁移用例依赖此处）。
   * opts.failureKind 仅 running → failed 时合法；opts.attemptIncrement 仅
   * needs_decision → queued（裁决 retry，§7.4 attempt+1）时生效。
   */
  transition(
    taskId: string,
    to: WorkerTaskStatus,
    opts?: { failureKind?: FailureKind; attemptIncrement?: boolean; workerSessionId?: string },
  ): WorkerTaskRow {
    const row = this.get(taskId);
    if (!VALID_TRANSITIONS[row.status].includes(to)) {
      throw new Error(`非法状态迁移：${row.status} → ${to}（worker_tasks 状态机 §7.4）`);
    }
    if (opts?.failureKind && to !== 'failed') {
      throw new Error(`failure_kind 仅在迁移到 failed 时可写（当前目标：${to}）`);
    }
    if (to === 'failed' && !opts?.failureKind) {
      throw new Error('迁移到 failed 必须显式给 failure_kind');
    }
    const now = Date.now();
    const startedAt = to === 'running' ? now : row.started_at;
    const finishedAt = FINISHED_STATES.has(to) ? now : row.finished_at;
    const attempt = opts?.attemptIncrement ? row.attempt + 1 : row.attempt;
    const workerSessionId = opts?.workerSessionId !== undefined ? opts.workerSessionId : row.worker_session_id;
    this.db
      .prepare(
        `UPDATE worker_tasks SET status = ?, failure_kind = ?, attempt = ?, started_at = ?, finished_at = ?,
           worker_session_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(to, opts?.failureKind ?? row.failure_kind, attempt, startedAt, finishedAt, workerSessionId, now, taskId);
    return this.get(taskId);
  }

  /** 收敛结论（done/failed 后由 dispatcher 写入；≤400 字口径由调用方保证，§7.1）。 */
  setResult(taskId: string, resultSummary: string): void {
    this.db
      .prepare('UPDATE worker_tasks SET result_summary = ?, updated_at = ? WHERE id = ?')
      .run(resultSummary, Date.now(), taskId);
  }

  /** needs_decision 的待办内容（裁决弹窗数据源）。 */
  setDecision(taskId: string, decision: unknown): void {
    this.db
      .prepare('UPDATE worker_tasks SET decision_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(decision), Date.now(), taskId);
  }

  /** L3 只标记不改状态（§9 watchdog_flag 字段写入点；P0 无 judge 实现）。 */
  setWatchdogFlag(taskId: string, flag: 'suspect' | null): void {
    this.db
      .prepare('UPDATE worker_tasks SET watchdog_flag = ?, updated_at = ? WHERE id = ?')
      .run(flag, Date.now(), taskId);
  }

  /**
   * 占用并发槽位的任务数：preflight + running（needs_decision 不跑进程、不占槽位，§7.4）。
   * dispatcher 以此对照 maxConcurrentWorkers 决定是否继续 claimSlot。
   */
  countRunning(routerSessionId: string): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM worker_tasks
         WHERE router_session_id = ? AND status IN ('preflight', 'running')`,
      )
      .get(routerSessionId) as { n: number };
    return r.n;
  }

  /** 某时刻之后的终态任务（digest 窗口判定 / 台账完成桶）。finished_at DESC。 */
  listTerminalSince(routerSessionId: string, sinceTs: number, limit = 50): WorkerTaskRow[] {
    return this.db
      .prepare(
        `SELECT * FROM worker_tasks
         WHERE router_session_id = ? AND status IN ('done', 'failed', 'canceled') AND finished_at >= ?
         ORDER BY finished_at DESC LIMIT ${Math.max(1, Math.floor(limit))}`,
      )
      .all(routerSessionId, sinceTs) as WorkerTaskRow[];
  }

  /**
   * bootstrap 定向收敛（设计稿 §18-1：重启后把 running/preflight 且进程已不在的行标
   * failed(runtime)）。之所以不经 transition()：T1 冻结的状态机表里 preflight 只有
   * running/needs_decision 两条出边（preflight 窗口极短、正常路径不存在该迁移），
   * 而 §18-1 明确要求 bootstrap 同时收敛 preflight 行——两者冲突时以定向方法落 §18-1，
   * 不动既有状态机语义（T1 的「preflight 不可直接取消/无 failed 出边」测试保持零回归）。
   * 原子性靠 WHERE status IN (...) 守卫：已被其他路径收敛的行不会被二次改写。
   */
  failOrphaned(taskId: string, failureKind: FailureKind = 'runtime'): boolean {
    const r = this.db
      .prepare(
        `UPDATE worker_tasks SET status = 'failed', failure_kind = ?, finished_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('preflight', 'running')`,
      )
      .run(failureKind, Date.now(), Date.now(), taskId);
    return r.changes === 1;
  }
}

export interface AppendInboxInput {
  routerSessionId: string;
  taskId?: string | null;
  kind: InboxKind;
  severity: InboxSeverity;
  payload: unknown;
}

/**
 * task_inbox 表访问层（Router 待播报队列，不当日志表用——只有进入终态/needs_decision/L3 标记/digest 才写）。
 */
export class InboxStore {
  constructor(private readonly db: Database.Database) {}

  append(input: AppendInboxInput): InboxItem {
    const r = this.db
      .prepare(
        `INSERT INTO task_inbox (router_session_id, task_id, kind, severity, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.routerSessionId,
        input.taskId ?? null,
        input.kind,
        input.severity,
        JSON.stringify(input.payload ?? {}),
        Date.now(),
      );
    return this.get(Number(r.lastInsertRowid));
  }

  get(id: number): InboxItem {
    const row = this.db.prepare('SELECT * FROM task_inbox WHERE id = ?').get(id) as InboxRow | undefined;
    if (!row) throw new Error(`inbox item not found: ${id}`);
    return toInboxItem(row);
  }

  /** 未送达条目（pumpDigest C1 / 台账第 3 步 / Web 红点共用口径）。 */
  listUndelivered(routerSessionId: string, opts?: { severity?: InboxSeverity }): InboxItem[] {
    const severitySql = opts?.severity ? ' AND severity = ?' : '';
    const args: unknown[] = opts?.severity ? [routerSessionId, opts.severity] : [routerSessionId];
    const rows = this.db
      .prepare(
        `SELECT * FROM task_inbox WHERE router_session_id = ? AND delivered_at IS NULL${severitySql}
         ORDER BY id ASC`,
      )
      .all(...args) as InboxRow[];
    return rows.map(toInboxItem);
  }

  /**
   * 标记送达（§10.1 步骤 1：先标记后发送）。幂等：WHERE delivered_at IS NULL，
   * 重复调用不报错、首个 delivered_at 不被覆盖。
   */
  markDelivered(ids: number[], deliveredAt = Date.now()): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    this.db
      .prepare(`UPDATE task_inbox SET delivered_at = ? WHERE id IN (${placeholders}) AND delivered_at IS NULL`)
      .run(deliveredAt, ...ids);
  }

  /** send 失败回滚（§10.1 步骤 3）：本批条目退回未送达，等下一 tick。 */
  unmarkDelivered(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    this.db
      .prepare(`UPDATE task_inbox SET delivered_at = NULL WHERE id IN (${placeholders})`)
      .run(...ids);
  }

  /** 上次播报时间 = MAX(delivered_at)（C2/C4 的窗口判定，不需新增列，§10.1）。 */
  lastDeliveredAt(routerSessionId: string): number | null {
    const r = this.db
      .prepare('SELECT MAX(delivered_at) AS t FROM task_inbox WHERE router_session_id = ?')
      .get(routerSessionId) as { t: number | null };
    return r.t;
  }
}

/** better-sqlite3 返回的原始行（payload_json 未解析） */
type InboxRow = Omit<InboxItem, 'payload'> & { payload_json: string };

function toInboxItem(row: InboxRow): InboxItem {
  const { payload_json, ...rest } = row;
  let payload: unknown = {};
  try {
    payload = JSON.parse(payload_json) as unknown;
  } catch {
    payload = {};
  }
  return { ...rest, payload };
}

/** 应用层随机 id（不用 DB 自增，便于 dispatcher 预生成与日志追踪）。 */
function cryptoRandomId(): string {
  return `wt-${globalThis.crypto.randomUUID()}`;
}
