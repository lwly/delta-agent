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
} from '@delta/shared';
import {
  BudgetManager,
  defaultModelFor,
  PromptBuilder,
  SessionService,
  SkillBuffer,
  SplitPromptAssembler,
  ToolRegistry,
  PermissionState,
  GitIntegration,
  WorktreeManager,
  discoverSkills,
  ExpertStore,
  branchSwitchMessage,
  worktreeOnMessage,
  worktreeOffMessage,
  resolveWorkRoot,
  buildAssembleContext,
  resolveToolAllow,
  restrictRegistry,
  seedExpertSkills,
  toTeamRuntime,
  type ExpertRecord,
  type SkillRuntime,
  type PermissionMode,
  type GitPolicy,
  type Notifier,
  type BranchInfo,
  type BudgetConfig,
} from '../index.js';
import { runReAct, type RunContext, type PlanOptions } from '../engine/react.js';
import { runPlanExecute } from '../engine/plan-execute.js';
import { runMultiAgent } from '../engine/orchestrator.js';
import { modeSegment } from '../engine/mode-prompt.js';
import { distillMemories } from '../session/distill.js';
import { ModelRouter, type RoutingTaskKind } from '../llm/router.js';
import type { HookManager } from '../hooks/manager.js';
import * as path from 'node:path';
import { FILES, projectConfigDir } from '../paths.js';
import type { RunLogSink, LogLevel } from '../logging/logger.js';
import * as os from 'node:os';
import * as fs from 'node:fs';

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
  /**
   * 会话预算配置解析（每次运行调用一次）：maxTokens / maxCostUsd 覆盖默认 200k / $0.7。
   * serve 运行时传 ~/.delta/settings.json 的 budget 键读取器，设置页修改后下一轮生效。
   */
  resolveBudgetConfig?: () => Partial<BudgetConfig>;
  /** F-33 桌面通知器（缺省不通知；任务结束 / 确认卡出现时旁路触发） */
  notify?: Notifier;
  /** F-41 运行日志 sink（缺省不记录；serve 运行时注入 RunLog，埋点见 design-f41 §4） */
  runLog?: RunLogSink;
}

// ── F-37 git 分支切换 + worktree 会话级隔离（编排单点，D1/D7）──────────────

/** 底栏 git 状态（GET 语义，无副作用）；running 为前端置灰判断的权威来源。 */
export interface SessionGitState {
  isRepo: boolean;
  /** path.basename(project.root_path) */
  projectName: string;
  /** 当前工作根分支（detached → 短 hash） */
  branch: string | null;
  worktree: { enabled: boolean; path: string | null; branch: string | null };
  running: boolean;
}

export interface BranchSwitchResult {
  ok: boolean;
  reason?: string;
  /** checkout 后生效的分支名 */
  branch?: string;
  /** worktree 切入后的绝对路径 */
  path?: string;
}

/** 等人决策种类（确认 / 提问 / 计划审批共用一套 waiter 机制） */
type DecisionKind = 'confirm' | 'ask' | 'plan';

interface DecisionWaiter {
  kind: DecisionKind;
  resolve: (v: unknown) => void;
  /** 超时 / 运行中止时以 reject 收尾（engine 侧转为工具错误结果，不再永久悬挂） */
  reject: (e: Error) => void;
}

/**
 * 等人决策等待上限：确认卡/提问/计划审批超过此时长未回填即 reject。
 * 此前是裸 Promise（只 resolve 不 reject、不监听 abort），点「停止」都停不下来，
 * running 标记只能等 zombieReap 的 30 分钟上限才清理。
 */
export const DECISION_TIMEOUT_MS = 30 * 60_000;

/**
 * 创建等人决策 Promise：
 * - 正常路径：HTTP 端点回填 → entry.resolve(v)（waiters 移除由 unregister 完成）
 * - 超时路径：reject（错误信息回传为工具结果，运行继续）
 * - 中止路径：signal abort → reject（与点「停止」联动，引擎立即收尾）
 * 已 settle 后的所有后续回调（重复 resolve / 超时 / abort）一律忽略。
 */
