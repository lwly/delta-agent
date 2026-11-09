/**
 * 架构收口 T5 —— CanonicalRunStatus 状态映射（读时归一）。
 *
 * 职责：把 4 套既有任务状态机（Plan 节点 tasks 表 / 委派 worker_tasks 表 /
 * 定时 cron 运行记录 / 会话内后台命令）的状态映射到 shared 的 CanonicalRunStatus，
 * 供项目级 activity 聚合端点（/api/projects/:id/activity）与 SSE 通道统一口径。
 *
 * 约束（收口红线）：
 *  - 纯函数、无状态、无 IO——映射层只做读时归一，**不合并 tasks / worker_tasks 两张表**；
 *  - 不改 AgentEvent 联合类型；
 *  - 每个输入枚举值都必须有映射（判据 1：无 undefined / unknown）；
 *    未知输入（防御分支）落到 'pending'，绝不返回枚举外的值。
 *
 * 规则表（评审裁决口径）：
 *   completed | done          → succeeded
 *   failed | error | timeout
 *   | budget_exhausted | max_turns → failed
 *   aborted | killed | canceled → canceled
 *   needs_decision            → needs_input
 *   queued                    → queued
 *   draft | preflight         → pending（尚未真正开跑）
 *   running                   → running
 */
import type { CanonicalRunStatus } from '@delta/shared';

/** 未知/非法输入的兜底值（绝不抛错、绝不返回枚举外值） */
const FALLBACK: CanonicalRunStatus = 'pending';

/** Plan 节点任务（tasks 表，session/tasks.ts：queued → running → completed|failed|canceled） */
export type PlanTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';

/** 委派任务（worker_tasks，router/types.ts：draft|queued|preflight|running|needs_decision|done|failed|canceled） */
export type WorkerTaskMachineStatus =
  | 'draft'
  | 'queued'
  | 'preflight'
  | 'running'
  | 'needs_decision'
  | 'done'
  | 'failed'
  | 'canceled';

/** 定时任务运行记录（cron/store.ts CronRunRecord.status） */
export type CronRunMachineStatus =
  | 'completed'
  | 'failed'
  | 'max_turns'
  | 'budget_exhausted'
  | 'aborted'
  | 'timeout'
  | 'error';

/** 会话内后台命令（session/background-tasks.ts BackgroundTaskStatus） */
export type BgTaskMachineStatus = 'running' | 'done' | 'failed' | 'killed';

const PLAN_TABLE: Record<string, CanonicalRunStatus> = {
  queued: 'queued',
  running: 'running',
  completed: 'succeeded',
  failed: 'failed',
  canceled: 'canceled',
};

const WORKER_TABLE: Record<string, CanonicalRunStatus> = {
  draft: 'pending',
  queued: 'queued',
  preflight: 'pending', // 运行前探测门禁，尚未开跑
  running: 'running',
  needs_decision: 'needs_input',
  done: 'succeeded',
  failed: 'failed',
  canceled: 'canceled',
};

const CRON_TABLE: Record<string, CanonicalRunStatus> = {
  completed: 'succeeded',
  failed: 'failed',
  max_turns: 'failed',
  budget_exhausted: 'failed',
  timeout: 'failed',
  error: 'failed',
  aborted: 'canceled',
};

const BG_TABLE: Record<string, CanonicalRunStatus> = {
  running: 'running',
  done: 'succeeded',
  failed: 'failed',
  killed: 'canceled',
};

export function fromPlanTask(status: PlanTaskStatus | string | undefined): CanonicalRunStatus {
  if (status === undefined) return FALLBACK;
  return PLAN_TABLE[status] ?? FALLBACK;
}

export function fromWorkerTask(status: WorkerTaskMachineStatus | string | undefined): CanonicalRunStatus {
  if (status === undefined) return FALLBACK;
  return WORKER_TABLE[status] ?? FALLBACK;
}

/**
 * 定时任务：运行记录状态映射。
 * lastRun 缺失（从未运行）→ pending；运行中（runningSince 锁在）由调用方直接给 'running'，
 * 本函数只负责已落记录的状态翻译。
 */
export function fromCronRun(status: CronRunMachineStatus | string | undefined): CanonicalRunStatus {
  if (status === undefined) return FALLBACK;
  return CRON_TABLE[status] ?? FALLBACK;
}

export function fromBgTask(status: BgTaskMachineStatus | string | undefined): CanonicalRunStatus {
  if (status === undefined) return FALLBACK;
  return BG_TABLE[status] ?? FALLBACK;
}

/** 项目级 activity 聚合条目（payload 只含标识与状态，不含消息正文——收口 T5 裁决） */
export interface ActivityItem {
  /** 实体类别（4 套状态机各归一类） */
  entity: 'plan_task' | 'worker_task' | 'cron_job' | 'bg_task';
  /** 实体 id（tasks.id / worker_tasks.id / cron.json job id / 后台命令 id） */
  id: string;
  status: CanonicalRunStatus;
  /** 最近状态变更时刻（ISO） */
  updated_at: string;
  /** 关联会话（plan/worker/bg 任务各有；cron 任务无会话维度） */
  session_id?: string;
}
