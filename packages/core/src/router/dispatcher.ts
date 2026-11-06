/**
 * F-58 Router–Worker 调度层：Dispatcher 任务状态机（设计稿 §7.4 / §13）。
 *
 * 职责：worker_tasks 行的生命周期（dispatch → claimSlot → preflight → running → 收敛）
 * 与 needs_decision 的人工裁决。Worker = 独立会话，执行全链路复用 hub.send()。
 *
 * 依赖方向红线（§12）：本文件不 import server/——send/peekRunning/isRunning 由 runtime
 * 装配时以本地结构类型注入（hub 不 import router/，只靠注入耦合）。
 * 其中 isRunning 声明而禁用：其内部 zombieReap 会回收超 30 分钟的会话（§9.3，D15），
 * 本层存活判定一律走 peekRunning（纯读）。
 */
import type {
  DispatchRequest,
  FailureKind,
  InboxSeverity,
  PreflightResult,
  WorkerTaskRow,
} from './types.js';
import { InboxStore, WorkerTaskStore } from './store.js';
import { buildDigestMessage, buildWorkerFirstMessage, parseDependsOn } from './prompt.js';
import { watchdogTick, type WatchdogDeps } from './watchdog.js';
import { defaultModelFor } from '../llm/defaults.js';

/** hub send 的 finally 回调透传的运行结果（T3 冻结契约，字段零新增判定） */
export interface RunFinishedOutcome {
  runError?: string;
  aborted: boolean;
  durationMs: number;
}

/** preflight 门禁函数（T2b 提供默认实现 runPreflight；测试注入 fake） */
export type PreflightFn = (task: WorkerTaskRow) => Promise<PreflightResult>;

/** runtime 装配注入的 hub 侧函数（本地结构类型，不 import server/） */
export interface DispatcherDeps {
  workerTasks: WorkerTaskStore;
  inbox: InboxStore;
  /** 启动一个会话的运行（hub.send 全链路复用，§13） */
  send: (sessionId: string, input: string) => Promise<void>;
  /** 纯读运行态（不触发 zombieReap，§9.3）——本层唯一的存活判定来源 */
  peekRunning: (sessionId: string) => boolean;
  /**
   * ⚠️ 注入但禁用（D15/§9.3）：isRunning 内部 zombieReap 会把超 30 分钟的会话当僵尸回收，
   * 看门狗若调用它等于给自己的 Worker 判 30 分钟死刑。仅为 runtime 装配签名完整而声明，
   * dispatcher/watchdog 任何代码路径不得调用（有 grep 自检与 fake hub 计数用例守卫）。
   */
  isRunning: (sessionId: string) => boolean;
  /** 中止一个会话的运行（hub.abort；L2 击杀与 cancel(running) 用） */
  abort?: (sessionId: string) => void;
  /** preflight 门禁（缺省未装配：外部 executor 视为配置缺失，落 needs_decision） */
  preflight?: PreflightFn;
  /** 创建 Worker 会话（§7.5 签名；kind='worker' 由服务端固定，T4 装配时接 service） */
  createWorkerSession: (
    projectId: string,
    opts: { title: string; model: string; taskId: string },
  ) => { id: string };
  /** Router 会话当前 model（内置 Worker 的 model 推导第一优先，§7.5） */
  getRouterModel?: (routerSessionId: string) => string | null;
  /** 内置 Worker model 推导第二优先（§7.5 退化链） */
  defaultModel?: string;
  /** 并发上限（D13，默认 3；needs_decision 不占槽位） */
  maxConcurrentWorkers?: number;
  /** done 收敛时取 Worker 会话结果摘要（≤400 字；缺省不写 result_summary，落点在 runtime） */
  getResultSummary?: (workerSessionId: string) => string | null;
  /** 看门狗判据注入（L2a 文件变更/work_root、L2c 事件时钟；缺省的检查项自动跳过） */
  watchdog?: WatchdogDeps;
  /** 时钟注入（测试防抖/窗口判定用；缺省 Date.now） */
  now?: () => number;
}

/** 依赖任务未就绪时任务保持 queued（§7.4：depends_on 有未终态项不派发） */
const PENDING_STATUSES = new Set(['draft', 'queued', 'preflight', 'running', 'needs_decision']);

