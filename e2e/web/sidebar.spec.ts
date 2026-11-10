// AC-45-1 ②：API 建项目 + 会话 → 侧栏项目组与会话项出现
import { expect, test } from '@playwright/test';
import { ensureProjectAndSession } from './helpers';

test('侧栏展示项目与会话', async ({ page, request }) => {
  const { projectName, sessionId } = await ensureProjectAndSession(request, '侧栏可见会话');
  await page.goto('/#/');
  await expect(page.locator('.project-name', { hasText: projectName }).first()).toBeVisible();
  // 项目组默认折叠（仅 active 项目展开）——点开项目头
  await page.locator('.project-header', { hasText: projectName }).first().click();
  await expect(page.locator('.session-item', { hasText: '侧栏可见会话' })).toBeVisible();
  void sessionId;
});
