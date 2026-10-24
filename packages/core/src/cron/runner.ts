/**
 * F-22 定时任务 —— 到期执行器。
 *
 * 职责：扫描任务清单，对到期任务逐个执行并落运行记录、推进 nextRunAt。
 * 约束：
 *  - 执行器经 CronExecutor 注入（core 不感知 CLI / 进程细节；测试用伪造执行器）；
 *    CLI 提供默认实现：spawn `yzero run -p <prompt> --json` 子进程（见 cli/cron-executor.ts）；
 *  - 串行执行：同一时刻最多一个任务在跑，避免并发任务互相争抢预算/模型；
 *  - runningSince 锁：执行前写入、完成后清除；残留超过 STALE_RUNNING_MS 视为上次
 *    进程崩溃，自动清除后照常执行（防 daemon 与手动补跑并发重复执行）；
 *  - 单任务失败不中断其余任务；坏表达式任务记录 error 运行记录但不改 enabled；
 *  - 任务清单全程使用同一份内存对象读改写落盘（串行执行下无并发写竞争；
 *    执行期间用户手工改文件会被本轮落盘覆盖，与其它配置存储的 last-writer-wins 口径一致）。
 */
import { nextRun } from './parse.js';
import {
  isInValidWindow,
  loadCronJobs,
  saveCronJobs,
  type CronJob,
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
  /** 进度旁路日志（CLI 打印用；不影响主流程） */
  logger?: (line: string) => void;
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

  const { jobs, warnings, corrupt } = loadCronJobs(opts.homeDir);
  for (const w of warnings) log(`⚠ ${w.message}`);
  if (corrupt) return { ran: [], skipped: 0 };

  // 崩溃残留锁清理：runningSince 超过 STALE_RUNNING_MS 的任务解除锁定
  for (const job of jobs) {
    if (job.runningSince && now.getTime() - Date.parse(job.runningSince) > 24 * 60 * 60 * 1000) {
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
      job.nextRunAt = nextRunSafe(job.cron, dueAt);
      job.updatedAt = now.toISOString();
      saveCronJobs(jobs, opts.homeDir);
      log(`⏭ ${job.name} 在有效期窗口外，跳过本次调度`);
      continue;
    }
    // ② 既有执行流程：写锁 → executor → 运行记录 → 推进 nextRunAt
    const startedAt = new Date();
    log(`⏰ 定时任务到期：${job.name}（${job.cron}）`);
    // 写锁防并发（与 daemon / 手动补跑互斥）
    job.runningSince = startedAt.toISOString();
    saveCronJobs(jobs, opts.homeDir);

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
    };
    delete job.runningSince;
    job.lastRun = record;
    job.runs = [...job.runs, record].slice(-20);
    // 手动强制执行（onlyJobId）不推进调度时刻；到期执行推进到下一次
    if (!opts.onlyJobId) {
      job.nextRunAt = nextRunSafe(job.cron, now);
    }
    job.updatedAt = finishedAt.toISOString();
    saveCronJobs(jobs, opts.homeDir);
    ran.push(job.name);

    const brief = record.error ? `：${record.error.slice(0, 120)}` : `（${record.durationMs}ms）`;
    log(`${record.status === 'completed' ? '✔' : '✘'} ${job.name} ${record.status}${brief}`);
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
