/**
 * F-22 定时任务 —— 到期执行器与调度循环单测：
 * 到期判定、禁用/运行锁跳过、锁残留清理、失败不中断、nextRunAt 推进、
 * onlyJobId 手动强制（不推进调度）、历史落盘、scheduler tick 循环与 stop。
 */
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDueCronJobs, type CronExecutor, type CronExecutorResult } from '../src/cron/runner.js';
import { startCronScheduler } from '../src/cron/scheduler.js';
import { addCronJob, loadCronJobs, saveCronJobs, userCronConfigPath, type CronJob } from '../src/cron/store.js';

function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yzero-cron-run-'));
  fs.mkdirSync(path.join(dir, '.y-zero'), { recursive: true });
  return dir;
}

const NOW = new Date(2026, 9, 1, 8, 0, 0, 0); // 2026-10-01 08:00

function okResult(over: Partial<CronExecutorResult> = {}): CronExecutorResult {
  return { status: 'completed', exitCode: 0, sessionId: 's-1', costUsd: 0.01, turns: 3, ...over };
}

/** 建一个已到期（nextRunAt 在 NOW 之前）的任务；over 覆盖字段需落盘 */
function addDueJob(home: string, name: string, over: Partial<CronJob> = {}): CronJob {
  const job = addCronJob({ name, cron: '30 8 * * *', prompt: '任务', cwd: home, from: new Date(2026, 8, 1, 8, 0) }, home);
  const { jobs } = loadCronJobs(home);
  const disk = jobs.find((j) => j.id === job.id)!;
  Object.assign(disk, over);
  saveCronJobs(jobs, home);
  return Object.assign(job, over);
}

function executorOf(results: CronExecutorResult[], calls: Array<{ name: string; trigger: string }> = []): CronExecutor {
  return async (job, ctx) => {
    calls.push({ name: job.name, trigger: ctx.trigger });
    return results[Math.min(calls.length - 1, results.length - 1)]!;
  };
}

