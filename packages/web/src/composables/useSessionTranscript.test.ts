/**
 * 架构收口 T9 —— useSessionTranscript 单测（判据 1/2/3）。
 *
 * 判据 2：同一份 fixture 下，主对话流口径（collectCallInfos + collectToolResults +
 * toolCardOf 逐调用推导 = WorkbenchView 现实现）与任务详情口径（pairToolCards =
 * composable 现实现）工具卡数量与顺序完全一致；回放口径（cardsFromTimelineSteps）
 * 卡片数量与状态同源。
 * 判据 3：confirm_request / plan_approval_request 不再被静默吞掉——pendingDecisions
 * 计数上浮。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { ChatMessage } from '../api/client';
import {
  cardsFromTimelineSteps,
  collectCallInfos,
  collectToolResults,
  LiveCallTracker,
  pairToolCards,
  toolCardOf,
  useSessionTranscript,
} from './useSessionTranscript';

const mocks = vi.hoisted(() => ({ getSessionMessages: vi.fn() }));
vi.mock('../api/client', () => ({ api: { getSessionMessages: mocks.getSessionMessages } }));

const sse = vi.hoisted(() => ({ handlers: {} as Record<string, (ev: { type: string; [k: string]: unknown }) => void> }));
vi.mock('../api/sse', () => ({
  subscribeSession: (sid: string, cb: (ev: { type: string; [k: string]: unknown }) => void) => {
    sse.handlers[sid] = cb;
    return () => {
      delete sse.handlers[sid];
    };
  },
}));

beforeEach(() => {
  mocks.getSessionMessages.mockReset();
  sse.handlers = {};
});

// ── 判据 2 的共享 fixture：一个 Worker 会话的典型消息流 ──────────────────────
const fixtureMessages: ChatMessage[] = [
  { seq: 1, role: 'user', content: '整理项目日报' } as ChatMessage,
  { seq: 2, role: 'assistant', content: '先读一下 README', toolCalls: [{ id: 'c1', name: 'read_file', argsJson: '{"path":"README.md"}' }] } as ChatMessage,
  { role: 'tool', content: '# README 内容', toolCallId: 'c1', ok: true, seq: 3 } as ChatMessage,
  { seq: 4, role: 'assistant', content: '写入日报', toolCalls: [{ id: 'c2', name: 'write_file', argsJson: '{"path":"daily.md"}' }] } as ChatMessage,
  { role: 'tool', content: '已写入', toolCallId: 'c2', ok: true, seq: 5 } as ChatMessage,
  { seq: 6, role: 'assistant', content: '完成' } as ChatMessage,
];

describe('pairToolCards（判据 1：唯一配对函数）', () => {
  it('fixture：两张卡按调用顺序排列，状态/内容/序号配对正确', () => {
    const cards = pairToolCards(fixtureMessages);
    expect(cards.map((c) => `${c.name}:${c.status}`)).toEqual(['read_file:ok', 'write_file:ok']);
    expect(cards[0]).toMatchObject({ callId: 'c1', content: '# README 内容', seq: 1, resultSeq: 3 });
    expect(cards[1]).toMatchObject({ callId: 'c2', content: '已写入', seq: 2, resultSeq: 5 });
  });

  it('失败结果 / rejected_by_user → fail（三处同口径）', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'run_command', argsJson: '{}' }] } as ChatMessage,
      { role: 'tool', content: 'boom', toolCallId: 'a', ok: false } as ChatMessage,
      { role: 'assistant', content: '', toolCalls: [{ id: 'b', name: 'write_file', argsJson: '{}' }] } as ChatMessage,
      { role: 'tool', content: 'rejected_by_user：用户拒绝', toolCallId: 'b', ok: true } as ChatMessage,
    ];
    const cards = pairToolCards(msgs);
    expect(cards.map((c) => c.status)).toEqual(['fail', 'fail']);
  });

  it('孤儿结果兜底建卡；liveCalls 未落库调用按序追加', () => {
    const msgs: ChatMessage[] = [
      { role: 'tool', content: '孤儿结果', toolCallId: 'lost', ok: false } as ChatMessage,
      { role: 'assistant', content: 'x', toolCalls: [{ id: 'live', name: 'grep_search', argsJson: '{}' }] } as ChatMessage,
      { role: 'assistant', content: 'y' } as ChatMessage, // 无调用 → 不产卡
    ];
    const cards = pairToolCards(msgs, {
      pending: { name: 'grep_search', argsJson: '{}', startedAt: Date.now(), seq: 9 }, // 未落库调用 → running 卡
    });
    expect(cards.map((c) => `${c.name}:${c.status}`)).toEqual([
      'tool:fail', // 孤儿结果兜底
      'grep_search:running', // 历史调用（结果未到）
      'grep_search:running', // liveCalls 未落库调用追加
    ]);
  });

  it('主对话流口径（collect+toolCardOf 逐调用）与 pairToolCards 输出一致（判据 2）', () => {
    const infos = collectCallInfos(fixtureMessages);
    const results = collectToolResults(fixtureMessages);
    const chatStreamCards = fixtureMessages
      .flatMap((m) => (m.toolCalls ?? []).map((c) => toolCardOf(c.id, c.name, c.argsJson, results.get(c.id), infos.get(c.id))));
    const panelCards = pairToolCards(fixtureMessages);
    expect(panelCards).toEqual(chatStreamCards);
  });
});

describe('cardsFromTimelineSteps（判据 1 第三处：回放同源）', () => {
  it('同一 fixture 的回放时间线：卡片数量一致、状态同源', () => {
    const steps = [
      { type: 'user', at: '', text: '整理项目日报' },
      { type: 'tool_call', at: '', name: 'read_file', argsJson: '{"path":"README.md"}', result: { ok: true, content: '# README 内容', at: '' } },
      { type: 'tool_call', at: '', name: 'write_file', argsJson: '{"path":"daily.md"}', result: { ok: true, content: '已写入', at: '' } },
    ];
    const cards = cardsFromTimelineSteps(steps);
    expect(cards).toHaveLength(2); // 与 fixture 消息流的工具卡数量一致（判据 2）
    expect(cards.map((c) => `${c.name}:${c.status}`)).toEqual(['read_file:ok', 'write_file:ok']);
    // user/assistant 步骤不产卡
    expect(cards.every((c) => c.name !== '整理项目日报')).toBe(true);
  });
});

describe('LiveCallTracker（chat store 与 composable 共用簿记）', () => {
  it('register/consume/reset：seq 递增、consume 计算耗时、reset 原地清空', () => {
    const backing: Record<string, { name: string; argsJson: string; startedAt: number; seq: number }> = {};
    const t = new LiveCallTracker(backing);
    expect(t.register({ id: 'a', name: 'read_file', argsJson: '{}' }, 1000)).toBe(1);
    expect(t.register({ id: 'b', name: 'edit_file', argsJson: '{}' }, 1000)).toBe(2);
    const meta = t.consume('a', 1500);
    expect(meta).toMatchObject({ seq: 1, durationMs: 500 });
    expect(t.consume('a')).toBeUndefined(); // 取走即删
    t.reset();
    expect(Object.keys(t.all())).toHaveLength(0);
    expect(backing).toBe(t.all()); // backing 引用不变（响应式对象安全）
  });
});

describe('useSessionTranscript composable（判据 1/3）', () => {
  it('历史拉取 + SSE 增量：卡片配对、流式文本、待决策计数上浮', async () => {
    mocks.getSessionMessages.mockImplementation((_sid: string, q: { after?: number }) => {
      if (q.after === undefined) {
        return Promise.resolve({
          messages: fixtureMessages.slice(0, 4), // 首屏截断：c2 调用在历史、结果未到
          has_more: false,
        });
      }
      return Promise.resolve({ messages: fixtureMessages.slice(4), has_more: false });
    });

    const sid = ref<string | null>('s1');
    const tr = useSessionTranscript({ sessionId: () => sid.value });
    await new Promise((r) => setTimeout(r, 0)); // flush open()
    expect(tr.loading.value).toBe(false);
    expect(tr.messages.value).toHaveLength(4);

    // 历史 + 未落结果 → c1 ok、c2 running（pairToolCards 单一来源）
    expect(tr.toolCards.value.map((c) => `${c.name}:${c.status}`)).toEqual(['read_file:ok', 'write_file:running']);

    // SSE 增量：text_delta → streamingText；tool_result → 卡片转 ok
    sse.handlers['s1']!({ type: 'text_delta', text: '收尾说明' });
    expect(tr.streamingText.value).toBe('收尾说明');
    sse.handlers['s1']!({ type: 'tool_result', result: { callId: 'c2', ok: true, content: '已写入' } });
    expect(tr.toolCards.value[1]!.status).toBe('ok');

    // 判据 3：confirm / plan 不再静默吞掉 → pendingDecisions 上浮
    sse.handlers['s1']!({ type: 'confirm_request', request: { id: 'cf1', tool: 'run_command', reason: '执行 rm' } });
    sse.handlers['s1']!({ type: 'plan_approval_request', request: { id: 'pl1', plan: { revision: 1, nodes: [] } } });
    expect(tr.pendingDecisions.value.total).toBe(2);
    expect(tr.pendingDecisions.value.confirms).toHaveLength(1);
    expect(tr.pendingDecisions.value.plans).toHaveLength(1);

    // done → 流式文本落为助手消息 + 增量重拉补齐落库
    sse.handlers['s1']!({ type: 'done' });
    await new Promise((r) => setTimeout(r, 0));
    expect(tr.streamingText.value).toBe('');
    const tail = tr.messages.value[tr.messages.value.length - 1]!;
    expect(tail.content).toBe('完成'); // after 游标重拉拉回 fixture 尾部
    expect(tr.toolCards.value.map((c) => c.status)).toEqual(['ok', 'ok']);

    // 切走会话（null）→ 停流清态
    sid.value = null;
    await new Promise((r) => setTimeout(r, 0));
    expect(tr.messages.value).toHaveLength(0);
    expect(tr.pendingDecisions.value.total).toBe(0);
    void tr.dispose;
  });
});