/** digest 防抖（§10.1 C4）：两次播报最小间隔 */
export const DIGEST_MIN_INTERVAL_MS = 60_000;
/** batch 窗口兜底（§10.1 C2）：距上次播报超过 15min 时，不足 2 条终态也播 */
export const DIGEST_MAX_GAP_MS = 15 * 60_000;

export class Dispatcher {
  readonly workerTasks: WorkerTaskStore;
  readonly inbox: InboxStore;
  private readonly deps: DispatcherDeps;
  private readonly maxConcurrent: number;
  private readonly nowFn: () => number;

  constructor(deps: DispatcherDeps) {
    this.deps = deps;
    this.workerTasks = deps.workerTasks;
    this.inbox = deps.inbox;
    this.maxConcurrent = deps.maxConcurrentWorkers ?? 3;
    this.nowFn = deps.now ?? Date.now;
  }

  now(): number {
    return this.nowFn();
  }

  /** 纯读运行态（watchdog L1 复用，不触发 zombieReap） */
  peekRunning(sessionId: string): boolean {
    return this.deps.peekRunning(sessionId);
  }

  /** 中止 Worker 会话运行（watchdog L2 / cancel 用；未注入 abort 时静默跳过） */
  abortWorker(sessionId: string): void {
    this.deps.abort?.(sessionId);
  }

  /**
   * 派单：仅落库（queued），不建会话、不占槽位（T4 判据 2：创建发生在 claimSlot）。
   * 依赖检查不在此处——claimSlot 派发前逐条校验（依赖状态随时在变，落库时判定无意义）。
   */
  dispatch(req: DispatchRequest & { projectId: string; routerSessionId: string }): WorkerTaskRow {
    return this.workerTasks.create({ ...req, status: 'queued' });
  }

  /**
   * 派发泵：扫描 queued（priority DESC, created_at ASC，§8.2 桶序），对每个任务：
   *   1. depends_on 校验——有未终态项 → 跳过（不派发）；有 failed/canceled 项 → 取消本任务
   *      （§7.4 queued → canceled「依赖失败」边）并进 inbox interrupt；
   *   2. 并发槽位——countRunning（preflight+running）≥ maxConcurrentWorkers → 跳过；
   *   3. 原子认领——store.claimSlot（queued → preflight，attempt+1）；
   *   4. preflight（外部 executor）——失败 → needs_decision + inbox(interrupt)，
   *      不建会话、不拉进程（attempt 的 +1 来自 claim，preflight 失败路径自身不再递增）；
   *   5. 建 Worker 会话 → 迁移 running（先置状态再 send，防 onRunFinished 早于状态落库）→
   *      send(goal 原文)。send 不阻塞泵——运行期事件由 onRunFinished 收敛。
   */
  async claimSlot(): Promise<void> {
    const queued = this.workerTasks.list({ status: 'queued' });
    for (const task of queued) {
      // 1) 依赖校验
      const depIds = parseDependsOn(task.depends_on);
      let depBlocked = false;
      let depFailed = false;
      for (const depId of depIds) {
        const dep = this.workerTasks.find(depId);
        if (!dep || PENDING_STATUSES.has(dep.status)) depBlocked = true;
        else if (dep.status === 'failed' || dep.status === 'canceled') depFailed = true;
      }
      if (depFailed) {
        // §7.4 queued → canceled（依赖失败 / 用户取消）
        this.workerTasks.transition(task.id, 'canceled');
        this.inbox.append({
          routerSessionId: task.router_session_id,
          taskId: task.id,
          kind: 'task_failed',
          severity: 'interrupt',
          payload: {
            taskId: task.id,
            title: task.title,
            failureKind: 'canceled',
            message: `依赖任务未成功（${depIds.join(', ')}），已自动取消`,
          },
        });
        continue;
      }
      if (depBlocked) continue;

      // 2) 并发槽位（needs_decision 不占槽位：countRunning 只数 preflight+running）
      if (this.workerTasks.countRunning(task.router_session_id) >= this.maxConcurrent) continue;

      // 3) 原子认领（并发两次只有一次 changes===1）
      if (!this.workerTasks.claimSlot(task.id)) continue;
      const claimed = this.workerTasks.get(task.id);

      // 4) preflight 门禁（仅外部 executor；内部引擎无外部前置）
      if (claimed.executor) {
        const result = await this.runPreflight(claimed);
        if (!result.ok) {
          this.needsDecision(claimed, result.reason ?? 'preflight_failed', result.message);
          continue;
        }
      }

      // 5) 建 Worker 会话并启动（先 running 后 send：onRunFinished 可能先于 send resolve 到达）
      const model = claimed.executor ?? this.resolveInternalModel(claimed.router_session_id);
      const session = this.deps.createWorkerSession(claimed.project_id, {
        title: claimed.title,
        model,
        taskId: claimed.id,
      });
      this.workerTasks.transition(claimed.id, 'running', { workerSessionId: session.id });
      const depRows = depIds
        .map((id) => this.workerTasks.find(id))
        .filter((r): r is WorkerTaskRow => r !== undefined);
      const message = buildWorkerFirstMessage(this.workerTasks.get(task.id), depRows);
      // send 不 await：hub.send 要等整轮运行结束才 resolve，await 会饿死 tick 的看门狗与播报；
      // 运行结果由 onRunFinished 收敛（主路径），send 的 rejection 只兜底「会话没跑起来」
      this.deps.send(session.id, message).catch((err: unknown) => {
        this.failRuntimeIfStillRunning(session.id, err instanceof Error ? err.message : String(err));
      });
    }
  }

