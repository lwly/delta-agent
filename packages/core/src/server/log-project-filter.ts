import type { LogEntry } from '../logging/logger.js';
import type { SessionService } from '../session/service.js';

/** T6：日志条目的项目归属——projectId 直属，或 sessionId 会话归属（全部 kind） */
export function logEntryInProject(e: LogEntry, pid: string, service: SessionService): boolean {
  if (e.projectId === pid) return true;
  return e.sessionId != null && service.getSession(e.sessionId)?.project_id === pid;
}
