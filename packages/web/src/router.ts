import { createRouter, createWebHashHistory } from 'vue-router';

// 纯本地部署走 serve 内嵌静态托管，用 hash 路由避免 SPA fallback 之外的路径约定
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/projects' },
    {
      path: '/projects',
      name: 'projects',
      component: () => import('./views/ProjectsView.vue'),
    },
    {
      path: '/chat/:sessionId',
      name: 'chat',
      component: () => import('./views/ChatView.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('./views/SettingsView.vue'),
    },
    {
      path: '/memory',
      name: 'memory',
      component: () => import('./views/MemoryView.vue'),
    },
  ],
});