  /** 内置 Worker 的 model 推导链（§7.5）：Router 当前 model → deps.defaultModel → defaultModelFor */
  private resolveInternalModel(routerSessionId: string): string {
    const routerModel = this.deps.getRouterModel?.(routerSessionId);
    if (routerModel && routerModel.trim() !== '') return routerModel;
    if (this.deps.defaultModel && this.deps.defaultModel.trim() !== '') return this.deps.defaultModel;
    return defaultModelFor(undefined);
  }

  private runPreflight(task: WorkerTaskRow): Promise<PreflightResult> {
    const fn = this.deps.preflight;
    if (!fn) {
      return Promise.resolve({
        ok: false,
        reason: 'preflight_unavailable',
        message: 'preflight 未装配（runtime 缺 dispatcher.preflight 注入），外部 executor 不允许盲启',
      });
    }
    return fn(task);
  }

  /** preflight 失败 → needs_decision（不建会话、不拉进程；attempt 不再递增，D7 禁止静默重试） */
  private needsDecision(task: WorkerTaskRow, reason: string, message?: string): void {
    this.workerTasks.transition(task.id, 'needs_decision');
    this.workerTasks.setDecision(task.id, { reason, message: message ?? null });
    this.inbox.append({
      routerSessionId: task.router_session_id,
      taskId: task.id,
      kind: 'needs_decision',
      severity: 'interrupt',
      payload: { taskId: task.id, title: task.title, reason, message: message ?? null },
    });
  }

  /**
   * hub send 的 finally 收敛（§13 主路径；L1 看门狗只是兜底）。
   * 幂等：只收敛仍处 running 的行——看门狗/其他路径先到时此处让位。
   * 收敛后释放槽位 → 继续派发（claimSlot）；播报在 pumpDigest（T2c）接入。
   */
  onRunFinished(sessionId: string, outcome: RunFinishedOutcome): void {
    const task = this.workerTasks.findByWorkerSession(sessionId);
    if (!task || task.status !== 'running') return;
    if (outcome.aborted) {
      this.convergeFailure(task, 'aborted', '运行被中止', 'batch', outcome.durationMs);
    } else if (outcome.runError) {
      this.convergeFailure(task, 'runtime', outcome.runError, 'batch', outcome.durationMs);
    } else {
      const summary = this.deps.getResultSummary?.(sessionId) ?? null;
      if (summary) this.workerTasks.setResult(task.id, summary.slice(0, 400));
      this.workerTasks.transition(task.id, 'done');
      this.inbox.append({
        routerSessionId: task.router_session_id,
        taskId: task.id,
        kind: 'task_done',
        severity: 'silent',
        payload: { taskId: task.id, title: task.title, summary },
      });
    }
    // 槽位已释放：继续派发排队的任务（异步，不阻塞调用方 finally）
    void this.claimSlot().catch(() => {});
    // §13 时序第 15 步：每次收敛后尝试播报（C3/C4 条件会把不该发的挡住）
    void this.pumpDigest(task.router_session_id).catch(() => {});
  }

