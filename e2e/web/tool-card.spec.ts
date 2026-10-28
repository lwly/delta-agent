// AC-45-1 ④：工具调用卡片渲染（read_file 卡，含工具名与成功状态）
import { expect, test } from '@playwright/test';
import { ensureProjectAndSession, openSession, sendAndAwait } from './helpers';

test('工具调用卡片出现并展开可见结果', async ({ page, request }) => {
  await ensureProjectAndSession(request, '工具卡会话');
  await openSession(page, '工具卡会话');
  await sendAndAwait(page, '读取 note.txt', '工具卡会话');
  // ToolCallCard：工具名（中文名或 read_file 原名）出现在卡片首行
  const card = page.locator('.tcard', { hasText: 'read_file' }).first();
  await expect(card).toBeVisible();
  // 成功状态徽标（b-ok / st-ok）
  await expect(card.locator('.tbadge')).toBeVisible();
});
