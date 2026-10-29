/**
 * F-53 chat store 增量拉取行为测试（mock api/client，node 环境可跑）
 *
 * 覆盖：
 * - open()：首屏只拉一页（getSessionMeta + getSessionMessages，不调 getSession 全量）
 * - loadOlder()：before 游标前缀插入 + 游标/hasMore 维护 + 防重入
 * - done：after 增量校准（不整体重拉）+ 本地 UI 字段（ts/ok）按 role+content 回带
 * - expandToolContent：按 seq 拉全文原位回填
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const mocks = vi.hoisted(() => ({
  getSessionMeta: vi.fn(),
  getSessionMessages: vi.fn(),
  getMessageContent: vi.fn(),
  getPermission: vi.fn(),
  gitState: vi.fn(),
  getSessionExpert: vi.fn(),
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});
vi.mock('../api/sse', () => ({ subscribeSession: () => () => undefined }));

import { useChatStore } from './chat';

beforeEach(() => {
  setActivePinia(createPinia());
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getPermission.mockRejectedValue(new Error('skip'));
  mocks.gitState.mockRejectedValue(new Error('skip'));
  mocks.getSessionExpert.mockRejectedValue(new Error('skip'));
});

const meta = { session: { title: 't', mode: 'react', model: 'm', status: 'active' } };
/** 造一页消息：seq 从 from 到 to（升序） */
function page(from: number, to: number, hasMore = false) {
  const messages = [];
  for (let i = from; i <= to; i++) messages.push({ role: 'user' as const, content: `msg-${i}`, seq: i });
  return { messages, has_more: hasMore, next_before: messages[0]?.seq ?? null };
}

describe('chat store F-53 增量拉取', () => {
  it('open 只拉首屏一页，维护 lastSeq/oldestSeq/hasMoreOlder/anchoredCount', async () => {
    mocks.getSessionMeta.mockResolvedValue(meta);
    mocks.getSessionMessages.mockResolvedValue(page(51, 100));
    const chat = useChatStore();
    await chat.open('s-1');
    expect(mocks.getSessionMessages).toHaveBeenCalledWith('s-1', { limit: 50 });
    expect(chat.messages).toHaveLength(50);
    expect(chat.lastSeq).toBe(100);
    expect(chat.oldestSeq).toBe(51);
    expect(chat.hasMoreOlder).toBe(false);
    expect(chat.anchoredCount).toBe(50);
  });

  it('loadOlder 前缀插入并更新游标；hasMore=false 时不再拉取', async () => {
    mocks.getSessionMeta.mockResolvedValue(meta);
    mocks.getSessionMessages.mockResolvedValueOnce(page(51, 100, true));
    const chat = useChatStore();
    await chat.open('s-1');
    mocks.getSessionMessages.mockResolvedValueOnce(page(1, 50, false));
    const ok = await chat.loadOlder();
    expect(ok).toBe(true);
    expect(chat.messages[0]!.content).toBe('msg-1');
    expect(chat.messages).toHaveLength(100);
    expect(chat.oldestSeq).toBe(1);
    expect(chat.hasMoreOlder).toBe(false);
    expect(chat.anchoredCount).toBe(100);
    // 没有更多：直接返回 false，不发请求
    const calls = mocks.getSessionMessages.mock.calls.length;
    expect(await chat.loadOlder()).toBe(false);
    expect(mocks.getSessionMessages.mock.calls.length).toBe(calls);
  });

  it('done：after 增量校准替换未锚定尾部，本地 UI 字段回带', async () => {
    mocks.getSessionMeta.mockResolvedValue(meta);
    mocks.getSessionMessages.mockResolvedValue(page(1, 2));
    const chat = useChatStore();
    await chat.open('s-1'); // seq 1,2；anchoredCount=2, lastSeq=2
    // 运行期本地推入：user（带 ts）+ tool 结果（带 ok）
    chat.onEvent({ type: 'tool_result', result: { callId: 'c1', name: 'run_command', ok: false, content: 'boom' } });
    chat.messages[chat.messages.length - 1]!.ts = 12345;
    expect(chat.messages).toHaveLength(3);
    // done：服务端落库 seq 3 = tool 消息
    mocks.getSessionMessages.mockResolvedValueOnce({
      messages: [{ role: 'tool', content: 'boom', toolCallId: 'c1', seq: 3 }],
      has_more: false,
      next_before: null,
    });
    await chat.onEvent({ type: 'done', usage: { inputTokens: 1, outputTokens: 2 } });
    expect(mocks.getSessionMessages).toHaveBeenLastCalledWith('s-1', { after: 2, limit: 500 });
    expect(chat.messages).toHaveLength(3);
    expect(chat.messages[2]!.seq).toBe(3);
    expect(chat.messages[2]!.ts).toBe(12345); // 本地字段回带
    expect(chat.messages[2]!.ok).toBe(false);
    expect(chat.lastSeq).toBe(3);
    expect(chat.anchoredCount).toBe(3);
  });

  it('expandToolContent 按 seq 拉全文原位回填', async () => {
    mocks.getSessionMeta.mockResolvedValue(meta);
    mocks.getSessionMessages.mockResolvedValue({
      messages: [{ role: 'tool', content: 'truncated', toolCallId: 'c1', seq: 7, contentTruncated: true, contentLength: 9000 }],
      has_more: false,
      next_before: null,
    });
    const chat = useChatStore();
    await chat.open('s-1');
    mocks.getMessageContent.mockResolvedValue({ seq: 7, message: { role: 'tool', content: 'x'.repeat(9000), toolCallId: 'c1' } });
    await chat.expandToolContent(7);
    expect(chat.messages[0]!.content).toHaveLength(9000);
    expect(chat.messages[0]!.contentTruncated).toBeUndefined();
  });
});
