/**
 * 架构收口 T9 —— 会话消息流渲染收敛（三处共用同一配对函数）。
 *
 * 收敛前：主对话流（WorkbenchView callInfoMap/resultMap/toolCardOf）、任务详情
 * （TaskDetailPanel 自建 msgs/toolCards/streamingText + SSE 六分支）、回放页
 * （ReplayView 内联 result 三元）各写一套「调用 ↔ 结果」配对——口径漂移风险
 * （rejected 判定 / 孤儿结果兜底 / seq 编号三处不一致）。
 *
 * 收敛后：
 *  - 配对纯函数（本文件导出，node 单测可跑）：collectCallInfos / collectToolResults /
 *    toolCardOf / pairToolCards / orphanCardOf / cardsFromTimelineSteps /
 *    LiveCallTracker——三处共用同一实现（判据 1）；
 *  - useSessionTranscript composable：历史拉取 + SSE 增量 + 配对派生 + 待决策
 *    汇总（判据 3：confirm/plan/ask 计数上浮，只读视图给统一禁用提示，不静默吞掉）；
 *    供任务详情面板消费；主对话流（chat store）仍走完整 store，但簿记改用
 *    LiveCallTracker 单一来源。
 *
 * 「只读 / 可交互」两种模式：interactive（chat store）承担确认/审批/提问回填；
 * 只读（composable）不回填，把待决策计数上浮给调用方渲染统一提示。
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import { api, type ChatMessage, type ConfirmRequest, type PlanPayload } from '../api/client';
import { subscribeSession } from '../api/sse';

/** SSE 实时调用登记条目（chat store pendingCalls 原形状，兼容既有消费方） */
export interface LiveCallEntry {
  name: string;
  argsJson: string;
  startedAt: number;
  seq: number;
}

/** 调用信息（配对用最小形状） */
export interface ToolCallInfo {
  name: string;
  argsJson: string;
  seq: number;
}

/** 三处共用的工具卡视图模型（ToolCallCard props 同构） */
export interface TranscriptToolCard {
  callId: string;
  name: string;
  argsJson: string;
  status: 'running' | 'ok' | 'fail';
  content?: string;
  durationMs?: number;
  seq?: number;
  sandboxMeta?: ChatMessage['sandboxMeta'];
  agentName?: string | null;
  // ── F-53 大输出懒加载 ──
  resultSeq?: number | null;
  contentTruncated?: boolean;
  contentLength?: number;
}

/** rejected_by_user 判定（三处同口径；用户拒绝的确认也归 fail） */
export function isRejectedContent(content: string): boolean {
  return /rejected_by_user/i.test(content);
}

/** F-39「由 X 执行」角标：meta.agent_name 优先；回放/历史走内容前缀 [expert:x] 兜底 */
export function agentLabelOf(m: ChatMessage): string | null {
  if (m.agentName) return m.agentName;
  const r = /^\[expert:([A-Za-z0-9_-]{1,40})\]\s*([^\n]*)/.exec(m.content);
  if (!r) return null;
  return (r[2] ?? '').trim() || r[1]!;
}

/**
 * 调用信息收集：assistant.toolCalls 按出现顺序补算 seq（历史口径），
 * liveCalls（SSE 实时登记）未入册的按 store 序号并入（落库前兜底）。
 */
export function collectCallInfos(
  messages: ChatMessage[],
  liveCalls?: Record<string, LiveCallEntry>,
): Map<string, ToolCallInfo> {
  const map = new Map<string, ToolCallInfo>();
  const seen = new Set<string>();
  let n = 0;
  for (const m of messages) {
    for (const c of m.toolCalls ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      n += 1;
      map.set(c.id, { name: c.name, argsJson: c.argsJson, seq: n });
    }
  }
  if (liveCalls) {
    for (const [id, pc] of Object.entries(liveCalls)) {
      if (!map.has(id)) map.set(id, { name: pc.name, argsJson: pc.argsJson, seq: pc.seq });
    }
  }
  return map;
}

/** 结果收集：role:'tool' 按 toolCallId 归并（同 callId 多条取最新——重试口径） */
export function collectToolResults(messages: ChatMessage[]): Map<string, ChatMessage> {
  const map = new Map<string, ChatMessage>();
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) map.set(m.toolCallId, m);
  }
  return map;
}