export function createDecisionWaiter<T>(
  kind: DecisionKind,
  signal: AbortSignal,
  opts: {
    timeoutMs?: number;
    register?: (e: DecisionWaiter) => void;
    unregister?: (e: DecisionWaiter) => void;
  } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let entry!: DecisionWaiter;
    const onAbort = () => entry.reject(new Error('运行已中止，等待用户决策取消'));
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      opts.unregister?.(entry);
      fn();
    };
    entry = {
      kind,
      resolve: (v) => finish(() => resolve(v as T)),
      reject: (e) => finish(() => reject(e)),
    };
    timer = setTimeout(
      () => entry.reject(new Error(`等待用户决策超时（${kind} 等待超过 ${Math.round((opts.timeoutMs ?? DECISION_TIMEOUT_MS) / 60_000)} 分钟未响应）`)),
      opts.timeoutMs ?? DECISION_TIMEOUT_MS,
    );
    timer.unref?.(); // 超时定时器不阻止进程退出
    signal.addEventListener('abort', onAbort, { once: true });
    opts.register?.(entry);
  });
}

export class SessionHub {
  /** F-27：已触发 SessionStart 的会话（每会话一次） */
  private readonly sessionStarted = new Set<string>();
  private readonly subs = new Map<string, Set<(ev: HubEvent) => void>>();
  private readonly waiters = new Map<string, DecisionWaiter>();
  /** 运行中会话：AbortController 用于僵尸判定（aborted = 用户已点停止但收尾卡死） */
  private running = new Map<string, { ac: AbortController; startedAt: number }>();
  /** 会话级权限模式覆盖（未设置的会话回退 deps.permissionMode / default） */
  private readonly sessionPermissionModes = new Map<string, PermissionMode>();

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
    return this.zombieReap(sessionId) ? false : this.running.has(sessionId);
  }

  /**
   * 系统集成工具清单（Web 设置页「功能」面板数据源）：
   * 内置工具 + 已接入的 MCP 工具（同一注册表，introspect 携带危险级）。
   */
  toolInventory(): Array<{ name: string; description: string; danger: string }> {
    return this.deps.registry.introspect();
  }

  /**
   * 僵尸运行清理：引擎可能卡死在不可中断的 await 上（如网关流挂死），
   * abort 信号无法穿透 → finally 不执行 → running 永不清理 → 会话被永久锁死（发消息 409）。
   * 判定：AbortController 已中止（用户点过停止但收尾未完成）或运行超 30 分钟。
   * 返回 true 表示本次清掉了一个僵尸。
   */
  private zombieReap(sessionId: string): boolean {
    const entry = this.running.get(sessionId);
    if (!entry) return false;
    const stale = entry.ac.signal.aborted || Date.now() - entry.startedAt > 30 * 60_000;
    if (!stale) return false;
    this.running.delete(sessionId);
    try {
      entry.ac.abort(); // 确保 engine 侧信号也置位
    } catch {
      // 已 abort 的 Controller 重复 abort 不抛错，防御性忽略
    }
    this.publish(sessionId, { type: 'run_error', message: '运行已超时/中止，运行状态已重置（僵尸运行清理）' });
    this.publish(sessionId, { type: 'state', running: false });
    return true;
  }

  /** 当前所有运行中的会话 id（Web 侧栏运行态徽标 / 删除门禁的数据源）。 */
  runningSessionIds(): string[] {
    for (const id of [...this.running.keys()]) this.zombieReap(id);
    return [...this.running.keys()];
  }

  /**
   * 当前有会话运行中的项目 id（去重）。
   * 侧栏项目点「运行中动效」的数据源：非活跃项目的会话列表前端未加载，
   * 由服务端归集（与 runningSessionIds 同一次僵尸清理，口径一致）。
   */
  runningProjectIds(): string[] {
    const ids = this.runningSessionIds();
    const projects = new Set<string>();
    for (const id of ids) {
      try {
        const s = this.deps.service.getSession(id);
        if (s) projects.add(s.project_id);
      } catch {
        // 单个会话查询失败不影响整体
      }
    }
    return [...projects];
  }

  /** 会话级权限模式：未单独设置时回退全局默认。 */
  getPermissionMode(sessionId: string): PermissionMode {
    return this.sessionPermissionModes.get(sessionId) ?? this.deps.permissionMode ?? 'default';
  }

  /** 设置会话级权限模式（仅影响该会话后续的运行，不影响进行中的一轮）。 */
  setPermissionMode(sessionId: string, mode: PermissionMode): void {
    this.sessionPermissionModes.set(sessionId, mode);
  }

  /** F-39：按项目根缓存的专家库（指纹缓存内建，进程内复用） */
  private expertStores = new Map<string, ExpertStore>();
  /** F-39：已做预置技能装载的会话（每会话一次） */
  private expertSeeded = new Set<string>();

  private expertStoreFor(projectRoot: string): ExpertStore {
    let store = this.expertStores.get(projectRoot);
    if (!store) {
      store = new ExpertStore({ projectRoot, homeDir: os.homedir() });
      this.expertStores.set(projectRoot, store);
    }
    return store;
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

  /** F-41 运行日志埋点（旁路；RunLog 内部已静默，这里再防宿主注入对象抛错） */
  private log(level: LogLevel, message: string, sessionId?: string): void {
    try {
      this.deps.runLog?.append(level, 'hub', message, sessionId);
    } catch {
      // 日志失败不影响主流程
    }
  }

  // ── 确认 / 提问回填 ─────────────────────────────────────────────────────

  /** 创建挂在 waiters 表上的决策等待（超时 / abort 自动收尾，见 createDecisionWaiter）。 */
  private decision<T>(key: string, kind: DecisionKind, signal: AbortSignal): Promise<T> {
    return createDecisionWaiter<T>(kind, signal, {
      register: (e) => this.waiters.set(key, e),
      unregister: (e) => {
        if (this.waiters.get(key) === e) this.waiters.delete(key);
      },
    });
  }

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

  // ── F-37 分支 / worktree 编排（设计文档 §3.1）────────────────────────────

  /** 会话 + 项目联合获取（任一不存在返回 null）。 */
  private sessionWithProject(
    sessionId: string,
  ): { session: NonNullable<ReturnType<SessionService['getSession']>>; project: NonNullable<ReturnType<SessionService['getProject']>> } | null {
    const session = this.deps.service.getSession(sessionId);
    if (!session) return null;
    const project = this.deps.service.getProject(session.project_id);
    if (!project) return null;
    return { session, project };
  }

  /** 切换结果落库后注入系统提示（role='user'，沿用引擎惯例；D5）+ git_notice 推送。 */
  private injectWorkrootNotice(sessionId: string, message: string): void {
    try {
      this.deps.service.appendMessage(sessionId, { role: 'user', content: message });
    } catch {
      // 落库失败不阻断切换结果本身
    }
    this.publish(sessionId, { type: 'git_notice', message });
  }

  /** GET 语义：底栏状态（不产生副作用）。 */
  async worktreeState(sessionId: string): Promise<SessionGitState> {
    const pair = this.sessionWithProject(sessionId);
    if (!pair) throw new Error('session not found');
    const { session, project } = pair;
    const wm = new WorktreeManager(project.root_path);
    const base = {
      projectName: path.basename(project.root_path),
      running: this.isRunning(sessionId),
    };
    if (!(await wm.isRepo())) {
      return {
        isRepo: false,
        ...base,
        branch: null,
        worktree: { enabled: false, path: null, branch: null },
      };
    }
    const workRoot = resolveWorkRoot(session, project.root_path);
    return {
      isRepo: true,
      ...base,
      branch: await wm.currentBranch(workRoot),
      worktree: {
        // 目录丢失（被手动删除）时 resolveWorkRoot 已回退主工作根 → 不显示 worktree
        enabled: Boolean(session.worktree_path) && workRoot === session.worktree_path,
        path: session.worktree_path,
        branch: session.worktree_branch,
      },
    };
  }

  /** 分支列表（worktreeState 已知 isRepo；非 repo / git 失败 → {ok:false, reason}）。 */
  async listBranches(
    sessionId: string,
  ): Promise<{ ok: true; branches: BranchInfo[] } | { ok: false; reason: string }> {
    const pair = this.sessionWithProject(sessionId);
    if (!pair) return { ok: false, reason: 'session not found' };
    const { session, project } = pair;
    const wm = new WorktreeManager(project.root_path);
    return wm.listBranches(resolveWorkRoot(session, project.root_path));
  }

  /**
   * 会话级 checkout：运行中守卫（含等待确认间隙，isRunning 天然覆盖）→
   * checkout（脏区在 WorktreeManager 内拦截，D9）→ 成功注入系统提示 + git_notice。
   * 不落分支到会话表（D3：分支是仓库状态，恢复时以实际为准）。
   */
  async checkoutBranch(
    sessionId: string,
    opts: { branch?: string; newBranch?: string },
  ): Promise<BranchSwitchResult> {
    if (this.isRunning(sessionId)) {
      return { ok: false, reason: '会话运行中，请先停止或等待任务结束后再切换分支' };
    }
    const pair = this.sessionWithProject(sessionId);
    if (!pair) return { ok: false, reason: 'session not found' };
    const { session, project } = pair;
    const wm = new WorktreeManager(project.root_path);
    if (!(await wm.isRepo())) return { ok: false, reason: 'not a git repository' };
    const workRoot = resolveWorkRoot(session, project.root_path);
    const r = await wm.checkout(workRoot, opts);
    if (!r.ok || !r.branch) return r;
    this.injectWorkrootNotice(sessionId, branchSwitchMessage(r.branch, workRoot));
    return r;
  }

  /**
   * Worktree 开关（运行中一律拒绝）：
   * - enabled=true：addWorktree（D10 幂等）→ 落库两列 → 注入提示 → git_notice
   * - enabled=false：清空两列（目录保留，PRD 裁决 #3）→ 注入提示 → git_notice
   */
  async setWorktree(
    sessionId: string,
    enabled: boolean,
    opts?: { branch?: string; newBranch?: string },
  ): Promise<BranchSwitchResult> {
    if (this.isRunning(sessionId)) {
      return { ok: false, reason: '会话运行中，请先停止或等待任务结束后再切换工作区' };
    }
    const pair = this.sessionWithProject(sessionId);
    if (!pair) return { ok: false, reason: 'session not found' };
    const { session, project } = pair;

    if (!enabled) {
      // 切回主工作区：不发生 checkout（主工作区分支未被移动），无需脏区检查（D9）
      const prevPath = session.worktree_path;
      this.deps.service.setSessionWorktree(sessionId, { worktreePath: null, worktreeBranch: null });
      if (prevPath) {
        this.injectWorkrootNotice(sessionId, worktreeOffMessage(project.root_path, prevPath));
      }
      return { ok: true };
    }

    const wm = new WorktreeManager(project.root_path);
    if (!(await wm.isRepo())) return { ok: false, reason: 'not a git repository' };
    const add = await wm.addWorktree(sessionId, opts);
    if (!add.ok || !add.path) return { ok: add.ok, reason: add.reason };
    const branch = (await wm.currentBranch(add.path)) ?? opts?.branch ?? opts?.newBranch ?? null;
    this.deps.service.setSessionWorktree(sessionId, { worktreePath: add.path, worktreeBranch: branch });
    this.injectWorkrootNotice(sessionId, worktreeOnMessage(branch ?? '（detached HEAD）', add.path));
    return { ok: true, path: add.path, branch: branch ?? undefined };
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
    const prev = this.running.get(sessionId);
    if (prev) {
      // 僵尸自愈：上次运行卡死未收尾（已中止或超时）时清理后继续，而不是永久 409 锁死会话
      if (!this.zombieReap(sessionId)) throw new Error('session is already running');
    }
    const session = this.deps.service.getSession(sessionId);
    if (!session) throw new Error('session not found');
    const project = this.deps.service.getProject(session.project_id);
    if (!project) throw new Error('project not found');

    this.running.set(sessionId, { ac: new AbortController(), startedAt: Date.now() });
    this.publish(sessionId, { type: 'state', running: true, paused: false });
    // F-41：任务开始（输入截断 200 字符，design-f41 §4）
    this.log('info', `任务开始：${input.slice(0, 200)}`, sessionId);

    const service = this.deps.service;
    const startedAt = Date.now(); // F-33：任务时长门槛判定基准
    let assistantText = ''; // 全程文本累计（通知/摘要用）
    // 按"轮"落库：一轮 = 一次模型响应（文本 + 本轮工具调用）。
    // 旧实现跨轮累积 calls 且 done 时丢 calls，产生重复 assistant 行 / 孤立 tool 消息。
    let turnText = '';
    let turnCalls: ToolCall[] = [];
    let turnSaved = false;
    // 本轮已收到 tool 消息结果的调用 id（配对校验用：缺失即断裂历史，网关 400）
    const answeredCalls = new Set<string>();
    let acRef: AbortController | null = null; // F-33：finally 判定 aborted / failed 状态用
    let runError: string | null = null;
    // F-31：usage 事件计数器（每轮 +1），逐轮落库（D5，替代 done 一次性 turn=0）
    let usageTurn = 0;
    const beginTurnIfSaved = () => {
      if (turnSaved) {
        turnText = '';
        turnCalls = [];
        turnSaved = false;
        answeredCalls.clear();
      }
    };
    const saveTurnAssistant = () => {
      if (turnSaved) return;
      if (!turnText && turnCalls.length === 0) return;
      service.appendMessage(sessionId, {
        role: 'assistant',
        content: turnText,
        toolCalls: [...turnCalls],
      });
      turnSaved = true;
    };
    // 中止/异常收尾：本轮已声明但未收到结果的 tool_calls 补齐占位 tool 消息，
    // 保证 assistant(tool_calls) 与 tool 消息一一配对（网关强校验，缺失即下轮 400）
    const pairUnansweredCalls = () => {
      for (const call of turnCalls) {
        if (answeredCalls.has(call.id)) continue;
        answeredCalls.add(call.id);
        service.appendMessage(sessionId, {
          role: 'tool',
          content: '（本轮执行被中止，工具调用未返回结果）',
          toolCallId: call.id,
        });
      }
    };

    try {
      // 项目根目录必须存在：无效 root 会让文件类工具全部 ENOENT、模型陷入无效重试循环
      if (!fs.existsSync(project.root_path)) {
        throw new Error(
          `项目根目录不存在：${project.root_path}（请在项目管理中移除该项目后重新添加正确路径）`,
        );
      }
      // F-37（D2）：工作根解析唯一入口——worktree 绑定存在且目录存活 → worktree，
      // 否则项目根。切换只允许在非运行中发生，本轮内 workRoot 恒定，无并发改写问题。
      const workRoot = resolveWorkRoot(session, project.root_path);
      // PASI-9：暂停会话恢复 = 继续发消息，清除 paused 标记后按正常流程执行
      service.resumeSession(sessionId);
      // 崩溃恢复——本会话孤儿任务（租约过期的 running）先回 queued
      try {
        service.recoverTasks(sessionId);
      } catch {
        // 恢复失败不阻塞本轮运行
      }
      // 用户消息立即落库（即使 Provider 解析失败也不丢输入）。
      // 注意：必须位于 try 内——早期失败（DB 异常等）也要走 catch → run_error 推送，
      // 否则异常会被 HTTP 层的 .catch(() => undefined) 吞掉，前端表现为"运行直接停止"。
      const userMessage: ChatMessage = { role: 'user', content: input };
      if (images && images.length > 0) userMessage.images = images;
      service.appendMessage(sessionId, userMessage);
      const provider = await this.deps.resolveProvider();
      const ac = this.running.get(sessionId)!.ac; // send 入口已创建，僵尸判定与 engine 共用同一 Controller
      acRef = ac;
      service.registerRun(sessionId, ac);

      // F-27 SessionStart 钩子：每会话首次运行触发一次（旁路触发）
      if (this.deps.hooks?.has('SessionStart') && !this.sessionStarted.has(sessionId)) {
        this.sessionStarted.add(sessionId);
        void this.deps.hooks.emit('SessionStart', { sessionId, projectId: session.project_id });
      }

      // 会话预算：优先 settings 解析器（设置页可改，下一轮生效），缺省默认 200k / $0.7
      const budget = new BudgetManager(this.deps.resolveBudgetConfig?.() ?? {});

      // E-1 子代理模型路由：命中 F-32 routing 的 subagent 规则时子代理走小模型（省 token）；
      // 规则缺失 / 目标 provider 不可用 → 回退会话主模型（与 routeAux 降级语义一致）
      const subRoute = await this.routeAux('subagent');
      const subagentModel = subRoute?.model ?? session.model ?? '';

      // F-42：压缩摘要（summarize kind）路由——规则命中时压缩摘要走小模型，
      // 用量按 aux model 归因落库；未配置 / 目标 provider 构建失败 → 跟随会话主模型
      const summarizeRoute = await this.routeAux('summarize');

      // ── F-39：专家解析 + 注册表收窄（收窄点唯一，D3/§6.4）────────────────
      // 包丢失 → expert=undefined → 不注入不收窄不 seed，会话照常运行（AC-9 降级）
      const expert: ExpertRecord | undefined = session.expert
        ? await this.expertStoreFor(workRoot).get(session.expert)
        : undefined;
      const allow = resolveToolAllow(
        expert?.tools ?? null,
        this.deps.registry.definitions().map((d) => d.name),
      );
      const runRegistry = restrictRegistry(this.deps.registry, allow.allow);

      // 预置技能：每会话首轮装载一次（进程级共享 buffer 是已知限制，design §16-1）
      if (expert && expert.skills.length > 0 && this.deps.skills && !this.expertSeeded.has(sessionId)) {
        this.expertSeeded.add(sessionId);
        const seeded = await seedExpertSkills(this.deps.skills, expert.skills);
        for (const w of seeded.warnings) {
          this.publish(sessionId, { type: 'git_notice', message: w });
        }
      }

      const { staticText, dynamicText } = await this.buildPrompt(
        workRoot,
        session.model || this.deps.defaultModel || defaultModelFor(provider.id),
        runRegistry.definitions(),
        expert,
      );
      let askSeq = 0; // 本轮 ask_user 递增序号（配合时间戳保证每次提问 id 唯一）

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
        model: session.model || this.deps.defaultModel || defaultModelFor(provider.id),
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
        registry: runRegistry, // F-39：白名单收窄后的视图（L4 与执行同源）
        toolContext: {
          // F-37：沙箱根 = 当前工作根（共享知识 6）。resolveInSandbox(ctx.projectRoot)
          // 自动跟随；SandboxExecutor 构造期固化 projectRoot，若未来在本链路注入
          // 沙箱实例，切换工作根后必须以 createSandboxRuntime({projectRoot: workRoot})
          // 重建执行器，不可原地改写（D8，Seatbelt/Docker 字段 readonly）。
          projectRoot: workRoot,
          signal: ac.signal,
          sessionId,
          projectId: session.project_id,
          memory: service.memory,
          // F-24 文件变更管理：写工具自动快照（diff 汇总/回滚走 HTTP 层读 service.changes）
          changes: service.changes,
          // F-23 权限模式（每次运行新建：allow_session 记忆随运行结束重置；模式取会话级覆盖）
          permissions: new PermissionState({
            mode: this.getPermissionMode(sessionId),
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
            // 超时 / abort 以 reject 收尾：请求 id = call.id（每次调用唯一），
            // 同轮多个 confirm_request 各自独立等待，互不覆盖
            return this.decision<ConfirmDecision>(req.id, 'confirm', ac.signal);
          },
          askUser: async (question: string, options?: string[]) => {
            // 每次提问独立 id（此前整轮共用一个 askId，同轮两次 ask_user 会覆盖前一次的 waiter）
            const id = `ask_${sessionId}_${Date.now()}_${++askSeq}`;
            this.publish(sessionId, { type: 'ask_user', requestId: id, question, options });
            return this.decision<string>(id, 'ask', ac.signal);
          },
          todos: [],
          skills: this.deps.skills,
          // F-27 Hook 系统：工具执行挂钩（PreToolUse 可阻断 / PostToolUse 记录）
          hooks: this.deps.hooks,
          // F-26 子代理即工具：注入父注册表与子代理运行时（只读隔离，用量回写本运行预算）
          registry: runRegistry,
          // F-39：专家团运行时（主理人调度；baseRegistry = 未收窄完整表，成员白名单独立裁定）
          expertTeam: expert && expert.expertType === 'team' ? toTeamRuntime(expert, this.deps.registry) : undefined,
          // F-39：委派事件透传 SSE（Web 成员卡 / CLI 单行）
          emit: (ev) => this.publish(sessionId, ev),
          subagent: {
            provider: subRoute?.provider ?? provider,
            model: subagentModel || session.model || this.deps.defaultModel || defaultModelFor(provider.id),
            budget,
            budgetConfig: budget.config,
            windowTokens: this.deps.windowTokens ?? 200_000,
            depth: 0,
          },
        },
        budget,
        // 方案 D：Web 链路预算耗尽降级续跑（headless/cron 硬停协议不受影响）
        budgetDegrade: true,
        // F-42：压缩摘要路由目标（undefined = 跟随主模型）
        summarizeRoute,
        windowTokens: this.deps.windowTokens ?? 200_000,
        plan: this.deps.plan,
        tasks: service.tasks,
        // F-14 计划确认流：Web 端回填决策（挂起等待，事件实时推送）；multi-agent 与 plan-execute 同源支持
        planApproval:
          ctxMode === 'plan-execute' || ctxMode === 'multi-agent'
            ? (req) => {
                this.publish(sessionId, { type: 'plan_approval_request', request: req });
                return this.decision<PlanDecision>(req.id, 'plan', ac.signal);
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
            beginTurnIfSaved();
            assistantText += ev.text;
            turnText += ev.text;
            break;
          case 'thinking_delta':
            break;
          case 'tool_call_start':
            beginTurnIfSaved();
            turnCalls.push(ev.call);
            break;
          case 'tool_result': {
            // 首个工具结果前落库本轮 assistant（文本 + 本轮全部调用），
            // 保证历史中 assistant.tool_calls 与紧随的 tool 消息一一对应（网关强校验）
            saveTurnAssistant();
            answeredCalls.add(ev.result.callId);
            // F-41：工具调用过程行
            this.log('info', `工具 ${ev.call.name} ${ev.result.ok ? '✔' : '✘'}（${ev.ms}ms）`, sessionId);
            service.appendMessage(sessionId, {
              role: 'tool',
              content: ev.result.content,
              toolCallId: ev.result.callId,
            });
            break;
          }
          case 'error':
            // F-41：引擎致命错误留痕（非致命错误引擎自愈，不刷日志）
            if (ev.fatal) this.log('error', ev.message, sessionId);
            break;
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
            // 最后一轮（通常无工具调用）在此落库；随后为中断残留的悬空调用补齐占位 tool 消息
            saveTurnAssistant();
            pairUnansweredCalls();
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
            // （F-37-7：以当前工作根为基准——worktree 内的会话提交的就是 worktree 里的改动）
            if (this.deps.gitPolicy?.mode === 'auto' && !ac.signal.aborted) {
              const git = new GitIntegration(workRoot, this.deps.gitPolicy, ac.signal);
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
      this.log('error', `任务异常：${(e as Error).message}`, sessionId);
      // 中断/异常时保留本轮已产出的文本与调用，并为未响应的调用补齐占位 tool 消息
      //（此前直接丢弃 calls 丢失上下文；不补齐则 assistant.tool_calls 悬空，下轮请求被网关 400）
      saveTurnAssistant();
      pairUnansweredCalls();
    } finally {
      this.running.delete(sessionId);      this.deps.service.unregisterRun(sessionId);
      this.publish(sessionId, { type: 'state', running: false });
      // F-41：任务结束留痕（中止 warn / 完成 info；异常已在 catch 记录，此处不再重复）
      const durationMs = Date.now() - startedAt;
      if (!runError) {
        if (acRef?.signal.aborted) this.log('warn', `任务被中止（${durationMs}ms）`, sessionId);
        else this.log('info', `任务完成（${durationMs}ms）`, sessionId);
      }
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

  /** 组装静态/动态分段提示词（与 CLI 同源：8 层 + Skill 索引；F-39 起共用 buildAssembleContext）。 */
  private async buildPrompt(
    projectRoot: string,
    model: string,
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
    expert?: ExpertRecord,
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
      read(path.join(projectConfigDir(projectRoot), FILES.agentMd), 4_000),
    ]);

    const { skills } = await discoverSkills({ projectRoot, homeDir: os.homedir() });
    const ctx = buildAssembleContext({
      projectName: path.basename(projectRoot),
      projectInstructions: readme,
      staticMemory,
      tools,
      skillIndex: skills.map((s) => ({ name: s.name, description: s.description, triggers: s.triggers })),
      ...(expert ? { expert } : {}),
      session: {
        cwd: projectRoot,
        now: new Date(),
        model,
        contextWindow: this.deps.windowTokens ?? 200_000,
      },
    });
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
