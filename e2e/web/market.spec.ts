// F-52 AC-52-5：市场面板——内置清单浏览 / 一键安装 / MCP 页签 / 旧 tab=hub 兼容映射
import { expect, test } from '@playwright/test';

test('市场面板：浏览内置清单并一键安装 Skill', async ({ page }) => {
  await page.goto('/#/settings?tab=market');
  await expect(page.locator('.panel-title')).toHaveText('🛒 市场');
  // Skills 页签默认激活：内置 code-review 卡片可见
  const card = page.locator('.card', { hasText: 'code-review' }).first();
  await expect(card).toBeVisible();
  // 一键安装到用户级（内置条目无 scripts，无需二次确认；已装则语义为覆盖重装）
  await card.locator('button').filter({ hasText: /安装到用户级|覆盖重装/ }).first().click();
  await expect(page.locator('.notice')).toContainText('已安装「code-review」');
  // 安装后出现卸载入口（重装按钮语义）
  await expect(card.locator('button', { hasText: '卸载用户级' })).toBeVisible();
});

test('市场面板：MCP 页签与旧 tab=hub 兼容映射', async ({ page }) => {
  await page.goto('/#/settings?tab=market');
  // 切到 MCP Server 页签：内置 everything 条目可见（含连通测试说明）
  await page.locator('.tab', { hasText: 'MCP Server' }).click();
  await expect(page.locator('.card', { hasText: 'everything' })).toBeVisible();
  // 旧 ?tab=hub 映射到市场面板（F-52 面板替换 Skill Hub 后的兼容口径）
  await page.goto('/#/settings?tab=hub');
  await expect(page.locator('.panel-title')).toHaveText('🛒 市场');
});
