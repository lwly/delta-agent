/**
 * P6：e2e-serve 预置用户插件时，/api/plugins 暴露视图元数据（Web bootstrapPluginViews 消费）。
 */
import { test, expect } from '@playwright/test';

test('GET /api/plugins 含用户视图元数据', async ({ request }) => {
  const res = await request.get('/api/plugins');
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as {
    plugins: Array<{ id: string; status: string }>;
    views: Array<{ name: string; path: string; module: string }>;
  };
  expect(body.plugins.some((p) => p.id === 'e2e-serve' && p.status === 'loaded')).toBe(true);
  const view = body.views.find((v) => v.name === 'plugin-e2e-view');
  expect(view?.path).toBe('/plugin-e2e-view');
  expect(view?.module).toBe('/e2e-plugin-view.mjs');
});