/** 单卡视图模型：状态推导（未配对 = running；ok===false 或 rejected = fail） */
export function toolCardOf(
  callId: string,
  name: string,
  argsJson: string,
  result?: ChatMessage,
  info?: ToolCallInfo,
): TranscriptToolCard {
  const rejected = result ? isRejectedContent(result.content) : false;
  const status: TranscriptToolCard['status'] = !result
    ? 'running'
    : result.ok === false || rejected
      ? 'fail'
      : 'ok';
  return {
    callId,
    name,
    argsJson,
    status,
    content: result?.content,
    durationMs: result?.durationMs,
    seq: info?.seq,
    sandboxMeta: result?.sandboxMeta,
    agentName: result ? agentLabelOf(result) : null,
    resultSeq: result?.seq ?? null,
    contentTruncated: result?.contentTruncated,
    contentLength: result?.contentLength,
  };
}

/** 孤儿结果卡兜底：结果消息找不到任何调用记录时，仍以结果为主体渲染一张卡 */
export function orphanCardOf(m: ChatMessage, info?: ToolCallInfo): TranscriptToolCard {
  const ok = m.ok;
  const rejected = isRejectedContent(m.content);
  return {
    callId: m.toolCallId ?? `orphan-${m.content.slice(0, 16)}`,
    name: info?.name ?? 'tool',
    argsJson: info?.argsJson ?? '',
    status: ok === false || rejected ? 'fail' : 'ok',
    content: m.content,
    durationMs: m.durationMs,
    seq: info?.seq ?? m.toolSeq,
    sandboxMeta: m.sandboxMeta,
    agentName: agentLabelOf(m),
    resultSeq: m.seq ?? null,
    contentTruncated: m.contentTruncated,
    contentLength: m.contentLength,
  };
}

/**
 * 判据 1（唯一配对函数）：消息流 → 有序工具卡。
 * 调用信息来自 assistant.toolCalls（历史口径）+ liveCalls（SSE 实时兜底），
 * 结果来自 role:'tool' 按 callId 配对；孤儿结果兜底建卡。
 * 主对话流（WorkbenchView）、任务详情（composable）共用；回放页经
 * cardsFromTimelineSteps 复用同一状态推导。
 */
export function pairToolCards(
  messages: ChatMessage[],
  liveCalls?: Record<string, LiveCallEntry>,
): TranscriptToolCard[] {
  const infos = collectCallInfos(messages, liveCalls);
  const results = collectToolResults(messages);
  const cards: TranscriptToolCard[] = [];
  const emitted = new Set<string>();
  for (const m of messages) {
    for (const c of m.toolCalls ?? []) {
      if (emitted.has(c.id)) continue;
      emitted.add(c.id);
      cards.push(toolCardOf(c.id, c.name, c.argsJson, results.get(c.id), infos.get(c.id)));
    }
    // 孤儿结果（调用消息被折叠窗口截掉）：兜底建卡
    if (m.role === 'tool' && m.toolCallId && !emitted.has(m.toolCallId) && !infos.has(m.toolCallId)) {
      emitted.add(m.toolCallId);
      cards.push(orphanCardOf(m, infos.get(m.toolCallId)));
    }
  }
  // 实时登记但尚未落库的调用（运行中卡片）按 store 序号追加
  if (liveCalls) {
    const pending = Object.entries(liveCalls)
      .filter(([id]) => !emitted.has(id))
      .sort((a, b) => a[1].seq - b[1].seq);
    for (const [id, pc] of pending) {
      cards.push(toolCardOf(id, pc.name, pc.argsJson, results.get(id), { name: pc.name, argsJson: pc.argsJson, seq: pc.seq }));
    }
  }
  return cards;
}

/** 回放时间线工具步骤的最小形状（RunStep 的 tool_call 子集；非工具步骤 name 缺省被过滤） */
export interface TimelineToolStep {
  name?: string;
  argsJson?: string;
  result?: { ok: boolean; content: string } | null;
}

/** 回放页共用：时间线步骤 → 同一卡片口径（状态推导 / 字段同源，判据 1 的第三处） */
export function cardsFromTimelineSteps(steps: TimelineToolStep[]): TranscriptToolCard[] {
  const cards: TranscriptToolCard[] = [];
  for (const s of steps) {
    if (s.name === undefined) continue; // 仅工具步骤（user/assistant 步骤无 name）
    cards.push({
      callId: `tl-${cards.length}`,
      name: s.name,
      argsJson: s.argsJson ?? '',
      status: s.result ? (s.result.ok && !isRejectedContent(s.result.content) ? 'ok' : 'fail') : 'running',
      content: s.result?.content,
      durationMs: undefined,
      seq: cards.length + 1,
    });
  }
  return cards;
}

/**
 * SSE 实时调用登记（chat store 与 composable 共用的簿记单一来源）：
 * callId → { name, argsJson, startedAt, seq }；结果到达时 consume 计算本地耗时。
 * entries 由构造方传入（可传响应式对象——chat store 传 Pinia state、composable 传
 * ref 内层对象，登记/移除自动触发依赖更新）。
 */
