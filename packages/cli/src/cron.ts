/**
 * `delta cron` 子命令组（F-22 定时任务/自动化，样例沿用 notify.ts / sandbox.ts）：
 *  - list            任务清单（id/名称/表达式/下次运行/上次结果）
 *  - add             新增任务（--name --cron --prompt [--dir] [--max-cost]）
 *  - remove          删除任务（id 或 name）
 *  - enable/disable  启停任务（enable 时从当下重算下次运行）
 *  - run             手动补跑：无 --id 跑全部到期任务；--id 强制跑指定任务一次
 *  - daemon          常驻调度进程（--tick-ms 默认 30s；--once 单轮补跑后退出）
 *
 * 执行复用 headless 语义（spawn `delta run --json` 子进程，见 cron-executor.ts）。
 */
import {
  addCronJob,
  loadCronJobs,
  nextRun,
  removeCronJob,
  runDueCronJobs,
  startCronScheduler,
  updateCronJob,
  type CronRunRecord,
} from '@delta/core';
import { createSpawnExecutor } from './cron-executor.js';

/** list：任务清单（人类可读表格；--json 输出原始结构）。 */
export function cronListCommand(opts: { json?: boolean }): void {
  const { jobs, warnings } = loadCronJobs();
  if (opts.json) {
    console.log(JSON.stringify({ jobs, warnings }, null, 2));
    return;
  }
  for (const w of warnings) console.error(`⚠ ${w.message}`);
  if (jobs.length === 0) {
    console.log('（暂无定时任务。添加：`delta cron add --name 每日整理 --cron "30 8 * * *" --prompt "整理日报"`）');
    return;
  }
  const lines: string[] = [];
  for (const j of jobs) {
    lines.push(`${j.enabled ? '●' : '○'} ${j.name}（${j.id}）`);
    lines.push(`  表达式：${j.cron}   下次运行：${j.nextRunAt ? formatTime(j.nextRunAt) : '待计算'}`);
    lines.push(`  目录：${j.cwd}`);
    lines.push(`  任务：${j.prompt.length > 80 ? `${j.prompt.slice(0, 80)}…` : j.prompt}`);
    lines.push(`  上次：${j.lastRun ? describeRun(j.lastRun) : '从未运行'}`);
  }
  console.log(lines.join('\n'));
}

/** add：新增任务（name 唯一、cron 校验、cwd 校验在 core 层完成）。 */
export function cronAddCommand(opts: {
  name?: string;
  cron?: string;
  prompt?: string;
  dir?: string;
  maxCost?: string;
  disable?: boolean;
}): void {
  try {
    if (!opts.name || !opts.cron || !opts.prompt) {
      console.error('✘ 缺少必填参数：--name / --cron / --prompt');
      process.exitCode = 1;
      return;
    }
    const job = addCronJob({
      name: opts.name,
      cron: opts.cron,
      prompt: opts.prompt,
      cwd: opts.dir ?? process.cwd(),
      enabled: !opts.disable,
      ...(opts.maxCost !== undefined ? { maxCostUsd: Number(opts.maxCost) || undefined } : {}),
    });
    console.log(`✔ 已添加定时任务 ${job.name}（${job.id}）`);
    console.log(`  表达式：${job.cron}   下次运行：${job.nextRunAt ? formatTime(job.nextRunAt) : '待计算'}`);
    console.log(`  目录：${job.cwd}`);
    if (!job.enabled) console.log('  （当前为停用状态，用 `delta cron enable` 启用）');
  } catch (e) {
    console.error(`✘ ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

/** remove：删除任务。 */
export function cronRemoveCommand(idOrName: string): void {
  try {
    const removed = removeCronJob(idOrName);
    console.log(`✔ 已删除定时任务 ${removed.name}（${removed.id}）`);
  } catch (e) {
    console.error(`✘ ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

/** enable / disable：启停任务。 */
export function cronToggleCommand(idOrName: string, enabled: boolean): void {
  try {
    const job = updateCronJob(idOrName, { enabled });
    console.log(`✔ 已${enabled ? '启用' : '停用'} ${job.name}（下次运行：${job.nextRunAt ? formatTime(job.nextRunAt) : '待计算'}）`);
  } catch (e) {
    console.error(`✘ ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

/**
 * run：手动补跑。无 --id 跑全部到期任务（trigger=manual，语义与调度一致）；
 * 有 --id 强制执行该任务一次（无视调度，不推进 nextRunAt，便于试跑）。
 */
export async function cronRunCommand(opts: { id?: string }): Promise<void> {
  const r = await runDueCronJobs({
    executor: createSpawnExecutor(),
    trigger: 'manual',
    ...(opts.id ? { onlyJobId: opts.id } : {}),
    logger: (l) => console.error(l),
  });
  if (r.ran.length === 0) {
    console.log(opts.id ? '✘ 未找到指定任务或未执行' : '（没有到期的任务）');
    if (opts.id) process.exitCode = 1;
    return;
  }
  console.log(`✔ 本次运行 ${r.ran.length} 个任务：${r.ran.join('、')}`);
}

/**
 * daemon：常驻调度进程。每 tickMs 扫描一次到期任务；SIGINT/SIGTERM 优雅退出。
 * --once 单轮补跑后退出（交给系统 cron / systemd timer 调度时使用）。
 */
export async function cronDaemonCommand(opts: { tickMs?: string; once?: boolean }): Promise<void> {
  if (opts.once) {
    const r = await runDueCronJobs({
      executor: createSpawnExecutor(),
      trigger: 'schedule',
      logger: (l) => console.error(l),
    });
    console.log(`调度单轮完成：运行 ${r.ran.length} 个，跳过 ${r.skipped} 个`);
    return;
  }
  const tickMs = Number(opts.tickMs) > 0 ? Number(opts.tickMs) : 30_000;
  const scheduler = startCronScheduler({
    executor: createSpawnExecutor(),
    tickMs,
    logger: (l) => console.error(l),
  });
  console.log(`调度器已启动（tick ${tickMs}ms，配置 ~/.delta/cron.json）。Ctrl+C 退出。`);
  await new Promise<void>((resolve) => {
    const onSignal = () => {
      console.error('\n收到退出信号，停止调度器…');
      scheduler.stop();
      resolve();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
  console.log('调度器已停止。');
}

// ── 展示辅助 ────────────────────────────────────────────────────────────────

/** ISO 时间 → 本地可读格式 */
function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** 单条运行记录的一行摘要 */
function describeRun(r: CronRunRecord): string {
  const base = `${r.status}（${r.trigger} ${formatTime(r.startedAt)}，${r.durationMs}ms${r.costUsd !== undefined ? `，$${r.costUsd.toFixed(4)}` : ''}）`;
  return r.error ? `${base}：${r.error.slice(0, 80)}` : base;
}

/** add 命令的 --cron 提示（供 index.ts description 复用） */
export function cronNextPreview(expr: string): string {
  try {
    return nextRun(expr, new Date())?.toLocaleString() ?? '（四年内无命中）';
  } catch (e) {
    return `表达式非法：${(e as Error).message}`;
  }
}
