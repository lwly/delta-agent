/**
 * P6：bootstrapPluginViews 登记用户视图后，hash 路由可达并渲染桩组件。
 */
import { test, expect } from '@playwright/test';

test('用户插件视图：bootstrap 后路由可达', async ({ page }) => {
  await page.goto('/#/plugin-e2e-view');
  await expect(page.getByTestId('plugin-e2e-view')).toBeVisible();
  await expect(page.getByTestId('plugin-e2e-view')).toHaveText('plugin e2e view');
});