describe('F-22 runDueCronJobs', () => {
  it('到期任务被执行、nextRunAt 推进、运行记录落盘', async () => {
    const home = tmpHome();
    addDueJob(home, 'due');
    const calls: Array<{ name: string; trigger: string }> = [];
    const r = await runDueCronJobs({ executor: executorOf([okResult()], calls), homeDir: home, now: NOW, logger: () => {} });
    expect(r.ran).toEqual(['due']);
    expect(r.skipped).toBe(0);
    expect(calls[0]!.trigger).toBe('schedule');
    const job = loadCronJobs(home).jobs[0]!;
    expect(job.nextRunAt).toBe(new Date(2026, 9, 1, 8, 30).toISOString()); // NOW=08:00 → 当日 08:30
    expect(job.lastRun!.status).toBe('completed');
    expect(job.lastRun!.sessionId).toBe('s-1');
    expect(job.runningSince).toBeUndefined();
  });

  it('未到期与禁用任务跳过', async () => {
    const home = tmpHome();
    addCronJob({ name: 'future', cron: '30 8 * * *', prompt: 'x', cwd: home, from: NOW }, home); // nextRunAt = 明天
    addDueJob(home, 'off', { enabled: false });
    const calls: Array<{ name: string }> = [];
    const r = await runDueCronJobs({ executor: executorOf([okResult()], calls), homeDir: home, now: NOW });
    expect(r.ran).toEqual([]);
    expect(r.skipped).toBe(1); // 仅统计启用的未到期任务；禁用任务不计入
    expect(calls).toHaveLength(0);
  });

  it('运行锁未过期跳过；残留超 24h 自动解除并执行', async () => {
    const home = tmpHome();
    addDueJob(home, 'locked', { runningSince: new Date(NOW.getTime() - 3600_000).toISOString() }); // 1h 前
    addDueJob(home, 'stale', { runningSince: new Date(NOW.getTime() - 25 * 3600_000).toISOString() }); // 25h 前
    const calls: Array<{ name: string }> = [];
    const logs: string[] = [];
    const r = await runDueCronJobs({ executor: executorOf([okResult()], calls), homeDir: home, now: NOW, logger: (l) => logs.push(l) });
    expect(r.ran).toEqual(['stale']);
    expect(logs.some((l) => l.includes('自动解除'))).toBe(true);
    expect(loadCronJobs(home).jobs.find((j) => j.name === 'locked')!.runningSince).toBeDefined();
  });

  it('执行失败不中断后续任务；结果分别落盘', async () => {
    const home = tmpHome();
    addDueJob(home, 'bad');
    addDueJob(home, 'good');
    const calls: Array<{ name: string }> = [];
    const results: CronExecutorResult[] = [
      okResult({ status: 'failed', exitCode: 2, error: 'boom' }),
      okResult(),
    ];
    const r = await runDueCronJobs({ executor: executorOf(results, calls), homeDir: home, now: NOW });
    expect(r.ran).toEqual(['bad', 'good']);
    const jobs = loadCronJobs(home).jobs;
    expect(jobs.find((j) => j.name === 'bad')!.lastRun!.status).toBe('failed');
    expect(jobs.find((j) => j.name === 'bad')!.lastRun!.error).toBe('boom');
    expect(jobs.find((j) => j.name === 'good')!.lastRun!.status).toBe('completed');
  });

  it('执行器抛错兜底为 error 记录', async () => {
    const home = tmpHome();
    addDueJob(home, 'throwing');
    const r = await runDueCronJobs({
      executor: async () => {
        throw new Error('kaboom');
      },
      homeDir: home,
      now: NOW,
    });
    expect(r.ran).toEqual(['throwing']);
    expect(loadCronJobs(home).jobs[0]!.lastRun!.status).toBe('error');
  });

  it('onlyJobId：无视调度强制执行一次，不推进 nextRunAt', async () => {
    const home = tmpHome();
    addDueJob(home, 'manual');
    const calls: Array<{ name: string; trigger: string }> = [];
    await runDueCronJobs({
      executor: executorOf([okResult()], calls),
      homeDir: home,
      now: NOW,
      onlyJobId: 'manual',
      trigger: 'manual',
    });
    expect(calls[0]!.trigger).toBe('manual');
    const job = loadCronJobs(home).jobs[0]!;
    expect(job.nextRunAt).toBe(new Date(2026, 8, 1, 8, 30).toISOString()); // 保持原值（2026-09-01 08:30）
    expect(job.lastRun!.trigger).toBe('manual');
  });

  it('坏 JSON 存储时安全返回不执行', async () => {
    const home = tmpHome();
    fs.writeFileSync(userCronConfigPath(home), '{ nope', 'utf8');
    const calls: Array<{ name: string }> = [];
    const r = await runDueCronJobs({ executor: executorOf([okResult()], calls), homeDir: home, now: NOW });
    expect(r.ran).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('缺 nextRunAt 的启用任务视同到期补跑', async () => {
    const home = tmpHome();
    addDueJob(home, 'nonext', { nextRunAt: undefined });
    const { jobs } = loadCronJobs(home);
    jobs[0]!.nextRunAt = undefined;
    saveCronJobs(jobs, home);
    const calls: Array<{ name: string }> = [];
    const r = await runDueCronJobs({ executor: executorOf([okResult()], calls), homeDir: home, now: NOW });
    expect(r.ran).toEqual(['nonext']);
  });
});

describe('F-22 startCronScheduler', () => {
  it('tick 到期执行，stop 后不再执行', async () => {
    const home = tmpHome();
    addDueJob(home, 'tick1');
    const calls: Array<{ name: string }> = [];
    const exec: CronExecutor = async (job) => {
      calls.push({ name: job.name });
      return okResult();
    };
    const s = startCronScheduler({ executor: exec, homeDir: home, tickMs: 20, logger: () => {} });
    // 等首轮（启动即跑）完成：任务已被执行
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(s.isRunning()).toBe(true);
    // nextRunAt 已推进到未来 → 后续 tick 不再执行
    expect(Date.parse(loadCronJobs(home).jobs[0]!.nextRunAt!)).toBeGreaterThan(Date.now());
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toHaveLength(1);
    expect(s.stop()).toBe(true);
    expect(s.stop()).toBe(false); // 幂等
    expect(s.isRunning()).toBe(false);
  });

  it('signal abort 停止调度', async () => {
    const ac = new AbortController();
    const s = startCronScheduler({ executor: async () => okResult(), homeDir: tmpHome(), tickMs: 20, signal: ac.signal });
    expect(s.isRunning()).toBe(true);
    ac.abort();
    expect(s.isRunning()).toBe(false);
    s.stop();
  });
});