export class LiveCallTracker {
  private seq = 0;
  constructor(private readonly entries: Record<string, LiveCallEntry> = {}) {}

  /** 登记 + 递增序号（本会话内第 N 步口径） */
  register(call: { id: string; name: string; argsJson: string }, now = Date.now()): number {
    this.seq += 1;
    this.entries[call.id] = { name: call.name, argsJson: call.argsJson, startedAt: now, seq: this.seq };
    return this.seq;
  }

  /** 结果到达：取走元信息（本地耗时计算用）；未登记过返回 undefined */
  consume(callId: string, now = Date.now()): (LiveCallEntry & { durationMs: number }) | undefined {
    const e = this.entries[callId];
    if (!e) return undefined;
    delete this.entries[callId];
    return { ...e, durationMs: now - e.startedAt };
  }

  /** 只读快照（渲染运行中卡片；不改变内部状态） */
  all(): Record<string, LiveCallEntry> {
    return this.entries;
  }

  /** 清空（切会话；原地删除保持 backing 引用不变——响应式对象不能换 identity） */
  reset(): void {
    for (const k of Object.keys(this.entries)) delete this.entries[k];
    this.seq = 0;
  }
}

// ── 只读/轻交互 composable（任务详情面板消费）────────────────────────────

/** 待决策汇总（判据 3：只读视图上浮计数，给统一禁用提示，不静默吞掉） */
export interface PendingDecisions {
  confirms: ConfirmRequest[];
  plans: Array<{ requestId: string; plan: PlanPayload }>;
  asks: Array<{ requestId: string; question: string; options?: string[] }>;
  /** 总数 > 0 = 存在待处理决策，调用方渲染统一提示 */
  total: number;
}

export interface SessionTranscript {
  messages: Ref<ChatMessage[]>;
  toolCards: ComputedRef<TranscriptToolCard[]>;
  streamingText: Ref<string>;
  running: Ref<boolean>;
  loading: Ref<boolean>;
  loadFailed: Ref<boolean>;
  pendingDecisions: ComputedRef<PendingDecisions>;
  /** 本地推入一条用户消息（面板续发消息用；不经 SSE） */
  pushLocalUser(text: string): void;
  /** 本地回滚一条用户消息（发送失败 409 时） */
  rollbackLocalUser(text: string): void;
  dispose(): void;
}

const TRANSCRIPT_PAGE_SIZE = 50;

/**
 * 会话消息流（历史 + SSE 增量 + 配对派生）。
 * 判据 1：TaskDetailPanel 的自建 msgs/toolCards/streamingText 状态与 SSE 六分支
 * 全部删除，改由本 composable 承担；工具卡由 pairToolCards 单一来源派生。
 */
