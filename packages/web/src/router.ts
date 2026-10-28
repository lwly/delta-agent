import { createRouter, createWebHashHistory } from 'vue-router';

// 纯本地部署走 serve 内嵌静态托管，用 hash 路由避免 SPA fallback 之外的路径约定。
// 工作台（对齐高保真原型）：项目/会话/对话全部收敛在 '/'，记忆/配置/用量迁移至独立设置页；
// 旧 /projects /chat 路由由弹窗与侧边栏取代，旧 /memory /usage 入口重定向到设置页对应 tab。
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    // /cron 为工作台子路由：侧栏常驻，主区按路由在「定时任务页 / 对话流」间切换
    {
      path: '/',
      name: 'workbench',
      component: () => import('./views/WorkbenchView.vue'),
      children: [
        { path: 'cron', name: 'cron', component: () => import('./views/CronView.vue') },
        // F-41 运行日志页（工作台子路由，对齐 /cron 模式）
        { path: 'logs', name: 'logs', component: () => import('./views/LogsView.vue') },
      ],
    },
    { path: '/projects', redirect: '/' },
    { path: '/chat/:sessionId', redirect: '/' },
    { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') },
    { path: '/memory', redirect: { path: '/settings', query: { tab: 'memory' } } },
    { path: '/usage', redirect: { path: '/settings', query: { tab: 'usage' } } },
    {
      path: '/replay/:sessionId',
      name: 'replay',
      component: () => import('./views/ReplayView.vue'),
    },
  ],
});
