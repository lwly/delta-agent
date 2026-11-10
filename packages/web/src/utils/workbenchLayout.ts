/** 工作台子路由：主区不含左侧 SessionSidebar（见 WorkbenchView isSubRoute） */
export const WORKBENCH_CHILD_PATHS = ['/cron', '/usage'] as const;

export function isWorkbenchSubRoute(path: string): boolean {
  return WORKBENCH_CHILD_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

export function showWorkbenchSessionSidebar(path: string): boolean {
  return !isWorkbenchSubRoute(path);
}
