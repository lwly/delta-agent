import { defineStore } from 'pinia';
import {
  api,
  type BranchInfo,
  type ChatMessage,
  type ConfirmRequest,
  type MessageImage,
  type PlanPayload,
  type SessionGitState,
} from '../api/client';
import { subscribeSession } from '../api/sse';

/** 对话运行时状态：SSE 事件 → 渲染消息流 + 待确认/待回答卡片 */
export const useChatStore = defineStore('chat', {
  state: () => ({
    sessionId: '' as string,
    sessionMeta: null as null | { title: string; mode: string; model: string },
    messages: [] as ChatMessage[],
    streamingText: '',
    running: false,
    /** PASI-9：会话处于暂停态（上一轮执行被暂停；发送消息即恢复） */
    paused: false,
    /** 会话级权限模式（plan 只读 / default 询问确认 / yolo 全部放行） */
    permissionMode: 'default' as 'plan' | 'default' | 'yolo',
    /** F-37：底栏 git 状态（项目名 / 分支 / worktree 绑定）；非 git 仓库为 null */
    gitState: null as SessionGitState | null,
    pendingConfirm: null as ConfirmRequest | null,
    pendingPlan: null as null | { requestId: string; plan: PlanPayload },
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
      // 会话切换竞态防御：await 期间用户可能已切到其他会话，过期响应不得覆盖当前状态
      if (this.sessionId !== sessionId) return;
      this.sessionMeta = {
        title: detail.session.title,
        mode: detail.session.mode,
        model: detail.session.model,
      };
      this.messages = detail.messages;
      this.streamingText = '';
      this.running = false;
      // PASI-9：打开会话时同步暂停态（status 落库值）
      this.paused = detail.session.status === 'paused';
      // 会话级权限模式（失败保持默认，不阻塞会话打开）
      try {
        this.permissionMode = (await api.getPermission(sessionId)).mode;
      } catch {
        this.permissionMode = 'default';
      }
      // F-37：底栏 git 状态（失败静默，不阻塞会话打开）
      await this.loadGitState(sessionId);
      if (this.sessionId !== sessionId) return;
      this.pendingConfirm = null;
      this.pendingPlan = null;
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
      // 切换/关闭会话必须清空上一会话的全部 UI 状态：notices 渲染在对话区内，
      // 不清空会把旧会话的 token 统计 / 预算告警 / 错误提示带入新会话
      this.notices = [];
      this.running = false;
      this.paused = false;
      this.permissionMode = 'default';
      this.gitState = null;
      this.pendingConfirm = null;
      this.pendingPlan = null;
      this.pendingAsk = null;
    },
    notice(text: string) {
      this.notices.push({ id: this.noticeId++, text });
      if (this.notices.length > 20) this.notices.shift();
    },
    async onEvent(ev: { type: string; [k: string]: unknown }) {
      switch (ev.type) {
        case 'state':
          this.running = ev.running === true;
          // PASI-9：paused 仅在事件携带时更新（运行开始/暂停时服务端都会显式给出）
          if ('paused' in ev) this.paused = ev.paused === true;
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
          const result = ev.result as {
            callId: string;
            name: string;
            ok: boolean;
            content: string;
            meta?: { sandbox?: { mode: string; network?: string; ms?: number; degraded?: boolean } };
          };
          this.messages.push({
            role: 'tool',
            content: result.content,
            toolCallId: result.callId,
            // F-30 沙箱徽标（R8）：只在显式启用沙箱时存在，随实时 SSE 展示
            ...(result.meta?.sandbox ? { sandboxMeta: result.meta.sandbox } : {}),
          });
          break;
        }
        case 'confirm_request':
          this.pendingConfirm = ev.request as ConfirmRequest;
          break;
        // F-14 计划审批请求（引擎挂起等待决策）
        case 'plan_approval_request': {
          const req = ev.request as { id: string; plan: PlanPayload };
          this.pendingPlan = {
            requestId: String(req.id),
            plan: JSON.parse(JSON.stringify(req.plan)) as PlanPayload,
          };
          break;
        }
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
        case 'budget_alert': {
          const level = Math.round(Number(ev.level) * 100);
          const tokenPct = Math.round(Number(ev.usedTokenPct) * 100);
          const costPct = Math.round(Number(ev.usedCostPct) * 100);
          this.notice(`⚠ 预算告警（${level}%）：token ${tokenPct}% / 费用 ${costPct}%`);
          break;
        }
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
        // F-37：切换结果行内反馈（注入消息已落库，done 拉取后自然进消息流）
        case 'git_notice': {
          const text = String(ev.message ?? '');
          this.notice(text.replace(/^（系统提示：|\）$/g, ''));
          void this.loadGitState(this.sessionId); // 切换即刷新底栏
          break;
        }
        case 'done': {
          // done 前最后一次 text_delta 已累积 → 落为 assistant 消息（与桥的落库一致）
          if (this.streamingText) {
            this.messages.push({ role: 'assistant', content: this.streamingText });
            this.streamingText = '';
          }
          const usage = ev.usage as { inputTokens?: number; outputTokens?: number } | undefined;
          if (usage) this.notice(`本任务 token：${usage.inputTokens ?? 0} 入 / ${usage.outputTokens ?? 0} 出`);
          // 以服务端落库为准，重拉一次（期间会话已切换则丢弃过期响应，防止旧会话消息覆盖新会话）
          const sid = this.sessionId;
          const detail = await api.getSession(sid);
          if (this.sessionId === sid) this.messages = detail.messages;
          break;
        }
        default:
          break;
      }
    },
    async send(input: string, images?: MessageImage[]) {
      if (!this.sessionId || this.running) return;
      const userMessage: ChatMessage = { role: 'user', content: input };
      if (images?.length) userMessage.images = images; // F-25 多模态
      this.messages.push(userMessage);
      this.streamingText = '';
      this.paused = false; // PASI-9：发送即恢复（服务端 hub.send 同步清除 paused 落库）
      try {
        await api.send(this.sessionId, input, images);
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
    /** F-14：提交计划审批决策（edit 时把编辑后的 plan 一并回传）。 */
    async decidePlan(decision: { kind: 'approve' } | { kind: 'reject'; reason?: string } | { kind: 'edit' }) {
      if (!this.pendingPlan) return;
      const req = this.pendingPlan;
      this.pendingPlan = null;
      const payload =
        decision.kind === 'edit' ? { kind: 'edit', plan: req.plan } : decision;
      await api.approvePlan(this.sessionId, req.requestId, payload);
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
    /** PASI-9：暂停当前会话执行（状态经 SSE state 事件回推 paused:true） */
    async pause() {
      try {
        await api.pause(this.sessionId);
      } catch (e) {
        this.notice(`✘ ${(e as Error).message}`);
      }
    },
    /** 会话级权限模式切换（仅影响后续运行；yolo 放行所有写/执行操作） */
    async setPermissionMode(mode: 'plan' | 'default' | 'yolo') {
      try {
        await api.setPermission(this.sessionId, mode);
        this.permissionMode = mode;
        const label = mode === 'plan' ? '只读（写/执行类工具将被拒绝）'
          : mode === 'yolo' ? '全部放行（写文件、执行命令不再询问）'
          : '询问确认（写/执行操作前逐次确认）';
        this.notice(`已切换会话权限：${label}`);
      } catch (e) {
        this.notice(`✘ ${(e as Error).message}`);
      }
    },

    // ── F-37 git 分支切换 + worktree ──────────────────────────────────────

    /** 拉取底栏 git 状态（失败静默：非 git 项目 / 服务异常时底栏不渲染交互）。 */
    async loadGitState(sessionId: string) {
      try {
        this.gitState = await api.gitState(sessionId);
      } catch {
        this.gitState = null;
      }
    },

    /** 本地分支列表（弹层数据源）；失败返回 null（reason 已由调用方 toast）。 */
    async listBranches(): Promise<BranchInfo[] | null> {
      try {
        const r = await api.listBranches(this.sessionId);
        return r.branches;
      } catch (e) {
        this.notice(`✘ ${(e as Error).message}`);
        return null;
      }
    },

    /** 会话级分支切换（branch = 切到既有分支；newBranch = 就地新建）。 */
    async checkout(opts: { branch?: string; newBranch?: string }): Promise<boolean> {
      try {
        const r = await api.checkoutBranch(this.sessionId, opts);
        if (!r.ok) {
          this.notice(`✘ 切换失败：${r.reason ?? '未知原因'}`);
          return false;
        }
        this.notice(`⎇ 已切换到 ${r.branch}`);
        await this.loadGitState(this.sessionId);
        return true;
      } catch (e) {
        this.notice(`✘ ${(e as Error).message}`);
        return false;
      }
    },

    /** Worktree 开关（勾选切入 / 取消切回；目录保留）。 */
    async toggleWorktree(enabled: boolean, opts?: { branch?: string; newBranch?: string }): Promise<boolean> {
      try {
        const r = await api.setWorktree(this.sessionId, enabled, opts);
        if (!r.ok) {
          this.notice(`✘ ${enabled ? '切入' : '切回'}失败：${r.reason ?? '未知原因'}`);
          await this.loadGitState(this.sessionId); // 失败也回读，校准 checkbox 状态
          return false;
        }
        this.notice(
          enabled
            ? `🌿 已切入 worktree：${r.branch} @ ${r.path}`
            : '🌿 已切回主工作区（worktree 目录已保留，可用 yzero worktree remove 清理）',
        );
        await this.loadGitState(this.sessionId);
        return true;
      } catch (e) {
        this.notice(`✘ ${(e as Error).message}`);
        await this.loadGitState(this.sessionId);
        return false;
      }
    },
  },
});
