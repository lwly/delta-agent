/**
 * P5 内置视图登记。由 router 在 shellRoutes 前侧载；勿重复 import。
 */
import { registerView } from '../view-slot.js';

registerView({
  name: 'cron',
  path: 'cron',
  slot: 'workbench-child',
  component: () => import('../views/CronView.vue'),
});
registerView({
  name: 'usage',
  path: 'usage',
  slot: 'workbench-child',
  component: () => import('../views/UsageView.vue'),
});
registerView({
  name: 'settings',
  path: '/settings',
  slot: 'top',
  component: () => import('../views/SettingsView.vue'),
});
registerView({
  name: 'replay',
  path: '/replay/:sessionId',
  slot: 'top',
  component: () => import('../views/ReplayView.vue'),
});
registerView({
  name: 'projects',
  path: '/projects',
  slot: 'top',
  component: () => import('../views/ProjectsView.vue'),
});
registerView({
  name: 'tasks',
  path: '/tasks',
  slot: 'top',
  component: () => import('../views/TasksView.vue'),
});
