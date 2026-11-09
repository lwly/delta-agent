/**
 * P6 视图槽（进程内）：元数据登记，Web 启动时按 module 动态 import 挂路由。
 * 内置页仍走 web/builtin-views/register（含 Vue 组件）。
 */
export type ViewSlot = 'workbench-child' | 'top';

export interface ViewContributionMeta {
  name: string;
  path: string;
  slot: ViewSlot;
  /** dynamic import 目标（通常为 file URL 或已打包模块 id） */
  module: string;
}

const metas: ViewContributionMeta[] = [];

export function registerViewMeta(meta: ViewContributionMeta): void {
  if (metas.some((v) => v.name === meta.name)) throw new Error(`view already registered: ${meta.name}`);
  metas.push(meta);
}

export function viewContributionMetas(): readonly ViewContributionMeta[] {
  return metas;
}

/** 仅测试 */
export function resetViewMetasForTests(): void {
  metas.length = 0;
}
