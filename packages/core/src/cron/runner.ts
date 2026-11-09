/**
 * F-22 定时任务 —— 到期执行器。
 *
 * 职责：扫描任务清单，对到期任务逐个执行并落运行记录、推进 nextRunAt。
 * 约束：
 *  - 执行器经 CronExecutor 注入（core 不感知 CLI / 进程细节；测试用伪造执行器）；
 *    CLI 提供默认实现：spawn `delta run -p <prompt> --json` 子进程（见 cli/cron-executor.ts）；
 *  - 串行执行：同一时刻最多一个任务在跑，避免并发任务互相争抢预算/模型；
 *  - 运行锁 check-and-set（多实例不双跑）：执行前 acquireCronLock()（写锁 → 原子
 *    rename → 重读文件 → 校验锁 token 归属），失败即跳过本轮；残留锁超过
 *    STALE_RUNNING_MS 视为上次进程崩溃，覆盖抢锁后照常执行；
 *  - 单任务失败不中断其余任务；坏表达式任务记录 error 运行记录但不改 enabled；
 *  - 执行结束后**重新 loadCronJobs()**，把本轮 CronRunRecord 合并进最新对象再落盘
 *    （避免 last-writer-wins 覆盖另一进程的锁或运行记录；执行期间用户手工改文件
 *    的其它字段不会被本轮覆盖，口径从「全程同一份内存对象」收紧为「逐项合并」）。
 */
import { nextRun } from './parse.js';
import {
  MAX_RUN_HISTORY,
  STALE_RUNNING_MS,
  acquireCronLock,
  formatCronLockToken,
  isInValidWindow,
  loadCronJobs,
  parseCronLockTime,
  releaseCronLock,
  saveCronJobs,
  type CronJob,
  type CronProjectRootRef,
  type CronRunRecord,
} from './store.js';

/** 执行器结果（executor 内部错误也要收敛为结构化结果，不得抛出） */
export interface CronExecutorResult {
  status: CronRunRecord['status'];
  exitCode: number | null;
  sessionId?: string;
  costUsd?: number;
  turns?: number;
  error?: string;
  resultPreview?: string;
}

/** 执行器：给定任务与触发上下文，运行一次并返回结构化结果。 */
export type CronExecutor = (
  job: CronJob,
  ctx: { dueAt: Date; trigger: 'schedule' | 'manual' },
) => Promise<CronExecutorResult>;

export interface RunDueOptions {
  /** 执行器（必填，注入解耦） */
  executor: CronExecutor;
  /** 当前时间；缺省 new Date()（测试注入固定时钟） */
  now?: Date;
  /** 任务清单存储目录（缺省用户主目录） */
  homeDir?: string;
  /** 触发方式标记（schedule / manual，写入运行记录） */
  trigger?: 'schedule' | 'manual';
  /** 只跑指定任务（id 或 name），且无视调度到期（手动测试用） */
  onlyJobId?: string;
  /** 进度旁路日志（CLI 打印用；不影响主流程）。
   *  T6：ctx.projectId 携带当前任务归属（serve 侧落 RunLog 时转成 LogEntry.projectId，
   *  项目作用域 /logs 由此可见 cron 调度行）；CLI 侧 1 参 logger 兼容不受影响。 */
  logger?: (line: string, ctx?: { projectId?: string }) => void;
  /** T6：项目根引用（旧文件任务按 cwd 前缀惰性回填 projectId，仅内存）；serve 侧由宿主传入 */
  projectRoots?: CronProjectRootRef[];
  /** T7：统一预算账本（判据 1：cron 与 chat/worker 同一判定实现——执行前 check
   *  'cron' 账本，超限记 error 记录跳过；执行后 record 本轮成本，上限取 job.maxCostUsd） */
  quota?: import('../quota/store.js').QuotaStore;
}

export interface RunDueResult {
  /** 本次实际执行的任务名（按执行顺序） */
  ran: string[];
  /** 因未到期 / 禁用 / 运行中（锁未过期）而跳过的启用任务数 */
  skipped: number;
}

