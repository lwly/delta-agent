// AC-45-1 ①：工作台首屏加载——品牌 / 侧栏 / 轻首页（委派式）就绪
// 轻首页形态：slogan + 输入即派任务 composer（.home-composer）；无项目时提示先注册
// （composer 会话输入区仅在会话打开后渲染，属 chat.spec 覆盖面）
import { expect, test } from '@playwright/test';

test('工作台首屏：品牌、侧栏、轻首页就绪', async ({ page }) => {
  await page.goto('/#/');
  await expect(page.locator('.brand-name')).toHaveText('Delta-Agent');
  await expect(page.locator('.sidebar')).toBeVisible();
  // 轻首页：slogan + 派任务输入卡 + 助手选择器（默认内置助手）
  await expect(page.locator('.home-slogan')).toContainText('把工作交出去');
  await expect(page.locator('.home-composer')).toBeVisible();
  await expect(page.locator('.home-executor')).toBeVisible();
  await expect(page.locator('.home-executor')).toContainText('内置助手');
});
