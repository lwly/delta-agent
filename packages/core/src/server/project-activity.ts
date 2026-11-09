import { loadCronJobs } from '../cron/store.js';
import { fromPlanTask, fromWorkerTask, fromCronRun, fromBgTask, type ActivityItem } from '../run-status.js';
import type { SessionService } from '../session/service.js';
import type { BackgroundTaskManager } from '../session/background-tasks.js';

export interface CollectProjectActivityDeps {
  service: SessionService;
  cronHomeDir?: string;
  backgroundTasks?: BackgroundTaskManager;
}

/** T5：项目级 activity 聚合（CanonicalRunStatus 读时归一；不合并 tasks/worker_tasks 表） */
export function collectProjectActivity(deps: CollectProjectActivityDeps, pid: string): ActivityItem[] {
  const { service, cronHomeDir, backgroundTasks } = deps;
  const items: ActivityItem[] = [];
  for (const row of service.workerTasks.list({ projectId: pid })) {
    items.push({
      entity: 'worker_task',
      id: row.id,
      status: fromWorkerTask(row.status),
      updated_at: new Date(row.updated_at).toISOString(),
      ...(row.worker_session_id ? { session_id: row.worker_session_id } : {}),
    });
  }
  for (const s of service.listSessions(pid)) {
    for (const t of service.tasks.list(s.id)) {
      items.push({
        entity: 'plan_task',
        id: t.id,
        status: fromPlanTask(t.status),
        updated_at: new Date(t.updated_at).toISOString(),
        session_id: s.id,
      });
    }
  }
  const { jobs } = loadCronJobs(cronHomeDir, {
    projectRoots: service.listProjects().map((p) => ({ id: p.id, root: p.root_path })),
  });
  for (const j of jobs) {
    if (j.projectId !== pid) continue;
    items.push({
      entity: 'cron_job',
      id: j.id,
      status: j.runningSince ? 'running' : fromCronRun(j.lastRun?.status),
      updated_at: j.lastRun?.finishedAt ?? j.updatedAt,
    });
  }
  const sessionIds = new Set(service.listSessions(pid).map((s) => s.id));
  for (const b of backgroundTasks?.list() ?? []) {
    if (!sessionIds.has(b.session_id)) continue;
    items.push({
      entity: 'bg_task',
      id: b.id,
      status: fromBgTask(b.status),
      updated_at: new Date(b.finished_at ?? b.started_at).toISOString(),
      session_id: b.session_id,
    });
  }
  return items;
}
