import type { WorkerTaskStatus } from '../api/client';

/** Worker 任务状态中文（任务台 / 详情面板共用） */
export const WORKER_TASK_STATUS_LABEL: Record<WorkerTaskStatus, string> = {
  draft: '草稿',
  queued: '排队中',
  preflight: '预检中',
  running: '运行中',
  needs_decision: '待裁决',
  done: '已完成',
  failed: '失败',
  canceled: '已取消',
};

/** 可调 POST /api/worker-tasks/:id/cancel 的状态 */
export function workerTaskCanCancel(status: WorkerTaskStatus): boolean {
  return status === 'queued' || status === 'preflight' || status === 'running' || status === 'needs_decision';
}
