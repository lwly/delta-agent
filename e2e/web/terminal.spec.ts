// AC-47-6 E2E：内嵌终端打开 / 执行 / 断线重连（pty 不可用环境自动 skip——与 F-30 无 Docker skip 同口径）
import { expect, test } from '@playwright/test';
import { ensureProjectAndSession, openSession } from './helpers';

test('内置终端：打开 → 执行命令 → 重载后回放', async ({ page, request }) => {
  // 能力探测：node-pty 不可用（如沙箱禁 pty fork）→ 跳过，不误报
  const st = await request.get('/api/terminal/status');
  const status = (await st.json()) as { available: boolean };
  test.skip(!status.available, '终端能力不可用（node-pty 缺失或环境禁 pty），跳过');
  await ensureProjectAndSession(request, '终端会话');
  await openSession(page, '终端会话');

  // 1. 打开面板：工作根与警示条可见
  await page.locator('.tool-chip', { hasText: '🖥 终端' }).click();
  await expect(page.locator('.term-pane')).toBeVisible();
  await expect(page.locator('.term-warn', { hasText: '直接执行，不经 Agent 确认' })).toBeVisible();
  await page.locator('.term-root').waitFor({ state: 'visible', timeout: 10_000 });

  // 2. 执行命令：xterm 输入回显命令与输出
  const termInput = page.locator('.xterm-helper-textarea');
  await termInput.focus();
  await termInput.input('echo delta-e2e-terminal');
  await termInput.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('delta-e2e-terminal', { timeout: 10_000 });

  // 3. 重载重连：pty 保留 + 环形缓冲回放，历史输出仍可见
  await page.reload();
  await openSession(page, '终端会话');
  await page.locator('.tool-chip', { hasText: '🖥 终端' }).click();
  await expect(page.locator('.xterm-rows')).toContainText('delta-e2e-terminal', { timeout: 15_000 });

  // 4. 关闭面板
  await page.locator('.term-btn', { hasText: '✕' }).click();
  await expect(page.locator('.term-pane')).toHaveCount(0);
});
