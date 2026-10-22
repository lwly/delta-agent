import { defineStore } from 'pinia';
import { api, type ChatMessage, type ConfirmRequest } from '../api/client';
import { subscribeSession } from '../api/sse';

/** 对话运行时状态：SSE 事件 → 渲染消息流 + 待确认/待回答卡片 */
export const useChatStore = defineStore('chat', {
  state: () => ({
    sessionId: '' as string,
    sessionMeta: null as null | { title: string; mode: string; model: string },
    messages: [] as ChatMessage[],
    streamingText: '',
    running: false,
    pendingConfirm: null as ConfirmRequest | null,
    pendingAsk: null as { requestId: string; question: string; options?: string[] } | null,
    notices: [] as Array<{ id: number; text: string }>,
    unsub: null as null | (() => void),
    noticeId: 1,
  }),
  actions: {
    async open(sessionId: string) {
      this.close();
      this.sessionId = sessionId;
      const detail = await api.getSession(sessionId);
      this.sessionMeta = {
        title: detail.session.title,
        mode: detail.session.mode,
        model: detail.session.model,
      };
      this.messages = detail.messages;
      this.streamingText = '';
      this.running = false;
      this.pendingConfirm = null;
      this.pendingAsk = null;
      this.unsub = subscribeSession(sessionId, (ev) => this.onEvent(ev));
    },
    close() {
      this.unsub?.();
      this.unsub = null;
      this.sessionId = '';
      this.sessionMeta = null;
      this.messages = [];
      this.streamingText = '';
    },
    notice(text: string) {
      this.notices.push({ id: this.noticeId++, text });
      if (this.notices.length > 20) this.notices.shift();
    },
    async onEvent(ev: { type: string; [k: string]: unknown }) {
      switch (ev.type) {
        case 'state':
          this.running = ev.running === true;
          if (!this.running && this.streamingText) {
            // 流结束兜底：把未落库的流式文本并回消息（done 落库后 detail 拉取为准）
            this.streamingText = '';
          }
          break;
        case 'text_delta':
          this.streamingText += String(ev.text ?? '');
          break;
        case 'thinking_delta':
          break;
        case 'turn_start':
          break;
        case 'tool_call_start': {
          const call = ev.call as { id: string; name: string; argsJson: string };
          // 助手消息（携带已累积的流式文本）落一条，工具调用跟随其后的 tool 消息展示
          if (this.streamingText) {
            this.messages.push({ role: 'assistant', content: this.streamingText, toolCalls: [call] });
            this.streamingText = '';
          }
          break;
        }
        case 'tool_result': {
          const result = ev.result as { callId: string; name: string; ok: boolean; content: string };
          this.messages.push({
            role: 'tool',
            content: result.content,
            toolCallId: result.callId,
          });
          break;
        }
        case 'confirm_request':
          this.pendingConfirm = ev.request as ConfirmRequest;
          break;
        case 'ask_user':
          this.pendingAsk = {
            requestId: String(ev.requestId),
            question: String(ev.question),
            options: ev.options as string[] | undefined,
          };
          break;
        case 'compact_done':
          this.notice(`上下文已压缩：${ev.beforeTokens} → ${ev.afterTokens} tokens`);
          break;
        case 'budget_warning':
          this.notice(`⚠ 预算已用 ${Math.round(Number(ev.usedPct) * 100)}%`);
          break;
        case 'budget_exhausted':
          this.notice(`⚠ ${String(ev.summary ?? '预算耗尽')}`);
          break;
        // ── M5: Plan DAG / Worker Pool / Reviewer 事件（notice 最小渲染）──
        case 'plan_created': {
          const plan = ev.plan as { revision: number; nodes: Array<{ id: string; goal: string; deps: string[] }> };
          const lines = plan.nodes.map((n) => `  ${n.id}${n.deps.length ? ` ←(${n.deps.join(',')})` : ''} ${n.goal}`).join('\n');
          this.notice(`📋 计划（rev ${plan.revision}，${plan.nodes.length} 节点）：\n${lines}`);
          break;
        }
        case 'plan_updated':
          this.notice(`📋 计划更新：${String(ev.reason ?? '')}`);
          break;
        case 'subtask_start':
          this.notice(`▶ ${String(ev.nodeId)}：${String(ev.goal)}`);
          break;
        case 'subtask_done':
          this.notice(`✔ ${String(ev.nodeId)} 完成`);
          break;
        case 'subtask_failed':
          this.notice(`✘ ${String(ev.nodeId)} 失败：${String(ev.error ?? '')}`);
          break;
        case 'review_verdict': {
          const verdict = ev.verdict as { pass: boolean; failures: Array<{ nodeId: string; reason: string }> };
          this.notice(
            verdict.pass
              ? `🔍 质量审查通过（rev ${String(ev.revision)}）`
              : `🔍 质量审查不通过：${verdict.failures.map((f) => `${f.nodeId} ${f.reason}`).join('; ')}`,
          );
          break;
        }
        case 'error':
          this.notice(`✘ ${String(ev.message)}`);
          break;
        case 'run_error':
          this.notice(`✘ ${String(ev.message)}`);
          break;
        case 'done': {
          // done 前最后一次 text_delta 已累积 → 落为 assistant 消息（与桥的落库一致）
          if (this.streamingText) {
            this.messages.push({ role: 'assistant', content: this.streamingText });
            this.streamingText = '';
          }
          const usage = ev.usage as { inputTokens?: number; outputTokens?: number } | undefined;
          if (usage) this.notice(`本任务 token：${usage.inputTokens ?? 0} 入 / ${usage.outputTokens ?? 0} 出`);
          // 以服务端落库为准，重拉一次
          const detail = await api.getSession(this.sessionId);
          this.messages = detail.messages;
          break;
        }
        default:
          break;
      }
    },
    async send(input: string) {
      if (!this.sessionId || this.running) return;
      this.messages.push({ role: 'user', content: input });
      this.streamingText = '';
      try {
        await api.send(this.sessionId, input);
      } catch (e) {
        this.notice(`✘ ${(e as Error).message}`);
        this.messages.pop();
      }
    },
    async decideConfirm(decision: { kind: 'allow' } | { kind: 'reject'; reason?: string }) {
      if (!this.pendingConfirm) return;
      const req = this.pendingConfirm;
      this.pendingConfirm = null;
      await api.confirm(this.sessionId, req.id, decision);
    },
    async answerAsk(answer: string) {
      if (!this.pendingAsk) return;
      const ask = this.pendingAsk;
      this.pendingAsk = null;
      await api.answer(this.sessionId, ask.requestId, answer);
    },
    async abort() {
      await api.abort(this.sessionId);
    },
  },
});
