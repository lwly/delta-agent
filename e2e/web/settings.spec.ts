// AC-45-1 ⑦：设置页分区切换——含 F-42 新增「路由」面板
import { expect, test } from '@playwright/test';

test('设置页分区切换与路由面板', async ({ page }) => {
  await page.goto('/#/settings');
  await expect(page.locator('.title')).toHaveText('设置');
  // 默认记忆分区
  await expect(page.locator('.content')).toBeVisible();
  // 切到路由分区
  await page.locator('.nav-item', { hasText: '路由' }).click();
  await expect(page.locator('.block h4', { hasText: '模型路由' })).toBeVisible();
  // 路由面板关键元素：总开关 + 添加规则行
  await expect(page.locator('.switch input[type="checkbox"]')).toBeVisible();
  await expect(page.locator('.add-row')).toBeVisible();
  // 切到配置分区再切回，URL query 保持
  await page.locator('.nav-item', { hasText: '配置' }).click();
  await expect(page).toHaveURL(/tab=providers/);
});
