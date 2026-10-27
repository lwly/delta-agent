/**
 * chat store 待决策卡队列行为测试（无 DOM、无后端：mock api/client，node 环境可跑）
 *
 * 覆盖（问题1/5修复：单槽 → 队列）：
 * - 同轮多个 confirm_request 全部入队渲染，后到不覆盖先到
 * - decideConfirm 按 id 精确回填并出队（允许先回填第二张卡）
 * - plan_approval_request / ask_user 同样入队、按 requestId 独立回填
 * - SSE 重放去重（同 id 不重复入队）
 * - 运行结束（state running=false）清空全部待决策卡
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  approvePlan: vi.fn(),
  answer: vi.fn(),
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});
vi.mock('../api/sse', () => ({ subscribeSession: () => () => undefined }));

import { useChatStore } from './chat';

const REQ_A = { id: 'call_a', tool: 'run_command', args: {}, reason: 'r-a' };
const REQ_B = { id: 'call_b', tool: 'write_file', args: {}, reason: 'r-b' };

beforeEach(() => {
  setActivePinia(createPinia());
  for (const m of Object.values(mocks)) m.mockReset();
});

describe('chat store 待决策卡队列', () => {
  it('多个 confirm_request 全部入队，后到不覆盖先到', () => {
    const chat = useChatStore();
    chat.onEvent({ type: 'confirm_request', request: REQ_A });
    chat.onEvent({ type: 'confirm_request', request: REQ_B });
    expect(chat.pendingConfirms.map((p) => p.id)).toEqual(['call_a', 'call_b']);
  });

  it('SSE 重放按 id 去重', () => {
    const chat = useChatStore();
    chat.onEvent({ type: 'confirm_request', request: REQ_A });
    chat.onEvent({ type: 'confirm_request', request: REQ_A });
    expect(chat.pendingConfirms).toHaveLength(1);
  });

  it('decideConfirm 按 id 精确回填并出队（可先回填第二张卡）', async () => {
    const chat = useChatStore();
    chat.sessionId = 's-1';
    chat.onEvent({ type: 'confirm_request', request: REQ_A });
    chat.onEvent({ type: 'confirm_request', request: REQ_B });

    await chat.decideConfirm('call_b', { kind: 'allow' });
    expect(mocks.confirm).toHaveBeenCalledWith('s-1', 'call_b', { kind: 'allow' });
    expect(chat.pendingConfirms.map((p) => p.id)).toEqual(['call_a']);

    await chat.decideConfirm('call_b', { kind: 'reject' }); // 已出队：不再回填
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
  });

  it('plan_approval_request / ask_user 入队并按 requestId 独立回填', async () => {
    const chat = useChatStore();
    chat.sessionId = 's-1';
    const plan = { revision: 1, goal: 'g', nodes: [] };
    chat.onEvent({ type: 'plan_approval_request', request: { id: 'plan_1', plan } });
    chat.onEvent({ type: 'plan_approval_request', request: { id: 'plan_2', plan } });
    chat.onEvent({ type: 'ask_user', requestId: 'ask_1', question: 'q1' });
    chat.onEvent({ type: 'ask_user', requestId: 'ask_2', question: 'q2', options: ['x'] });
    expect(chat.pendingPlans.map((p) => p.requestId)).toEqual(['plan_1', 'plan_2']);
    expect(chat.pendingAsks.map((p) => p.requestId)).toEqual(['ask_1', 'ask_2']);

    await chat.decidePlan('plan_2', { kind: 'reject' });
    await chat.answerAsk('ask_1', 'my answer');
    expect(mocks.approvePlan).toHaveBeenCalledWith('s-1', 'plan_2', { kind: 'reject' });
    expect(mocks.answer).toHaveBeenCalledWith('s-1', 'ask_1', 'my answer');
    expect(chat.pendingPlans.map((p) => p.requestId)).toEqual(['plan_1']);
    expect(chat.pendingAsks.map((p) => p.requestId)).toEqual(['ask_2']);
  });

  it('运行结束（state running=false）清空全部待决策卡', () => {
    const chat = useChatStore();
    chat.onEvent({ type: 'confirm_request', request: REQ_A });
    chat.onEvent({ type: 'ask_user', requestId: 'ask_1', question: 'q' });
    chat.onEvent({ type: 'state', running: false });
    expect(chat.pendingConfirms).toHaveLength(0);
    expect(chat.pendingAsks).toHaveLength(0);
  });

  it('运行开始（state running=true）不清空待决策卡', () => {
    const chat = useChatStore();
    chat.onEvent({ type: 'confirm_request', request: REQ_A });
    chat.onEvent({ type: 'state', running: true });
    expect(chat.pendingConfirms).toHaveLength(1);
  });
});
