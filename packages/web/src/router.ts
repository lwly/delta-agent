import { createRouter, createWebHashHistory } from 'vue-router';

// 纯本地部署走 serve 内嵌静态托管，用 hash 路由避免 SPA fallback 之外的路径约定。
// 工作台（对齐高保真原型）：项目/会话/对话/记忆/配置/用量全部收敛在 '/'，
// 旧 /projects /chat /settings /memory /usage 路由由弹窗与侧边栏取代。
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'workbench', component: () => import('./views/WorkbenchView.vue') },
    { path: '/projects', redirect: '/' },
    { path: '/chat/:sessionId', redirect: '/' },
    { path: '/settings', redirect: '/' },
    { path: '/memory', redirect: '/' },
    { path: '/usage', redirect: '/' },
    {
      path: '/replay/:sessionId',
      name: 'replay',
      component: () => import('./views/ReplayView.vue'),
    },
  ],
});
