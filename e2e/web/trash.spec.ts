// AC-45-1 ⑧：删除会话 → 回收站（软删除口径）
import { expect, test } from '@playwright/test';
import { ensureProjectAndSession, openSession } from './helpers';

test('删除会话进入回收站', async ({ page, request }) => {
  await ensureProjectAndSession(request, '待删除会话');
  await openSession(page, '待删除会话');
  // 会话项 ✕（title=删除会话（软删除））→ 确认弹窗 → 移除（软删除）
  const del = page.locator('.session-item .item-del[title*="删除会话"]').first();
  await del.click();
  await page.locator('.danger-btn', { hasText: '移除（软删除）' }).click();
  // 侧栏不再展示该会话；回收站入口仍在（软删除 30 天）
  await expect(page.locator('.session-item', { hasText: '待删除会话' })).toHaveCount(0);
  await expect(page.locator('.footer-secondary', { hasText: '回收站' })).toBeVisible();
});
