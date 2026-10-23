/**
 * SessionHub：会话运行桥（technical-design §10 关键时序）
 * - send(sessionId, input)：组装 RunContext → runReAct → 事件扇出（SSE 订阅者）+ 落库
 * - 确认/提问流：confirm_request / ask 事件 + waiter，由 HTTP 端点回填决策
 * - 运行中会话注册表复用 SessionService（删除前中止语义一致）
 */
import type {
  AgentEvent,
  ChatMessage,
  ConfirmDecision,
  ConfirmRequest,
  LLMProvider,
  MessageImage,
  PlanDecision,
  ToolCall,
} from '@y-zero/shared';
import {
  BudgetManager,
  PromptBuilder,
  SessionService,
  SkillBuffer,
  SplitPromptAssembler,
  ToolRegistry,
  PermissionState,
  GitIntegration,
  discoverSkills,
  type SkillRuntime,
  type PermissionMode,
  type GitPolicy,
  type Notifier,
} from '../index.js';
import { runReAct, type RunContext, type PlanOptions } from '../engine/react.js';
import { runPlanExecute } from '../engine/plan-execute.js';
import { runMultiAgent } from '../engine/orchestrator.js';
import { modeSegment } from '../engine/mode-prompt.js';
import { distillMemories } from '../session/distill.js';
import { ModelRouter, type RoutingTaskKind } from '../llm/router.js';
import type { HookManager } from '../hooks/manager.js';
import * as path from 'node:path';
import * as os from 'node:os';

/** 推送给 Web 的事件：AgentEvent + 桥接控制事件 */
export type HubEvent =
  | AgentEvent
  | { type: 'confirm_request'; request: ConfirmRequest }
  | { type: 'ask_user'; requestId: string; question: string; options?: string[] }
  | { type: 'run_error'; message: string }
  | { type: 'git_notice'; message: string }
  /** paused 仅在状态变化时携带（PASI-9 暂停语义：本轮中止、状态落库，发消息即恢复） */
  | { type: 'state'; running: boolean; paused?: boolean };

export interface SessionHubDeps {
  service: SessionService;
  registry: ToolRegistry;
  /** 每次运行解析 Provider（配置可能被 Web 设置页修改） */
  resolveProvider: () => Promise<LLMProvider>;
  /** 默认模型（会话未指定时） */
  defaultModel?: string;
  /** 上下文窗口（默认 200k） */
  windowTokens?: number;
  maxTurns?: number;
  /** Skill 两阶段加载 runtime（注入每次运行的 ToolContext.skills） */
  skills?: SkillRuntime;
  /** M5: Plan/Multi-Agent 编排参数（worker 数、重试上限、强制规划/直达） */
  plan?: PlanOptions;
  /** 记忆里程碑：自动提炼开关（默认开启；每次任务结束后提炼 0-3 条待确认候选） */
  autoDistill?: boolean;
  /** F-23 权限模式（默认 default；Web 设置页/启动参数可配） */
  permissionMode?: PermissionMode;
  /** F-23 工具级 allowlist（default 模式下命中跳过确认） */
  allowTools?: string[];
  /** F-24 git 策略（off/suggest/auto；auto = 任务结束自动提交本会话记录的文件变更） */
  gitPolicy?: GitPolicy;
  /** F-27 Hook 系统（工具钩子 + SessionStart/Stop 生命周期；缺省不挂钩） */
  hooks?: HookManager;
  /** F-32 模型路由器（缺省不路由：辅助调用跟随会话主模型） */
  modelRouter?: ModelRouter;
  /** F-32 按 provider id 构建 LLM 实例（路由规则指定 provider 时使用；缺省复用 resolveProvider） */
  resolveProviderById?: (id: string) => Promise<LLMProvider>;
  /** F-33 桌面通知器（缺省不通知；任务结束 / 确认卡出现时旁路触发） */
  notify?: Notifier;
}

interface PendingConfirm {
  kind: 'confirm';
  resolve: (d: ConfirmDecision) => void;
}
interface PendingAsk {
  kind: 'ask';
  resolve: (answer: string) => void;
}
interface PendingPlan {
  kind: 'plan';
  resolve: (d: PlanDecision) => void;
}