export function useSessionTranscript(opts: {
  /** 响应式会话来源（null/undefined = 关闭订阅并清态） */
  sessionId: () => string | null | undefined;
  /** 历史拉取条数（缺省 50，与面板既有口径一致） */
  pageSize?: number;
}): SessionTranscript {
  const pageSize = opts.pageSize ?? TRANSCRIPT_PAGE_SIZE;

  const messages = ref<ChatMessage[]>([]);
  const streamingText = ref('');
  const running = ref(false);
  const loading = ref(false);
  const loadFailed = ref(false);
  const pendingConfirms = ref<ConfirmRequest[]>([]);
  const pendingPlans = ref<Array<{ requestId: string; plan: PlanPayload }>>([]);
  const pendingAsks = ref<Array<{ requestId: string; question: string; options?: string[] }>>([]);

  /** SSE 实时调用登记（响应式 backing：登记/移除触发 toolCards 重算） */
  const liveCalls = ref<Record<string, LiveCallEntry>>({});
  const tracker = new LiveCallTracker(liveCalls.value);
  let unsub: (() => void) | null = null;
  let boundSessionId = '';

  /** 判据 1：工具卡 = pairToolCards 单一来源派生（历史重建 + 实时卡同一路径） */
  const toolCards = computed(() => pairToolCards(messages.value, liveCalls.value));

  const pendingDecisions = computed<PendingDecisions>(() => ({
    confirms: pendingConfirms.value,
    plans: pendingPlans.value,
    asks: pendingAsks.value,
    total: pendingConfirms.value.length + pendingPlans.value.length + pendingAsks.value.length,
  }));

  function close(): void {
    unsub?.();
    unsub = null;
    boundSessionId = '';
    messages.value = [];
    streamingText.value = '';
    running.value = false;
    loading.value = false;
    loadFailed.value = false;
    tracker.reset(); // 原地清空（保持 liveCalls ref 引用不变）
    pendingConfirms.value = [];
    pendingPlans.value = [];
    pendingAsks.value = [];
  }

  async function open(sessionId: string): Promise<void> {
    close();
    boundSessionId = sessionId;
    loading.value = true;
    try {
      const page = await api.getSessionMessages(sessionId, { limit: pageSize });
      // await 期间会话已切走：过期响应丢弃
      if (boundSessionId !== sessionId) return;
      messages.value = page.messages;
      loadFailed.value = false;
    } catch {
      if (boundSessionId === sessionId) loadFailed.value = true;
    } finally {
      if (boundSessionId === sessionId) loading.value = false;
    }
    unsub = subscribeSession(sessionId, onEvent);
  }

  /** done 后增量重拉（after 游标；对齐 chat store done 分支口径的简化版） */
  async function refetchAfterDone(sid: string): Promise<void> {
    try {
      const lastSeq = [...messages.value].reverse().find((m) => m.seq != null)?.seq ?? 0;
      const fetched: ChatMessage[] = [];
      let after = lastSeq;
      for (let guard = 0; guard < 20; guard++) {
        const r = await api.getSessionMessages(sid, { after, limit: 500 });
        fetched.push(...r.messages);
        if (!r.has_more || r.messages.length === 0) break;
        after = r.messages[r.messages.length - 1]!.seq ?? after;
      }
      if (boundSessionId !== sid) return;
      if (fetched.length > 0) messages.value.push(...fetched);
    } catch {
      /* 瞬时失败：下轮 done / 重开面板兜底 */
    }
  }

  function flushStreaming(role: 'assistant', toolCall?: { id: string; name: string; argsJson: string }): void {
    if (!streamingText.value) return;
    messages.value.push({
      role,
      content: streamingText.value,
      ts: Date.now(),
      ...(toolCall ? { toolCalls: [toolCall] } : {}),
    });
    streamingText.value = '';
  }

  function onEvent(ev: { type: string; [k: string]: unknown }): void {
    switch (ev.type) {
      case 'state':
        running.value = ev.running === true;
        // 运行结束：清空待决策卡（服务端 waiter 已随超时/中止收尾，残留卡不可再回填）
        if (!running.value) {
          pendingConfirms.value = [];
          pendingPlans.value = [];
          pendingAsks.value = [];
        }
        break;
      case 'text_delta':
        streamingText.value += String(ev.text ?? '');
        break;
      case 'tool_call_start': {
        const call = ev.call as { id: string; name: string; argsJson: string };
        // 已累积的流式文本先落一条助手消息（工具卡跟随其后）
        flushStreaming('assistant', call);
        tracker.register(call);
        break;
      }
      case 'tool_result': {
        const r = ev.result as { callId: string; ok: boolean; content: string };
        const meta = tracker.consume(r.callId);
        messages.value.push({
          role: 'tool',
          content: r.content,
          toolCallId: r.callId,
          ts: Date.now(),
          ok: r.ok,
          ...(meta ? { durationMs: meta.durationMs, toolSeq: meta.seq } : {}),
        });
        break;
      }
      // 判据 3：待决策事件不再静默吞掉——计数上浮，由调用方渲染统一禁用提示
      case 'confirm_request': {
        const req = ev.request as ConfirmRequest;
        if (!pendingConfirms.value.some((p) => p.id === req.id)) pendingConfirms.value.push(req);
        break;
      }
      case 'plan_approval_request': {
        const req = ev.request as { id: string; plan: PlanPayload };
        const entry = { requestId: String(req.id), plan: JSON.parse(JSON.stringify(req.plan)) as PlanPayload };
        if (!pendingPlans.value.some((p) => p.requestId === entry.requestId)) pendingPlans.value.push(entry);
        break;
      }
      case 'ask_user': {
        // 澄清问答：渲染为助手消息卡（主对话在输入框回答，走普通消息通道）
        const question = String(ev.question);
        pendingAsks.value.push({ requestId: String(ev.requestId), question, options: ev.options as string[] | undefined });
        messages.value.push({ role: 'assistant', content: `❓ ${question}`, ts: Date.now() });
        break;
      }
      case 'done': {
        flushStreaming('assistant');
        void refetchAfterDone(boundSessionId);
        break;
      }
      default:
        break;
    }
  }

  watch(
    () => opts.sessionId(),
    (sid) => {
      if (sid) void open(sid);
      else close();
    },
    { immediate: true },
  );

  return {
    messages,
    toolCards,
    streamingText,
    running,
    loading,
    loadFailed,
    pendingDecisions,
    pushLocalUser(text: string): void {
      messages.value.push({ role: 'user', content: text, ts: Date.now() });
    },
    rollbackLocalUser(text: string): void {
      const idx = messages.value.findIndex((m) => m.role === 'user' && m.content === text);
      if (idx !== -1) messages.value.splice(idx, 1);
    },
    dispose(): void {
      close();
    },
  };
}
