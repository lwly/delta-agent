import { createRouter, createWebHashHistory } from 'vue-router';
import { shellRoutes } from './view-slot';

// 纯本地部署走 serve 内嵌静态托管，用 hash 路由避免 SPA fallback 之外的路径约定。
// 工作台（对齐高保真原型）：项目/会话/对话全部收敛在 '/'，记忆/配置/用量迁移至独立设置页；
// 旧 /projects /chat 路由由弹窗与侧边栏取代，旧 /memory 重定向到设置；/logs 重定向到设置·运行日志；用量走 /usage 子路由。
export function createAppRouter() {
  return createRouter({
    history: createWebHashHistory(),
    routes: shellRoutes(),
  });
}
