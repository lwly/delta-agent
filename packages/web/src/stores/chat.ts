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
    sessionMeta: null as null | {
      title: string;
      mode: string;
      model: string;
      /** F-39：绑定专家 name（会话字段 = 胶囊唯一真相；null = 无专家） */
      expert?: string | null;
      expertType?: string | null;
    },
    messages: [] as ChatMessage[],
    streamingText: '',
    running: false,
    /** PASI-9：会话处于暂停态（上一轮执行被暂停；发送消息即恢复） */
    paused: false,
    /** 会话级权限模式（plan 只读 / default 询问确认 / yolo 全部放行） */
    permissionMode: 'default' as 'plan' | 'default' | 'yolo',
    /** F-37：底栏 git 状态（项目名 / 分支 / worktree 绑定）；非 git 仓库为 null */
    gitState: null as SessionGitState | null,
    /** 待确认卡队列：同一轮可并发发出多个 confirm_request，全部按序渲染（后到不覆盖先到） */
    pendingConfirms: [] as ConfirmRequest[],
    /** 待审批计划队列（同轮可多次触发，按 requestId 独立回填） */
    pendingPlans: [] as Array<{ requestId: string; plan: PlanPayload }>,
    /** 待回答提问队列（同轮可多次 ask_user，按 requestId 独立回填） */
    pendingAsks: [] as Array<{ requestId: string; question: string; options?: string[] }>,
    notices: [] as Array<{ id: number; text: string }>,
    unsub: null as null | (() => void),
    noticeId: 1,
    // ── UI 本地状态（不来自服务端协议，见各字段注释）──────────────────
    /** 本地停止标志：点击停止置位（协议不回传"已停止"）；send / state(running=true) / done 时清除 */
    stopped: false,
    /** 上一次 done 事件的任务 token 用量（协议口径，状态条展示，不做假实时） */
    lastUsage: null as null | { inputTokens: number; outputTokens: number },
    /** callId → 调用元信息（tool_call_start 记录；结果卡配对 / 运行中卡片 / 本地耗时计算的数据源） */
    pendingCalls: {} as Record<string, { name: string; argsJson: string; startedAt: number; seq: number }>,
    /** 本次会话内工具调用递增序号（open 时归零；第 N 步展示口径） */
    toolSeq: 0,
    /** thinking_delta 流式思考文本累积（随其后落库的 assistant 消息保留；后端不下发则恒为空） */
    thinkingText: '',
    // ── F-39 专家 / 专家团 ──────────────────────────────────────────────
    /** 恢复会话时绑定包已删除（一次性提示的数据源；胶囊显示 ⚠） */
    expertMissing: false,
    /** 专家团成员卡（实时 SSE；不落库，done 后原地更新） */
    delegations: [] as Array<{
      memberId: string;
      memberName: string;
      profession: string;
      role: 'lead' | 'member';
      goal: string;
      status: 'running' | 'ok' | 'failed' | 'canceled';
      startedAt: number;
      ms?: number;
      summary?: string;
      readonlyDegraded?: boolean;
    }>,
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
      // UI 本地状态随会话切换重置（序号 / 计时 / 停止标志 / 思考文本均属会话作用域）
      this.stopped = false;
      this.lastUsage = null;
      this.pendingCalls = {};
      this.toolSeq = 0;
      this.thinkingText = '';
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
      // F-39：会话绑定状态（唯一权威来源；missing = 包已删除 → 降级提示一次）
      this.expertMissing = false;
      this.delegations = [];
      try {
        const st = await api.getSessionExpert(sessionId);
        if (this.sessionId !== sessionId) return;
        this.sessionMeta = {
          ...this.sessionMeta!,
          expert: st.bound?.name ?? null,
          expertType: st.bound?.expertType ?? null,
        };
        this.expertMissing = st.missing;
        if (st.missing && st.bound?.name) {
          this.notice(`原绑定专家「${st.bound.name}」已不存在，已按无专家运行`);
        }
      } catch {
        // 端点不可用（旧服务端）→ 静默
      }
      this.pendingConfirms = [];
      this.pendingPlans = [];
      this.pendingAsks = [];
      this.unsub = subscribeSession(sessionId, (ev) => this.onEvent(ev));
    },
    close() {
      this.unsub?.();
      this.unsub = null;
      this.sessionId = '';
      this.sessionMeta = null;
      this.expertMissing = false;
      this.delegations = [];
      this.messages = [];
      this.streamingText = '';
      // 切换/关闭会话必须清空上一会话的全部 UI 状态：notices 渲染在对话区内，
      // 不清空会把旧会话的 token 统计 / 预算告警 / 错误提示带入新会话
      this.notices = [];
      this.running = false;
      this.paused = false;
      this.permissionMode = 'default';
      this.gitState = null;
      this.pendingConfirms = [];
      this.pendingPlans = [];
      this.pendingAsks = [];
      this.stopped = false;
      this.lastUsage = null;
      this.pendingCalls = {};
      this.toolSeq = 0;
      this.thinkingText = '';
    },
    notice(text: string) {
      this.notices.push({ id: this.noticeId++, text });
      if (this.notices.length > 20) this.notices.shift();
    },
    async onEvent(ev: { type: string; [k: string]: unknown }) {
      switch (ev.type) {
        case 'state':
          this.running = ev.running === true;
          // 本地停止标志：新一轮运行开始即清除（用户点停止后又触发续跑的场景）
          if (this.running) this.stopped = false;
          // 运行结束：清空待决策卡（服务端 waiter 已随超时/中止收尾，残留卡不可再回填）
          if (!this.running) {
            this.pendingConfirms = [];
            this.pendingPlans = [];
            this.pendingAsks = [];
          }
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
          // 思考流式文本累积（后端不下发则恒为空，UI 区块自然不出现）
          this.thinkingText += String(ev.text ?? '');
          break;
        case 'turn_start':
          break;
        case 'tool_call_start': {
          const call = ev.call as { id: string; name: string; argsJson: string };
          // 助手消息（携带已累积的流式文本）落一条，工具调用跟随其后渲染为工具卡
          if (this.streamingText) {
            this.messages.push({
              role: 'assistant',
              content: this.streamingText,
              toolCalls: [call],
              ts: Date.now(),
              ...(this.thinkingText ? { thinking: this.thinkingText } : {}),
            });
            this.streamingText = '';
            this.thinkingText = '';
          }
          // 记录调用元信息：结果未到时渲染「运行中」卡片，结果到达时配对并计算本地耗时
          this.toolSeq += 1;
          this.pendingCalls[call.id] = {
            name: call.name,
            argsJson: call.argsJson,
            startedAt: Date.now(),
            seq: this.toolSeq,
          };
          break;
        }
        case 'tool_result': {
          const result = ev.result as {
            callId: string;
            name: string;
            ok: boolean;
            content: string;
            meta?: {
              sandbox?: { mode: string; network?: string; ms?: number; degraded?: boolean };
              /** F-39：专家团成员标识（task 工具回传；实时数据源） */
              agent_name?: string;
            };
          };
          const callMeta = this.pendingCalls[result.callId];
          this.messages.push({
            role: 'tool',
            content: result.content,
            toolCallId: result.callId,
            // UI 本地字段：本地接收时间 / 本地计时耗时 / 调用序号 / ok 原值
            ts: Date.now(),
            ok: result.ok,
            ...(callMeta ? { durationMs: Date.now() - callMeta.startedAt, toolSeq: callMeta.seq } : {}),
            // F-30 沙箱徽标（R8）：只在显式启用沙箱时存在，随实时 SSE 展示
            ...(result.meta?.sandbox ? { sandboxMeta: result.meta.sandbox } : {}),
            // F-39：「由 X 执行」角标（实时数据源 = meta.agent_name；回放 = content 前缀）
            ...(result.meta?.agent_name ? { agentName: result.meta.agent_name } : {}),
          });
          break;
        }
        case 'confirm_request': {
          const req = ev.request as ConfirmRequest;
          // 入队而非覆盖：同轮并发多个确认请求时全部渲染（SSE 重放时按 id 去重）
          if (!this.pendingConfirms.some((p) => p.id === req.id)) this.pendingConfirms.push(req);
          break;
        }
        // F-14 计划审批请求（引擎挂起等待决策）
        case 'plan_approval_request': {
          const req = ev.request as { id: string; plan: PlanPayload };
          const entry = {
            requestId: String(req.id),
            plan: JSON.parse(JSON.stringify(req.plan)) as PlanPayload,
          };
          if (!this.pendingPlans.some((p) => p.requestId === entry.requestId)) this.pendingPlans.push(entry);
          break;
        }
        case 'ask_user': {
          const entry = {
            requestId: String(ev.requestId),
            question: String(ev.question),
            options: ev.options as string[] | undefined,
          };
          if (!this.pendingAsks.some((p) => p.requestId === entry.requestId)) this.pendingAsks.push(entry);
          break;
        }
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
        // ── F-39：专家团成员委派事件（成员卡；start 追加 / done 原地更新）──
        case 'expert_delegate_start': {
          const e = ev as unknown as { memberId: string; memberName: string; profession: string; role: 'lead' | 'member'; goal: string; startedAt: number };
          this.delegations.push({
            memberId: e.memberId,
            memberName: e.memberName,
            profession: e.profession,
            role: e.role,
            goal: e.goal,
            status: 'running',
            startedAt: e.startedAt,
          });
          break;
        }
        case 'expert_delegate_done': {
          const e = ev as unknown as { memberId: string; status: 'ok' | 'failed' | 'canceled'; ms: number; summary: string; readonlyDegraded?: boolean };
          const card = [...this.delegations].reverse().find((d) => d.memberId === e.memberId && d.status === 'running');
          if (card) {
            card.status = e.status;
            card.ms = e.ms;
            card.summary = e.summary;
            card.readonlyDegraded = e.readonlyDegraded;
          }
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
            this.messages.push({
              role: 'assistant',
              content: this.streamingText,
              ts: Date.now(),
              ...(this.thinkingText ? { thinking: this.thinkingText } : {}),
            });
            this.streamingText = '';
            this.thinkingText = '';
          }
          const usage = ev.usage as { inputTokens?: number; outputTokens?: number } | undefined;
          if (usage) {
            this.lastUsage = { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 };
            this.notice(`本任务 token：${this.lastUsage.inputTokens} 入 / ${this.lastUsage.outputTokens} 出`);
          }
          this.stopped = false;
          // 以服务端落库为准重拉一次（期间会话已切换则丢弃过期响应，防止旧会话消息覆盖新会话）。
          // 本地 UI 字段（ts/thinking/durationMs/toolSeq/ok）按 role+content 回带：
          // 数据仍来自本地真实记录，仅避免「运行结束瞬间时间戳/耗时消失」的回退观感
          const carry = new Map<string, Partial<ChatMessage>>();
          for (const m of this.messages) {
            const extras: Partial<ChatMessage> = {};
            if (m.ts != null) extras.ts = m.ts;
            if (m.thinking) extras.thinking = m.thinking;
            if (m.durationMs != null) extras.durationMs = m.durationMs;
            if (m.toolSeq != null) extras.toolSeq = m.toolSeq;
            if (m.ok != null) extras.ok = m.ok;
            if (Object.keys(extras).length > 0) carry.set(`${m.role}\u0000${m.content}`, extras);
          }
          const sid = this.sessionId;
          const detail = await api.getSession(sid);
          if (this.sessionId === sid) {
            this.messages = detail.messages.map((m) => {
              const ex = carry.get(`${m.role}\u0000${m.content}`);
              return ex ? { ...m, ...ex } : m;
            });
          }
          break;
        }
        default:
          break;
      }
    },
    async send(input: string, images?: MessageImage[]) {
      if (!this.sessionId || this.running) return;
      const userMessage: ChatMessage = { role: 'user', content: input, ts: Date.now() };
      if (images?.length) userMessage.images = images; // F-25 多模态
      this.messages.push(userMessage);
      this.streamingText = '';
      this.paused = false; // PASI-9：发送即恢复（服务端 hub.send 同步清除 paused 落库）
      this.stopped = false; // 本地停止标志：重新发送即清除（含从停止点继续的场景）
      this.thinkingText = '';
      try {
        await api.send(this.sessionId, input, images);
      } catch (e) {
        this.notice(`✘ ${(e as Error).message}`);
        this.messages.pop();
      }
    },
    /** 按 id 回填确认决策（队列中移除对应卡片；id 不存在说明已被清理，忽略） */
    async decideConfirm(id: string, decision: { kind: 'allow' } | { kind: 'reject'; reason?: string }) {
      const idx = this.pendingConfirms.findIndex((p) => p.id === id);
      if (idx === -1) return;
      const [req] = this.pendingConfirms.splice(idx, 1);
      await api.confirm(this.sessionId, req.id, decision);
    },
    /** F-14：按 requestId 提交计划审批决策（edit 时把编辑后的 plan 一并回传）。 */
    async decidePlan(requestId: string, decision: { kind: 'approve' } | { kind: 'reject'; reason?: string } | { kind: 'edit' }) {
      const idx = this.pendingPlans.findIndex((p) => p.requestId === requestId);
      if (idx === -1) return;
      const [req] = this.pendingPlans.splice(idx, 1);
      const payload =
        decision.kind === 'edit' ? { kind: 'edit', plan: req.plan } : decision;
      await api.approvePlan(this.sessionId, req.requestId, payload);
    },
    /** 按 requestId 回填 ask_user 的文本回答。 */
    async answerAsk(requestId: string, answer: string) {
      const idx = this.pendingAsks.findIndex((p) => p.requestId === requestId);
      if (idx === -1) return;
      const [ask] = this.pendingAsks.splice(idx, 1);
      await api.answer(this.sessionId, ask.requestId, answer);
    },
    async abort() {
      // 本地停止标志（协议不回传"已停止"）：状态条 / composer 据此转「已停止」态；
      // 下一次 send / state(running=true) / done 自动清除。
      // 加固：abort 请求失败时回滚标志（避免 UI 卡在「已停止」假态）并以 notice 反馈；
      // state 事件随后仍会按服务端真实状态兜底校准
      this.stopped = true;
      try {
        await api.abort(this.sessionId);
      } catch (e) {
        this.stopped = false;
        this.notice(`✘ 停止失败：${(e as Error).message}`);
      }
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
            : '🌿 已切回主工作区（worktree 目录已保留，可用 delta worktree remove 清理）',
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
