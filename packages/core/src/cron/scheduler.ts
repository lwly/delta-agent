/**
 * F-22 定时任务 —— 常驻调度循环。
 *
 * 职责：以固定间隔（默认 30s）调用 runDueCronJobs，直到 stop() / signal 中止。
 * 约束：
 *  - 上一轮尚未结束时跳过本轮（busy 保护，防任务长跑导致 tick 堆积）；
 *  - 启动后立即执行第一轮（daemon 起来先补跑停机期间到期的任务）；
 *  - 本模块只做循环编排，判定与执行语义全部在 runner.runDueCronJobs。
 */
import { runDueCronJobs, type CronExecutor, type RunDueResult } from './runner.js';

export interface StartCronSchedulerOptions {
  executor: CronExecutor;
  /** tick 间隔毫秒数；默认 30_000 */
  tickMs?: number;
  /** 任务清单存储目录（透传 runner） */
  homeDir?: string;
  /** 进度旁路日志 */
  logger?: (line: string) => void;
  /** 外部中止信号（CLI SIGINT 接入）；abort 后调度器停止 */
  signal?: AbortSignal;
}

export interface CronSchedulerHandle {
  /** 停止调度（幂等）；返回是否由本次调用真正停止 */
  stop(): boolean;
  /** 调度器是否仍在运行 */
  isRunning(): boolean;
  /** 最近一轮结果（尚未跑完时为上一轮的） */
  lastResult(): RunDueResult | undefined;
}

/**
 * 启动常驻调度器。返回句柄；进程退出由调用方负责（CLI daemon 命令接 SIGINT）。
 */
export function startCronScheduler(opts: StartCronSchedulerOptions): CronSchedulerHandle {
  const tickMs = opts.tickMs ?? 30_000;
  const log = opts.logger ?? (() => {});
  let running = true;
  let busy = false;
  let last: RunDueResult | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const onAbort = () => stop();
  if (opts.signal) {
    if (opts.signal.aborted) running = false;
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  const tick = async (): Promise<void> => {
    if (busy) return; // 上一轮任务还在跑，跳过本轮
    busy = true;
    try {
      last = await runDueCronJobs({
        executor: opts.executor,
        homeDir: opts.homeDir,
        trigger: 'schedule',
        logger: log,
      });
    } catch (e) {
      // runDueCronJobs 约定不抛错；这里兜底保证循环不死
      log(`⚠ 调度 tick 异常（已忽略）：${(e as Error).message}`);
    } finally {
      busy = false;
    }
  };

  const stop = (): boolean => {
    if (!running) return false;
    running = false;
    if (timer) clearInterval(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    return true;
  };

  if (running) {
    void tick(); // 启动即补跑一轮
    timer = setInterval(() => void tick(), tickMs);
    timer.unref?.(); // 不阻止进程自然退出（仅调度器在跑时允许进程收尾）
  }

  return {
    stop,
    isRunning: () => running,
    lastResult: () => last,
  };
}
