// F-53（AC-53-1）：5000 条消息大会话的性能预算用例。
// 前置：e2e-serve 以 E2E_SEED_MESSAGES=5000 启动（package.json `e2e:perf` 注入）。
// 预算口径：
// - 首屏预算：点开会话 → 消息可见 ≤ 8s（含一次 50 条分页 + 渲染；CI 弱机余量按 5×实测给）
// - DOM 上界：窗口化渲染下 .msg 节点恒 < WINDOW+STEP（首屏 ≤ 60，与消息总量无关）
// - 交互可用：「载入更早消息」可展开窗口且消息数增长
import { expect, test } from '@playwright/test';

const SEED_TITLE = process.env.E2E_SEED_SESSION_TITLE ?? '性能基准会话';

// 常规套件（无 E2E_SEED_MESSAGES）自动跳过本文件；性能口径跑法见 issue PASI-21 交付摘要。
test.beforeEach(async ({ request }) => {
  const projects = (await (await request.get('/api/projects')).json()) as Array<{ id: string }>;
  const pid = projects[0]?.id;
  const sessions = pid
    ? ((await (await request.get(`/api/projects/${pid}/sessions?limit=200`)).json()) as {
        sessions: Array<{ title: string }>;
      }).sessions
    : [];
  test.skip(!sessions.some((s) => s.title === SEED_TITLE), 'serve 未以 E2E_SEED_MESSAGES=5000 启动，跳过性能用例');
});

test('5000 消息会话：首屏预算 + DOM 上界 + 载入更早', async ({ page }) => {
  await page.goto('/#/');
  await page.locator('.project-header').first().click();
  const item = page.locator('.session-item', { hasText: SEED_TITLE }).first();
  await item.waitFor({ state: 'visible' });

  // ── 首屏预算 ──
  const t0 = Date.now();
  await item.click();
  await page.locator('.msg').first().waitFor({ state: 'visible' });
  const elapsed = Date.now() - t0;
  expect(elapsed, `首屏（点击会话 → 消息可见）${elapsed}ms 超出 8000ms 预算`).toBeLessThan(8000);

  // ── DOM 上界（窗口化渲染：与 5000 总量无关） ──
  const msgCount = await page.locator('.chat-scroll .msg').count();
  expect(msgCount, '首屏 .msg 节点数应 ≤ 60（首屏一页 50 + 少量实时卡）').toBeLessThanOrEqual(60);
  // 首屏展示的是最近一页：最后一条消息可见（默认滚到底）
  await expect(page.locator('.chat-scroll .msg').last()).toBeVisible();

  // ── 载入更早：窗口展开 → 消息数增长 ──
  const olderBtn = page.locator('.load-older-row button');
  await expect(olderBtn).toBeVisible(); // hiddenCount = 5000 - 120 > 0
  await olderBtn.click();
  await page.waitForFunction(
    (n) => document.querySelectorAll('.chat-scroll .msg').length > n,
    msgCount,
    { timeout: 5000 },
  );
  const expanded = await page.locator('.chat-scroll .msg').count();
  expect(expanded, '展开后 DOM 仍应有界（< 210）').toBeLessThan(210);
});
