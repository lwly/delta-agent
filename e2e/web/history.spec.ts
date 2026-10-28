// AC-45-1 ⑤：刷新后历史仍在（消息持久化 → 重载渲染）
import { expect, test } from '@playwright/test';
import { ensureProjectAndSession, openSession, sendAndAwait } from './helpers';

test('刷新后消息历史保留', async ({ page, request }) => {
  await ensureProjectAndSession(request, '持久化会话');
  await openSession(page, '持久化会话');
  await sendAndAwait(page, '这条消息刷新后还在', '持久化会话');
  await page.reload();
  await openSession(page, '持久化会话');
  await expect(page.locator('.msg-user', { hasText: '这条消息刷新后还在' })).toBeVisible();
  await expect(page.locator('.msg-ai', { hasText: 'E2E_FAKE_DONE' }).first()).toBeVisible();
});
