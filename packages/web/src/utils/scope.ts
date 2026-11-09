/**
 * 【legacy 标注 · 架构收口 T6】本文件是 F-59 的**前端 cwd 前缀可见性过滤**实现。
 * T6 已将 cron / 日志作用域后端化（`?project_id=` 参数），新代码不再依赖本文件的
 * cwd 匹配做主过滤路径；函数保留兼容与单测，待 T8 路由表收口后评估下线。
 * 见 docs/architecture-glossary.md §10-①。
 */

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

/** T6 新增：projectId 归属匹配（后端 `?project_id=` 过滤口径的纯函数镜像，供单测与 UI 辅助判断） */
export function projectIdMatches(projectId: string | null | undefined, pid: string): boolean {
  return projectId != null && projectId === pid;
}
