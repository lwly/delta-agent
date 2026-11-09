/**
 * F-59 项目作用域过滤纯函数：定时任务（cwd 归属）与运行日志（sessionId 归属）共用。
 * 语义：任务 cwd = 项目根或位于其子目录内视为归属；日志条目须携带 sessionId 且命中项目会话集合。
 */

/** cron 任务运行目录是否落在项目根内（根本身 / 子目录；不做 .. 归一化，与存储原值直接比对） */
export function cwdInRoot(cwd: string, root: string): boolean {
  if (!cwd || !root) return false;
  return cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** 日志条目是否属于项目：必须携带 sessionId 且命中该项目的会话 id 集合（无会话维度的全局条目不算） */
export function logEntryInProject(sessionId: string | null | undefined, projectSessionIds: Set<string>): boolean {
  return sessionId != null && projectSessionIds.has(sessionId);
}
