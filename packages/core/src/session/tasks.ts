/**
 * 任务持久化与可靠恢复（agent-modes-design §6）
 * 状态机：queued → running → completed | failed | canceled
 *         running --租约过期/心跳丢失（崩溃恢复）--> queued（孤儿重排，retries+1）
 * 口诀：状态落库 + 租约心跳，让任务崩溃后可恢复。
 */
import type { Plan, TaskNode } from '@y-zero/shared';
import type Database from 'better-sqlite3';

export const LEASE_MS = 60_000;
export const HEARTBEAT_MS = 15_000;

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';

export interface TaskRow {
  id: string;
  session_id: string;
  plan_revision: number;
  node_id: string;
  node_json: string;
  status: TaskStatus;
  worker_id: string | null;
  lease_until: number | null;
  heartbeat_at: number | null;
  retries: number;
  checkpoint_json: string | null;
  result: string | null;
  updated_at: number;
}

/** 任务 id：会话内节点唯一（重规划时覆盖 node_json 并回 queued）。 */
export function taskId(sessionId: string, nodeId: string): string {
  return `${sessionId}:${nodeId}`;
}

/**
 * TaskStore：与 SessionStore 同库（复用其 SQLite 连接），原子状态迁移。
 */
export class TaskStore {
  constructor(private readonly db: Database.Database) {}

  /** 计划落库（重规划时 revision 覆盖并将节点回 queued，retries 清零）。 */
  createPlan(sessionId: string, plan: Plan): void {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      for (const node of plan.nodes) {
        this.db
          .prepare(
            `INSERT INTO tasks (id, session_id, plan_revision, node_id, node_json, status, worker_id, lease_until, heartbeat_at, retries, updated_at)
             VALUES (?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, 0, ?)
             ON CONFLICT(id) DO UPDATE SET
               node_json = excluded.node_json,
               plan_revision = excluded.plan_revision,
               status = 'queued',
               worker_id = NULL,
               lease_until = NULL,
               heartbeat_at = NULL,
               result = NULL,
               updated_at = excluded.updated_at`,
          )
          .run(taskId(sessionId, node.id), sessionId, plan.revision, node.id, JSON.stringify(node), now);
      }
    });
    tx();
  }

  get(sessionId: string, nodeId: string): TaskRow | undefined {
    return this.db
      .prepare('SELECT * FROM tasks WHERE id = ?')
      .get(taskId(sessionId, nodeId)) as TaskRow | undefined;
  }

  list(sessionId: string): TaskRow[] {
    return this.db
      .prepare('SELECT * FROM tasks WHERE session_id = ? ORDER BY node_id ASC')
      .all(sessionId) as TaskRow[];
  }

  /** worker 竞争领取：queued → running（带租约）。返回是否领取成功。 */
  claim(sessionId: string, nodeId: string, workerId: string, leaseMs = LEASE_MS): boolean {
    const now = Date.now();
    const r = this.db
      .prepare(
        `UPDATE tasks SET status = 'running', worker_id = ?, lease_until = ?, heartbeat_at = ?, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(workerId, now + leaseMs, now, now, taskId(sessionId, nodeId));
    return r.changes > 0;
  }

  /** 心跳 + 续租（仅运行中且 worker 匹配时生效）。 */
  heartbeat(sessionId: string, nodeId: string, workerId: string, leaseMs = LEASE_MS): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE tasks SET heartbeat_at = ?, lease_until = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND worker_id = ?`,
      )
      .run(now, now + leaseMs, now, taskId(sessionId, nodeId), workerId);
  }

  /** 幂等 checkpoint：已完成步骤/文件变更清单（重试前可回滚或跳过）。 */
  checkpoint(sessionId: string, nodeId: string, checkpoint: unknown): void {
    this.db
      .prepare('UPDATE tasks SET checkpoint_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(checkpoint), Date.now(), taskId(sessionId, nodeId));
  }

  complete(sessionId: string, nodeId: string, result: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE tasks SET status = 'completed', result = ?, lease_until = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(result, now, taskId(sessionId, nodeId));
  }

  fail(sessionId: string, nodeId: string, retries: number, error: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE tasks SET status = 'failed', retries = ?, result = ?, lease_until = NULL, worker_id = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(retries, error, now, taskId(sessionId, nodeId));
  }

  /** 重试回队：failed → queued（retries 保留，供上限判断）。 */
  requeue(sessionId: string, nodeId: string): boolean {
    const now = Date.now();
    const r = this.db
      .prepare(
        `UPDATE tasks SET status = 'queued', worker_id = NULL, lease_until = NULL, updated_at = ?
         WHERE id = ? AND status = 'failed'`,
      )
      .run(now, taskId(sessionId, nodeId));
    return r.changes > 0;
  }

  skip(sessionId: string, nodeId: string, reason: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE tasks SET status = 'failed', result = ?, lease_until = NULL, worker_id = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(`skipped: ${reason}`, now, taskId(sessionId, nodeId));
  }

  /** 用户取消/会话删除级联：运行中与排队中的任务全部 canceled。 */
  cancelSession(sessionId: string): number {
    const now = Date.now();
    const r = this.db
      .prepare(
        `UPDATE tasks SET status = 'canceled', lease_until = NULL, worker_id = NULL, updated_at = ?
         WHERE session_id = ? AND status IN ('queued', 'running')`,
      )
      .run(now, sessionId);
    return r.changes;
  }

  /**
   * 崩溃恢复：running 且租约过期 → 视为孤儿，回 queued（retries+1）。
   * 启动时调用（不传 sessionId 则全库扫描）。
   */
  recoverOrphans(sessionId?: string): number {
    const now = Date.now();
    const rows = (
      sessionId
        ? this.db.prepare(`SELECT id, worker_id FROM tasks WHERE session_id = ? AND status = 'running'`).all(sessionId)
        : this.db.prepare(`SELECT id, worker_id FROM tasks WHERE status = 'running'`).all()
    ) as Array<{ id: string; worker_id: string | null }>;
    let n = 0;
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const lease = this.db.prepare('SELECT lease_until FROM tasks WHERE id = ?').get(row.id) as
          | { lease_until: number | null }
          | undefined;
        if (!lease || lease.lease_until === null || lease.lease_until <= now) {
          this.db
            .prepare(
              `UPDATE tasks SET status = 'queued', worker_id = NULL, lease_until = NULL, heartbeat_at = NULL,
               retries = retries + 1, updated_at = ? WHERE id = ?`,
            )
            .run(now, row.id);
          n++;
        }
      }
    });
    tx();
    return n;
  }

  /** 恢复排队任务（启动/续跑时重建调度队列）。 */
  pendingNodes(sessionId: string): TaskNode[] {
    return (this.list(sessionId) as TaskRow[])
      .filter((r) => r.status === 'queued')
      .map((r) => JSON.parse(r.node_json) as TaskNode);
  }
}
