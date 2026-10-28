// AC-45-1 ③：发消息 → 假 Provider 流式回复 → 助手文本与用户消息渲染
import { expect, test } from '@playwright/test';
import { ensureProjectAndSession, openSession, sendAndAwait } from './helpers';

test('发送消息获得助手回复', async ({ page, request }) => {
  const { sessionId } = await ensureProjectAndSession(request, '对话流会话');
  await openSession(page, '对话流会话');
  await sendAndAwait(page, '帮我读一下 note.txt', '对话流会话');
  // 用户消息与助手最终文本都在消息流中
  await expect(page.locator('.msg-user', { hasText: '帮我读一下 note.txt' })).toBeVisible();
  await expect(page.locator('.msg-ai', { hasText: 'E2E_FAKE_DONE' }).first()).toBeVisible();
  // 运行结束：composer 恢复可用
  await expect(page.locator('.composer textarea')).toBeEnabled();
  void sessionId;
});
