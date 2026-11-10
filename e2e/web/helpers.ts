/**
 * F-45 Web E2E 共享工具：通过 API 造项目/会话（UI 只验证交互面，数据准备走稳定端点）。
 */
import type { APIRequestContext, Page } from '@playwright/test';

export interface TestSession {
  projectId: string;
  sessionId: string;
  projectName: string;
}

/** 复用 serve 预注册的项目（e2e-serve 启动时 ensureProject）并新建会话 */
export async function ensureProjectAndSession(request: APIRequestContext, title = 'e2e 会话'): Promise<TestSession> {
  const list = (await (await request.get('/api/projects')).json()) as Array<{ id: string; name: string }>;
  const project = list[0];
  if (!project) throw new Error('e2e-serve 未预注册项目');
  const session = (await (
    await request.post(`/api/projects/${project.id}/sessions`, { data: { title } })
  ).json()) as { id: string };
  return { projectId: project.id, sessionId: session.id, projectName: project.name };
}

/** 打开会话：先点项目头（设置 activeProject + 展开会话列表），再点会话项 */
export async function openSession(page: Page, sessionTitle: string) {
  await page.goto('/#/');
  await page.locator('.project-header').first().click();
  const item = page.locator('.session-item', { hasText: sessionTitle }).first();
  await item.waitFor({ state: 'visible' });
  await item.click();
  await page.locator('.composer textarea').waitFor({ state: 'visible' });
}

/** 发送一条消息并等运行结束（composer 恢复可用 + 假 Provider 终文本出现） */
export async function sendAndAwait(page: Page, input: string, sessionTitle?: string) {
  const composer = page.locator('.composer textarea');
  await composer.fill(input);
  await composer.press('Enter');
  // 假 Provider scripted 模式：工具调用 + 最终文本，整链通常 < 2s；给足余量
  const done = page.getByText('E2E_FAKE_DONE').first();
  try {
    await done.waitFor({ state: 'visible', timeout: 8_000 });
  } catch {
    // SSE 订阅竞态兜底：消息已落库但 UI 可能错过流式事件 → 重载走落库渲染路径
    if (!sessionTitle) throw new Error('运行未在 8s 内完成（且无会话标题可供重载兜底）');
    await page.reload();
    await openSession(page, sessionTitle);
    await done.waitFor({ state: 'visible', timeout: 10_000 });
  }
}