/**
 * 扫描并执行到期任务（一次 tick 的完整语义）。
 * 判定到期：enabled 且（nextRunAt 缺失 → 视为到期待补算；或 nextRunAt <= now）。
 * onlyJobId 指定时：仅该任务、无视到期与调度，直接强制执行一次（运行记录 trigger=manual）。
 */
export async function runDueCronJobs(opts: RunDueOptions): Promise<RunDueResult> {
  const now = opts.now ?? new Date();
  const trigger = opts.trigger ?? 'schedule';
  const log = opts.logger ?? (() => {});

  const { jobs, warnings, corrupt } = loadCronJobs(
    opts.homeDir,
    opts.projectRoots?.length ? { projectRoots: opts.projectRoots } : {},
  );
  for (const w of warnings) log(`⚠ ${w.message}`);
  if (corrupt) return { ran: [], skipped: 0 };

  // 合并落盘：重读最新文件 → 只改目标任务的目标字段 → 原子写回。
  // 防止本轮结果覆盖执行期间另一进程写入的锁或运行记录（多实例安全的关键一环）。
  const mergeAndSave = (jobId: string, mutate: (fresh: CronJob) => void): boolean => {
    const fresh = loadCronJobs(opts.homeDir);
    if (fresh.corrupt) return false;
    const target = fresh.jobs.find((j) => j.id === jobId);
    if (!target) return false; // 任务已被其它进程/用户删除：放弃落盘
    mutate(target);
    saveCronJobs(fresh.jobs, opts.homeDir);
    return true;
  };

  // 崩溃残留锁清理：runningSince（token 或旧版 ISO 串）超过 STALE_RUNNING_MS 的任务解除锁定
  for (const job of jobs) {
    const lockedAt = job.runningSince ? parseCronLockTime(job.runningSince) : undefined;
    if (lockedAt !== undefined && now.getTime() - lockedAt > STALE_RUNNING_MS) {
      log(`⚠ 任务 ${job.name} 的运行锁已残留超过 24h（疑似上次进程崩溃），自动解除`);
      delete job.runningSince;
    }
  }

  const candidates = jobs.filter((job) => {
    if (!job.enabled) return false;
    if (job.runningSince) return false; // 其它进程正在跑（锁未过期）
    if (opts.onlyJobId) return job.id === opts.onlyJobId || job.name === opts.onlyJobId;
    if (!job.nextRunAt) return true; // 缺 nextRunAt：视同到期，跑完补算
    return Date.parse(job.nextRunAt) <= now.getTime();
  });
  const enabledCount = jobs.filter((j) => j.enabled && !j.runningSince).length;
  const skipped = Math.max(0, enabledCount - candidates.length);

  const ran: string[] = [];
  for (const job of candidates) {
    const dueAt = job.nextRunAt ? new Date(Date.parse(job.nextRunAt)) : now;
    // ① F-22b 有效期窗口检查：以计划时刻 dueAt 判定；手动补跑（onlyJobId）不受限。
    //    窗口外 → 静默跳过（不执行、不写运行记录），从 dueAt 推进 nextRunAt 保持 cron 相位。
    if (!opts.onlyJobId && !isInValidWindow(job, dueAt)) {
      const nextAt = nextRunSafe(job.cron, dueAt);
      mergeAndSave(job.id, (fresh) => {
        fresh.nextRunAt = nextAt;
        fresh.updatedAt = now.toISOString();
      });
      log(`⏭ ${job.name} 在有效期窗口外，跳过本次调度`, { projectId: job.projectId });
      continue;
    }
    // ② 既有执行流程：锁 CAS → executor → 重读合并落盘 → 推进 nextRunAt
    const startedAt = new Date();
    log(`⏰ 定时任务到期：${job.name}（${job.cron}）`, { projectId: job.projectId });
    // T7（判据 1）：cron 与 chat/worker 共用 QuotaStore 判定——超限不拉子进程，
    // 收敛为 error 记录（照常推进调度，避免每轮反复失败刷屏）
    if (opts.quota) {
      const q = opts.quota.check('cron', job.id);
      if (!q.ok) {
        const now2 = new Date();
        const record: CronRunRecord = {
          trigger,
          startedAt: now2.toISOString(),
          finishedAt: now2.toISOString(),
          durationMs: 0,
          status: 'budget_exhausted',
          exitCode: null,
          error: `定时任务预算已耗尽（已用 $${q.usedCostUsd.toFixed(4)} / 上限 $${q.maxCostUsd.toFixed(2)}，超出 $${q.overage.toFixed(4)}）`,
          ...(job.projectId ? { projectId: job.projectId } : {}),
        };
        mergeAndSave(job.id, (fresh) => {
          fresh.lastRun = record;
          fresh.runs = [...fresh.runs, record].slice(-MAX_RUN_HISTORY);
          fresh.nextRunAt = nextRunSafe(job.cron, now);
          fresh.updatedAt = now2.toISOString();
        });
        log(`⏭ ${job.name} 预算已耗尽，跳过本轮（cron 账本超限）`, { projectId: job.projectId });
        continue;
      }
    }
    // 写锁 check-and-set 防并发（与 serve 内置调度 / daemon / 手动补跑互斥）：
    // 写锁 → 原子 rename → 重读校验 token 归属，失败即另一进程已抢到，跳过本轮
    const lockToken = formatCronLockToken(startedAt);
    if (!acquireCronLock(job.id, lockToken, opts.homeDir)) {
      log(`⏭ ${job.name} 已被其它进程抢到运行锁，跳过本轮`, { projectId: job.projectId });
      continue;
    }

    let result: CronExecutorResult;
    try {
      result = await opts.executor(job, { dueAt, trigger });
    } catch (e) {
      // 执行器约定不抛错；这里兜底收敛为 error 记录
      result = { status: 'error', exitCode: null, error: (e as Error).message };
    }

    const finishedAt = new Date();
    const record: CronRunRecord = {
      trigger,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      status: result.status,
      exitCode: result.exitCode,
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
      ...(result.turns !== undefined ? { turns: result.turns } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.resultPreview ? { resultPreview: result.resultPreview } : {}),
      // T6：运行记录携带任务项目归属（判据 3：项目作用域下 cron 运行行可见）
      ...(job.projectId ? { projectId: job.projectId } : {}),
    };
    // 重读合并落盘：清锁（仅当仍归属本 token）+ 运行记录 + 调度推进一次完成，
    // 避免覆盖执行期间另一进程写入的锁或记录；合并失败（文件损坏/任务被删）兜底释放锁
    const merged = mergeAndSave(job.id, (fresh) => {
      if (fresh.runningSince === lockToken) delete fresh.runningSince;
      fresh.lastRun = record;
      fresh.runs = [...fresh.runs, record].slice(-MAX_RUN_HISTORY);
      // 手动强制执行（onlyJobId）不推进调度时刻；到期执行推进到下一次
      if (!opts.onlyJobId) {
        fresh.nextRunAt = nextRunSafe(job.cron, now);
      }
      fresh.updatedAt = finishedAt.toISOString();
    });
    if (!merged) releaseCronLock(job.id, lockToken, opts.homeDir);
    // T7：本轮成本计入 cron 账本（上限取 job.maxCostUsd；0/缺省 = 不限额，record 仍累计供台账）
    opts.quota?.record('cron', job.id, result.costUsd ?? 0, job.maxCostUsd ?? 0);
    ran.push(job.name);

    const brief = record.error ? `：${record.error.slice(0, 120)}` : `（${record.durationMs}ms）`;
    log(`${record.status === 'completed' ? '✔' : '✘'} ${job.name} ${record.status}${brief}`, { projectId: job.projectId });
  }

  return { ran, skipped };
}

/** nextRun 的容错包装：表达式非法时返回 undefined（运行记录已含 error，不因调度推进二次失败） */
function nextRunSafe(expr: string, from: Date): string | undefined {
  try {
    return nextRun(expr, from)?.toISOString();
  } catch {
    return undefined;
  }
}
