/**
 * P6：拉取 GET /api/plugins，按元数据登记用户视图（须在 createAppRouter 之前）。
 */
import { api } from '../api/client';
import { registerView } from '../view-slot';

export async function bootstrapPluginViews(): Promise<void> {
  try {
    const { views } = await api.plugins();
    for (const v of views) {
      registerView({
        name: v.name,
        path: v.path,
        slot: v.slot,
        component: () => import(/* @vite-ignore */ v.module),
      });
    }
  } catch {
    // 离线 dev / 旧 server：跳过
  }
}
