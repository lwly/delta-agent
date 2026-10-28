// AC-45-1 ①：工作台首屏加载——品牌 / 侧栏 / hero 可见
// （composer 输入区仅在会话打开后渲染，属 chat.spec 覆盖面）
import { expect, test } from '@playwright/test';

test('工作台首屏：品牌、侧栏、hero 就绪', async ({ page }) => {
  await page.goto('/#/');
  await expect(page.locator('.brand-name')).toHaveText('delta-agent');
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.locator('.hero-logo')).toBeVisible();
  await expect(page.locator('.hero-btn', { hasText: '注册项目' })).toBeVisible();
});