  /** 运行失败收敛（幂等守卫：仅 running 可收敛；失败经 inbox batch 进 digest，§10） */
  convergeFailure(
    task: WorkerTaskRow,
    failureKind: FailureKind,
    message: string,
    severity: InboxSeverity,
    durationMs?: number,
  ): void {
    const row = this.workerTasks.get(task.id);
    if (row.status !== 'running') return;
    this.workerTasks.transition(row.id, 'failed', { failureKind });
    this.inbox.append({
      routerSessionId: row.router_session_id,
      taskId: row.id,
      kind: 'task_failed',
      severity,
      payload: {
        taskId: row.id,
        title: row.title,
        failureKind,
        message,
        ...(durationMs !== undefined ? { durationMs } : {}),
      },
    });
  }

  /** send 兜底收敛：运行根本没起来（如 409/引擎装配缺失）→ failed(runtime) */
  private failRuntimeIfStillRunning(sessionId: string, message: string): void {
    const task = this.workerTasks.findByWorkerSession(sessionId);
    if (!task || task.status !== 'running') return;
    this.convergeFailure(task, 'runtime', message, 'batch');
  }

  /**
   * needs_decision 的人工裁决（§7.4：retry → queued(attempt+1) | cancel | accept → done）。
   * retry 后立即尝试派发（槽位可用即重新走 preflight → 新 Worker 会话，§7.5 硬约束 2）。
   */
  decide(taskId: string, decision: 'retry' | 'cancel' | 'accept'): WorkerTaskRow {
    const row = this.workerTasks.get(taskId);
    if (row.status !== 'needs_decision') {
      throw new Error(`decide 仅对 needs_decision 任务有效（当前 ${row.status}）`);
    }
    switch (decision) {
      case 'retry': {
        const next = this.workerTasks.transition(taskId, 'queued', { attemptIncrement: true });
        void this.claimSlot().catch(() => {});
        return next;
      }
      case 'cancel':
        return this.workerTasks.transition(taskId, 'canceled');
      case 'accept': {
        const done = this.workerTasks.transition(taskId, 'done');
        this.inbox.append({
          routerSessionId: done.router_session_id,
          taskId: done.id,
          kind: 'task_done',
          severity: 'silent',
          payload: { taskId: done.id, title: done.title, summary: '用户裁决接受' },
        });
        return done;
      }
    }
  }

  /**
   * 取消（幂等；§14：queued/running/needs_decision 均可）。
   * preflight 不支持直接取消——窗口极短（进程内同步段），T1 冻结的状态机也无此边，
   * 端点层对 preflight 行返回错误即可。running 先 abort 再迁移；用户主动取消不进 inbox
   * （用户自己做的决定，无需再播报给自己；终态变更经台账对 Router 可见）。
   */
  cancel(taskId: string): WorkerTaskRow {
    const row = this.workerTasks.get(taskId);
    if (row.status === 'done' || row.status === 'failed' || row.status === 'canceled') return row;
    if (row.status === 'preflight') {
      throw new Error('preflight 阶段不支持直接取消（窗口极短，等进入 running 或 needs_decision）');
    }
    if (row.status === 'running' && row.worker_session_id) {
      this.abortWorker(row.worker_session_id);
    }
    return this.workerTasks.transition(taskId, 'canceled');
  }

  /**
   * 启动收敛（§18-1）：服务重启后，running/preflight 且进程已不在的行标 failed(runtime)。
   * preflight 行还没有 worker 会话（会话创建在 preflight 通过之后），一律视为已死；
   * running 行以 peekRunning（纯读，不触发 zombieReap）为准。
   */
  bootstrap(): void {
    for (const status of ['running', 'preflight'] as const) {
      for (const task of this.workerTasks.list({ status })) {
        const alive = task.worker_session_id ? this.deps.peekRunning(task.worker_session_id) : false;
        if (alive) continue;
        if (this.workerTasks.failOrphaned(task.id)) {
          this.inbox.append({
            routerSessionId: task.router_session_id,
            taskId: task.id,
            kind: 'task_failed',
            severity: 'batch',
            payload: {
              taskId: task.id,
              title: task.title,
              failureKind: 'runtime',
              message: '服务重启时进程已不存在，任务标记失败（bootstrap 收敛，不自动续跑）',
            },
          });
        }
      }
    }
  }

