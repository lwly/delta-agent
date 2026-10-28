// AC-45-1 ⑥：回放页——任务列表（runs）与时间线渲染
import { expect, test } from '@playwright/test';
import { ensureProjectAndSession, openSession, sendAndAwait } from './helpers';

test('回放页展示任务记录', async ({ page, request }) => {
  const { sessionId } = await ensureProjectAndSession(request, '回放会话');
  await openSession(page, '回放会话');
  await sendAndAwait(page, '回放这条任务的执行轨迹', '回放会话');
  await page.goto(`/#/replay/${sessionId}`);
  await expect(page.locator('.page .head')).toBeVisible();
  // 左侧任务列表有该任务（user 消息预览）
  await expect(page.locator('.runs .run', { hasText: '回放这条任务' })).toBeVisible();
});
