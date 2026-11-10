/**
 * P5 视图槽。工作台壳和旧地址重定向留在 shellRoutes。
 * 页面组件仍是构建期的异步 import，不在运行时编译 Vue 文件。
 */
import type { RouteRecordRaw } from 'vue-router';

export type ViewSlot = 'workbench-child' | 'top';

export interface ViewContribution {
  name: string;
  path: string;
  slot: ViewSlot;
  component: NonNullable<RouteRecordRaw['component']>;
}

const views: ViewContribution[] = [];

export function registerView(view: ViewContribution): void {
  if (views.some((v) => v.name === view.name)) throw new Error(`view already registered: ${view.name}`);
  views.push(view);
}

export function viewsBySlot(slot: ViewSlot): readonly ViewContribution[] {
  return views.filter((v) => v.slot === slot);
}

function toRecord(view: ViewContribution): RouteRecordRaw {
  return { path: view.path, name: view.name, component: view.component };
}

export function registeredViewNames(): readonly string[] {
  return views.map((v) => v.name);
}

/** 与改前 router.ts 相同的路径顺序。settings 仍夹在两条设置重定向之间。 */
export function shellRoutes(): RouteRecordRaw[] {
  const top = viewsBySlot('top');
  const settings = top.filter((v) => v.name === 'settings').map(toRecord);
  const rest = top.filter((v) => v.name !== 'settings').map(toRecord);
  return [
    {
      path: '/',
      name: 'workbench',
      component: () => import('./views/WorkbenchView.vue'),
      children: viewsBySlot('workbench-child').map(toRecord),
    },
    { path: '/projects', redirect: '/' },
    { path: '/chat/:sessionId', redirect: '/' },
    ...settings,
    { path: '/memory', redirect: { path: '/settings', query: { tab: 'memory' } } },
    { path: '/logs', redirect: { path: '/settings', query: { tab: 'logs' } } },
    ...rest,
  ];
}