  /**
   * 主动播报（设计稿 §10.1，D14——本设计价值主张的关键机制）。四条件全满足才发：
   *   C1 有 batch/interrupt 未送达（silent 永不触发，这是「没搞定就不打扰」的硬保障）；
   *   C2 窗口关闭：interrupt 立即；仅 batch 需「终态数≥2（自上次播报）」或「距上次播报>15min」；
   *   C3 Router 空闲（peekRunning 纯读，不触发 zombieReap）；C4 距上次播报>60s 防抖。
   *
   * 顺序不可颠倒（防自激循环的头号防线，§10.1 三个设计要点之一）：
   *   先把本批 inbox 行写 delivered_at，再 hub.send；send 失败回滚 delivered_at=NULL。
   *   即使 send 期间有新条目进来，它们是新 id，不会被本轮重复播报；
   *   本轮结束触发的 onRunFinished → pumpDigest 也会被 C4 防抖挡住。
   *
   * 返回是否真的发送了。
   */
  async pumpDigest(routerSessionId: string): Promise<boolean> {
    const now = this.nowFn();
    // C1：存在待播报条目（batch/interrupt；silent 永不触发）
    const undelivered = this.inbox
      .listUndelivered(routerSessionId)
      .filter((i) => i.severity === 'batch' || i.severity === 'interrupt');
    if (undelivered.length === 0) return false;

    const lastDeliveredAt = this.inbox.lastDeliveredAt(routerSessionId);
    // C2：窗口已关闭。interrupt 立即；仅 batch 看「终态数≥2 或距上次播报>15min」。
    // 从未播报过（lastDeliveredAt 为 NULL）不视为「距上次>15min」——否则首条失败会立即
    // 触发播报，batch 的累积语义（AC8：≥2 条终态触发 1 条 digest）就失效了
    const hasInterrupt = undelivered.some((i) => i.severity === 'interrupt');
    if (!hasInterrupt) {
      const terminalCount = this.workerTasks.listTerminalSince(routerSessionId, lastDeliveredAt ?? 0).length;
      const gapOpen = lastDeliveredAt !== null && now - lastDeliveredAt > DIGEST_MAX_GAP_MS;
      if (terminalCount < 2 && !gapOpen) return false;
    }

    // C3：Router 空闲。运行中不发送，条目留在 inbox 等两个出口之一：
    // onRunFinished → 再 pump，或用户开口 → 台账注入未送达 interrupt（§8.2）
    if (this.deps.peekRunning(routerSessionId)) return false;

    // C4：防抖（先于标记：标记会改 MAX(delivered_at)，防抖判定必须用标记前的值）
    if (lastDeliveredAt !== null && now - lastDeliveredAt <= DIGEST_MIN_INTERVAL_MS) return false;

    // 先标记，后发送（顺序不可颠倒）
    const ids = undelivered.map((i) => i.id);
    this.inbox.markDelivered(ids, now);
    const digestText = buildDigestMessage(undelivered);
    try {
      await this.deps.send(routerSessionId, digestText);
      return true;
    } catch {
      // send 失败（Router 恰好被占用等）→ 回滚，等下一 tick / 下一次收敛
      this.inbox.unmarkDelivered(ids);
      return false;
    }
  }

  /**
   * 60s tick 入口（§10.1 / §9：pumpDigest 与看门狗共用）。顺序：
   * 派发泵（补槽位）→ 看门狗 L1/L2 → 逐 Router 播报。
   */
  async tick(): Promise<void> {
    await this.claimSlot();
    await watchdogTick(this, this.deps.watchdog ?? {});
    for (const routerId of new Set(this.workerTasks.list().map((t) => t.router_session_id))) {
      await this.pumpDigest(routerId);
    }
  }

  /**
   * L3 偏离标记接口（P0：只落标记，不接便宜模型、不判偏离——§9.2 / 计划 T2d）。
   * 动作 = watchdog_flag='suspect' + silent inbox（任务台「存疑」角标数据源），
   * 不打断、不终止、不 steer；误报允许发生（低可靠度判据，误杀成本远高于放过）。
   */
  markSuspect(taskId: string): void {
    const row = this.workerTasks.get(taskId);
    if (row.watchdog_flag === 'suspect') return; // 幂等：重复标记不叠加 inbox 条目
    this.workerTasks.setWatchdogFlag(taskId, 'suspect');
    this.inbox.append({
      routerSessionId: row.router_session_id,
      taskId,
      kind: 'digest',
      severity: 'silent',
      payload: { type: 'watchdog_suspect', taskId, title: row.title },
    });
  }
}
