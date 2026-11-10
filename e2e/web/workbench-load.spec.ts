// AC-45-1 ①：工作台 / 委派任务 / 项目管理首屏就绪
import { expect, test } from '@playwright/test';

test('工作台首屏：品牌、委派页、项目管理侧栏就绪', async ({ page }) => {
  await page.goto('/#/');
  await expect(page.locator('.empty-title')).toHaveText('工作台');
  await page.goto('/#/tasks');
  await expect(page.locator('.home-slogan')).toContainText('把工作交出去');
  await expect(page.locator('.home-composer')).toBeVisible();
  await expect(page.locator('.home-executor')).toBeVisible();
  await expect(page.locator('.home-executor')).toContainText('内置助手');
  await page.goto('/#/projects');
  await expect(page.locator('.brand-name')).toHaveText('Delta-Agent');
  await expect(page.locator('.sidebar')).toBeVisible();
});