export class SessionHub {
  /** F-27：已触发 SessionStart 的会话（每会话一次） */
  private readonly sessionStarted = new Set<string>();
  private readonly subs = new Map<string, Set<(ev: HubEvent) => void>>();
  private readonly waiters = new Map<string, PendingConfirm | PendingAsk | PendingPlan>();
  private running = new Set<string>();

  constructor(private readonly deps: SessionHubDeps) {}

  // ── 订阅（SSE）──────────────────────────────────────────────────────────

  subscribe(sessionId: string, fn: (ev: HubEvent) => void): () => void {
    let set = this.subs.get(sessionId);
    if (!set) {
      set = new Set();
      this.subs.set(sessionId, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.subs.delete(sessionId);
    };
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  /** 当前所有运行中的会话 id（Web 侧栏运行态徽标 / 删除门禁的数据源）。 */
  runningSessionIds(): string[] {
    return [...this.running];
  }

  /** 会话是否处于暂停态（status 落库为 paused；执行中止即本轮结束，不占运行中）。 */
  isPaused(sessionId: string): boolean {
    return this.deps.service.getSession(sessionId)?.status === 'paused';
  }

  /**
   * 暂停执行中的会话（PASI-9）：中止主循环并把状态落库为 paused。
   * 返回 false 表示会话未在执行（无可暂停的运行）。
   */
  pause(sessionId: string): boolean {
    const ok = this.deps.service.pauseRun(sessionId);
    if (ok) {
      // 引擎收尾是异步的（finally 稍后还会发 running:false），这里先推暂停态供前端即时切换
      this.publish(sessionId, { type: 'state', running: false, paused: true });
    }
    return ok;
  }

  private publish(sessionId: string, ev: HubEvent): void {
    for (const fn of this.subs.get(sessionId) ?? []) {
      try {
        fn(ev);
      } catch {
        // 订阅者异常不影响其他订阅者
      }
    }
  }

  // ── 确认 / 提问回填 ─────────────────────────────────────────────────────

  /** HTTP 端点回填确认决策（allow / reject / edit）。 */
  confirm(requestId: string, decision: ConfirmDecision): boolean {
    const w = this.waiters.get(requestId);
    if (!w || w.kind !== 'confirm') return false;
    this.waiters.delete(requestId);
    w.resolve(decision);
    return true;
  }

  /** HTTP 端点回填 ask_user 的文本回答。 */
  answer(requestId: string, answer: string): boolean {
    const w = this.waiters.get(requestId);
    if (!w || w.kind !== 'ask') return false;
    this.waiters.delete(requestId);
    w.resolve(answer);
    return true;
  }

  /** HTTP 端点回填计划审批决策（approve / edit / reject）。 */
  planDecision(requestId: string, decision: PlanDecision): boolean {
    const w = this.waiters.get(requestId);
    if (!w || w.kind !== 'plan') return false;
    this.waiters.delete(requestId);
    w.resolve(decision);
    return true;
  }

  // ── 运行 ────────────────────────────────────────────────────────────────

  /**
   * F-32：解析某类辅助任务的路由目标（如 distill 用小模型）。
   * 未启用路由 / 规则缺失 / 目标 provider 构建失败时返回 undefined，调用方回退会话主模型。
   */
  private async routeAux(kind: RoutingTaskKind): Promise<{ provider: LLMProvider; model: string } | undefined> {
    const target = this.deps.modelRouter?.resolve(kind);
    if (!target) return undefined;
    try {
      const provider = target.provider
        ? await (this.deps.resolveProviderById ?? this.deps.resolveProvider)(target.provider)
        : await this.deps.resolveProvider();
      return { provider, model: target.model };
    } catch {
      return undefined; // 路由目标不可用 → 回退主模型，不阻塞任务
    }
  }

  abort(sessionId: string): boolean {
    return this.deps.service.abortRun(sessionId);
  }

  /** 发起一轮对话：阻塞到引擎结束（事件经 publish 实时推送）。images = F-25 图片附件（已完成校验）。 */
  async send(sessionId: string, input: string, images?: MessageImage[]): Promise<void> {
    if (this.running.has(sessionId)) {
      throw new Error('session is already running');
    }
    const session = this.deps.service.getSession(sessionId);
    if (!session) throw new Error('session not found');
    const project = this.deps.service.getProject(session.project_id);
    if (!project) throw new Error('project not found');
    // PASI-9：暂停会话恢复 = 继续发消息，清除 paused 标记后按正常流程执行
    this.deps.service.resumeSession(sessionId);

    this.running.add(sessionId);
    this.publish(sessionId, { type: 'state', running: true, paused: false });
    // M5: 崩溃恢复——本会话孤儿任务（租约过期的 running）先回 queued
    try {
      this.deps.service.recoverTasks(sessionId);
    } catch {
      // 恢复失败不阻塞本轮运行
    }
    // 用户消息立即落库（即使 Provider 解析失败也不丢输入）
    const userMessage: ChatMessage = { role: 'user', content: input };
    if (images && images.length > 0) userMessage.images = images;
    this.deps.service.appendMessage(sessionId, userMessage);

    const service = this.deps.service;
    const startedAt = Date.now(); // F-33：任务时长门槛判定基准
    let assistantText = '';
    const collectedCalls: ToolCall[] = [];
    let assistantSaved = false;
    let acRef: AbortController | null = null; // F-33：finally 判定 aborted / failed 状态用
    let runError: string | null = null;
    // F-31：usage 事件计数器（每轮 +1），逐轮落库（D5，替代 done 一次性 turn=0）
    let usageTurn = 0;
    const saveAssistantWithCalls = () => {
      if (assistantSaved) return;
      service.appendMessage(sessionId, {
        role: 'assistant',
        content: assistantText,
        toolCalls: [...collectedCalls],
      });
      assistantSaved = true;
    };

    try {
      const provider = await this.deps.resolveProvider();
      const ac = new AbortController();
      acRef = ac;
      service.registerRun(sessionId, ac);

      // F-27 SessionStart 钩子：每会话首次运行触发一次（旁路触发）
      if (this.deps.hooks?.has('SessionStart') && !this.sessionStarted.has(sessionId)) {
        this.sessionStarted.add(sessionId);
        void this.deps.hooks.emit('SessionStart', { sessionId, projectId: session.project_id });
      }

      const budget = new BudgetManager();
      const { staticText, dynamicText } = await this.buildPrompt(
        project.root_path,
        session.model || this.deps.defaultModel || 'claude-sonnet-4-5-20250929',
        this.deps.registry.definitions(),
      );
      const askId = `ask_${sessionId}_${Date.now()}`;

      // 记忆里程碑：本轮输入的 L2 记忆召回（Top-K 注入动态段，最后追加不动缓存前缀）
      const memoryScopes = ['global', `project:${session.project_id}`, `session:${sessionId}`];
      const memoryBlock = this.renderMemoryRecall(input, memoryScopes);
      const ctxMode = (['react', 'plan-execute', 'multi-agent'].includes(session.mode)
        ? session.mode
        : 'react') as RunContext['mode'];

      const ctx: RunContext = {
        sessionId,
        projectId: session.project_id,
        mode: ctxMode,
        model: session.model || this.deps.defaultModel || 'claude-sonnet-4-5-20250929',
        systemPrompt: staticText,
        systemPromptParts: {
          staticText,
          // 记忆召回块 + M5 模式段最后追加（prompt-design §5），切换模式不动缓存前缀
          dynamicText: [dynamicText, memoryBlock, modeSegment(ctxMode, this.deps.plan)]
            .filter((t) => t.length > 0)
            .join('\n\n'),
        },
        maxTurns: this.deps.maxTurns ?? 50,
        signal: ac.signal,
        provider,
        registry: this.deps.registry,
        toolContext: {
          projectRoot: project.root_path,
          signal: ac.signal,
          sessionId,
          projectId: session.project_id,
          memory: service.memory,
          // F-24 文件变更管理：写工具自动快照（diff 汇总/回滚走 HTTP 层读 service.changes）
          changes: service.changes,
          // F-23 权限模式（每次运行新建：allow_session 记忆随运行结束重置）
          permissions: new PermissionState({
            mode: this.deps.permissionMode ?? 'default',
            allowlist: this.deps.allowTools,
          }),
          confirm: async (req: ConfirmRequest) => {
            // F-33 桌面通知：确认卡出现（等人事件，旁路 fire-and-forget，不受时长门槛约束）
            try {
              this.deps.notify?.notifyConfirm({ tool: req.tool, reason: req.reason });
            } catch {
              // 通知失败不影响确认流
            }
            this.publish(sessionId, { type: 'confirm_request', request: req });
            return new Promise<ConfirmDecision>((resolve) => {
              this.waiters.set(req.id, { kind: 'confirm', resolve });
            });
          },
          askUser: async (question: string, options?: string[]) => {
            this.publish(sessionId, { type: 'ask_user', requestId: askId, question, options });
            return new Promise<string>((resolve) => {
              this.waiters.set(askId, { kind: 'ask', resolve });
            });
          },
          todos: [],
          skills: this.deps.skills,
          // F-27 Hook 系统：工具执行挂钩（PreToolUse 可阻断 / PostToolUse 记录）
          hooks: this.deps.hooks,
          // F-26 子代理即工具：注入父注册表与子代理运行时（只读隔离，用量回写本运行预算）
          registry: this.deps.registry,
          subagent: {
            provider,
            model: session.model || this.deps.defaultModel || 'claude-sonnet-4-5-20250929',
            budget,
            budgetConfig: budget.config,
            windowTokens: this.deps.windowTokens ?? 200_000,
            depth: 0,
          },
        },
        budget,
        windowTokens: this.deps.windowTokens ?? 200_000,
        plan: this.deps.plan,
        tasks: service.tasks,
        // F-14 计划确认流：Web 端回填决策（挂起等待，事件实时推送）；multi-agent 与 plan-execute 同源支持
        planApproval:
          ctxMode === 'plan-execute' || ctxMode === 'multi-agent'
            ? (req) => {
                this.publish(sessionId, { type: 'plan_approval_request', request: req });
                return new Promise<PlanDecision>((resolve) => {
                  this.waiters.set(req.id, { kind: 'plan', resolve });
                });
              }
            : undefined,
      };

      const history: ChatMessage[] = service.getHistory(sessionId);

      // M5: 按会话模式分发引擎（ReAct / Plan-and-Execute / Multi-Agent）
      const engine =
        ctx.mode === 'plan-execute'
          ? runPlanExecute
          : ctx.mode === 'multi-agent'
            ? runMultiAgent
            : runReAct;
      for await (const ev of engine(ctx, history.slice(0, -1), input, images)) {
        this.publish(sessionId, ev);
        switch (ev.type) {
          case 'text_delta':
            assistantText += ev.text;
            break;
          case 'thinking_delta':
            break;
          case 'tool_call_start':
            saveAssistantWithCalls();
            collectedCalls.push(ev.call);
            assistantSaved = false;
            break;
          case 'tool_result': {
            // 工具结果落库（与 CLI App 落库策略一致）
            service.appendMessage(sessionId, {
              role: 'tool',
              content: ev.result.content,
              toolCallId: ev.result.callId,
            });
            break;
          }
          case 'usage': {
            // F-31：逐轮落库（每条 usage 事件一行；子代理用量事件同样计入，口径 = usage 行数）
            usageTurn++;
            service.recordUsage(
              sessionId,
              usageTurn,
              ev.usage.inputTokens,
              ev.usage.outputTokens,
              ev.usage.costUsd ?? 0,
              ev.model ?? ctx.model,
            );
            break;
          }
          case 'done': {
            if (!assistantSaved && assistantText) {
              service.appendMessage(sessionId, { role: 'assistant', content: assistantText });
            }
            assistantSaved = true;
            // 记忆里程碑：任务结束自动提炼（0-3 条候选进待确认队列；默认开启）
            if (this.deps.autoDistill !== false && !ac.signal.aborted) {
              const transcript = service
                .getHistory(sessionId)
                .map((m) => `${m.role}: ${m.content}`)
                .join('\n');
              // F-32：提炼属轻量辅助调用，优先走路由规则指定的小模型（未配置则回退主模型）
              const routed = await this.routeAux('distill');
              void distillMemories(service.memory, routed?.provider ?? provider, routed?.model ?? ctx.model, {
                scope: `project:${session.project_id}`,
                transcript,
                signal: ac.signal,
              }).catch(() => undefined); // 提炼失败不阻塞交付
            }
            // F-24 git 自动 commit 策略：提交本会话记录在案的文件变更
            if (this.deps.gitPolicy?.mode === 'auto' && !ac.signal.aborted) {
              const git = new GitIntegration(project.root_path, this.deps.gitPolicy, ac.signal);
              void git
                .autoCommitChanges(sessionId, service.changes, input)
                .then((out) => {
                  if (out.ok && out.hash) {
                    this.publish(sessionId, { type: 'git_notice', message: `已自动提交 ${out.hash}（仅本会话变更的文件）` });
                  } else if (out.reason && out.reason !== 'nothing to commit for recorded paths') {
                    this.publish(sessionId, { type: 'git_notice', message: `自动提交跳过：${out.reason}` });
                  }
                })
                .catch(() => undefined);
            }
            break;
          }
          case 'compact_done':
            service.recordCompaction(sessionId, ev.beforeTokens, ev.afterTokens, '');
            break;
          default:
            break;
        }
      }
    } catch (e) {
      runError = (e as Error).message;
      this.publish(sessionId, { type: 'run_error', message: (e as Error).message });
      if (assistantText && !assistantSaved) {
        this.deps.service.appendMessage(sessionId, { role: 'assistant', content: assistantText });
      }
    } finally {
      this.running.delete(sessionId);
      this.deps.service.unregisterRun(sessionId);
      this.publish(sessionId, { type: 'state', running: false });
      // F-33 桌面通知：任务结束（旁路 fire-and-forget；enabled/onDone/minDurationMs 在 notifier 内判定）
      try {
        this.deps.notify?.notifyDone({
          status: runError ? 'failed' : acRef?.signal.aborted ? 'aborted' : 'completed',
          durationMs: Date.now() - startedAt,
          summary: runError ?? assistantText,
        });
      } catch {
        // 通知失败不影响运行收尾
      }
      // F-27 Stop 钩子：单次任务结束（旁路触发，不影响结果）
      void this.deps.hooks?.emit('Stop', { sessionId, projectId: session.project_id });
    }
  }

  /** L2 记忆召回块（空则返回空串，动态段自动隐藏）。 */
  private renderMemoryRecall(input: string, scopes: string[]): string {
    try {
      const hits = this.deps.service.memory.recall(input, scopes, 5);
      if (hits.length === 0) return '';
      const lines = hits.map((h) => `- (${h.item.kind}) ${h.item.content}`);
      return `## 相关长期记忆（自动召回）\n${lines.join('\n')}`;
    } catch {
      return '';
    }
  }

  /** 组装静态/动态分段提示词（与 CLI 同源：7 层 + Skill 索引）。 */
  private async buildPrompt(
    projectRoot: string,
    model: string,
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
  ): Promise<{ staticText: string; dynamicText: string }> {
    const { promises: fs } = await import('node:fs');
    const assembler = new SplitPromptAssembler();

    const read = async (file: string, max: number): Promise<string> => {
      try {
        const t = await fs.readFile(file, 'utf-8');
        return t.length > max ? `${t.slice(0, max)}\n（已截断）` : t;
      } catch {
        return '';
      }
    };
    const [readme, staticMemory] = await Promise.all([
      read(path.join(projectRoot, 'README.md'), 2_000),
      read(path.join(projectRoot, '.y-zero', 'agent.md'), 4_000),
    ]);

    const { skills } = await discoverSkills({ projectRoot, homeDir: os.homedir() });
    const ctx = {
      projectName: path.basename(projectRoot),
      projectInstructions: readme,
      staticMemory,
      tools: tools.map((t) => ({ name: t.name, description: t.description, schema: t.parameters })),
      skillIndex: skills.map((s) => ({ name: s.name, description: s.description, triggers: s.triggers })),
      session: {
        cwd: projectRoot,
        now: new Date(),
        model,
        contextWindow: this.deps.windowTokens ?? 200_000,
      },
    };
    const split = assembler.assemble(ctx);
    const final = new PromptBuilder().build(split);
    return { staticText: final.staticText, dynamicText: final.dynamicText };
  }
}

/** 便捷构造 SkillRuntime（load/unload 供 HTTP 层装配进 ToolContext.skills） */
export async function createSkillRuntime(projectRoot: string): Promise<SkillRuntime> {
  const buffer = new SkillBuffer();
  const { skills } = await discoverSkills({ projectRoot, homeDir: os.homedir() });
  return {
    async load(name: string) {
      const skill = skills.find((s) => s.name === name);
      if (!skill) return { ok: false, content: `未找到 Skill：${name}` };
      const entry = buffer.load(skill);
      return { ok: true, content: `Skill ${name} 已加载（下一轮生效）。\n\n${entry.content}` };
    },
    unload(name: string) {
      return buffer.unload(name)
        ? { ok: true, content: `Skill ${name} 已卸载。` }
        : { ok: false, content: `未加载 Skill：${name}` };
    },
  };
}
