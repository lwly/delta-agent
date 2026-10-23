/**
 * F-22 定时任务 —— 调度存储单测：
 * CRUD、name 唯一、nextRunAt 预计算/重算、原子写、坏 JSON 拒写与降级读、
 * 非法条目跳过、运行历史截断 20 条。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addCronJob,
  findCronJob,
  loadCronJobs,
  MAX_RUN_HISTORY,
  removeCronJob,
  saveCronJobs,
  updateCronJob,
  userCronConfigPath,
  type CronJob,
} from '../src/cron/store.js';
import { nextRun } from '../src/cron/parse.js';

/** 临时 home 目录（含 .y-zero） */
function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yzero-cron-home-'));
  fs.mkdirSync(path.join(dir, '.y-zero'), { recursive: true });
  return dir;
}

/** 临时项目目录（作为 cwd） */
function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yzero-cron-proj-'));
}

const FROM = new Date(2026, 9, 1, 8, 0, 0, 0); // 2026-10-01 08:00 本地

function addSample(home: string, name = 'job-a', cron = '30 8 * * *'): CronJob {
  return addCronJob({ name, cron, prompt: '整理日报', cwd: tmpProject(), from: FROM }, home);
}

describe('F-22 cron 存储 CRUD', () => {
  it('空文件清单加载：无任务无警告不 corrupt', () => {
    const home = tmpHome();
    const r = loadCronJobs(home);
    expect(r.jobs).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.corrupt).toBe(false);
  });

  it('addCronJob：生成 id / 预计算 nextRunAt / cwd 绝对路径化', () => {
    const home = tmpHome();
    const job = addSample(home);
    expect(job.id).toMatch(/^cron-/);
    expect(job.enabled).toBe(true);
    expect(job.runs).toEqual([]);
    expect(path.isAbsolute(job.cwd)).toBe(true);
    expect(job.nextRunAt).toBe(nextRun('30 8 * * *', FROM)!.toISOString());
    // 落盘可读回
    expect(loadCronJobs(home).jobs).toHaveLength(1);
  });

  it('addCronJob：name 重复 / 空 name / 非法 cron / 目录不存在 → 拒绝', () => {
    const home = tmpHome();
    addSample(home, 'dup');
    expect(() => addCronJob({ name: 'dup', cron: '* * * * *', prompt: 'x', cwd: tmpProject() }, home)).toThrow(/已存在/);
    expect(() => addCronJob({ name: '  ', cron: '* * * * *', prompt: 'x', cwd: tmpProject() }, home)).toThrow(/名称/);
    expect(() => addCronJob({ name: 'bad', cron: '60 * * * *', prompt: 'x', cwd: tmpProject() }, home)).toThrow(/分钟/);
    expect(() => addCronJob({ name: 'noCwd', cron: '* * * * *', prompt: 'x', cwd: '/definitely/not/exist-xyz' }, home)).toThrow(/不存在/);
  });

  it('updateCronJob：改 cron 重算 nextRunAt；disable→enable 从当下重算', () => {
    const home = tmpHome();
    const job = addSample(home, 'u1');
    const updated = updateCronJob('u1', { cron: '0 22 * * *' }, home);
    expect(updated.cron).toBe('0 22 * * *');
    expect(updated.nextRunAt).toBe(nextRun('0 22 * * *', new Date())!.toISOString());
    // 改名冲突检测
    addSample(home, 'u2');
    expect(() => updateCronJob('u1', { name: 'u2' }, home)).toThrow(/已存在/);
    // disable 后 enable：nextRunAt 重算且 > now
    updateCronJob('u1', { enabled: false }, home);
    const reEnabled = updateCronJob('u1', { enabled: true }, home);
    expect(Date.parse(reEnabled.nextRunAt!)).toBeGreaterThan(Date.now() - 1000);
  });

  it('updateCronJob / removeCronJob：未找到任务 → 报错', () => {
    const home = tmpHome();
    expect(() => updateCronJob('ghost', { enabled: false }, home)).toThrow(/未找到/);
    expect(() => removeCronJob('ghost', home)).toThrow(/未找到/);
  });

  it('removeCronJob：按 name 删除并落盘', () => {
    const home = tmpHome();
    addSample(home, 'gone');
    const removed = removeCronJob('gone', home);
    expect(removed.name).toBe('gone');
    expect(loadCronJobs(home).jobs).toHaveLength(0);
  });

  it('findCronJob：id 与 name 均可命中', () => {
    const home = tmpHome();
    const job = addSample(home, 'f1');
    expect(findCronJob(loadCronJobs(home).jobs, job.id)!.name).toBe('f1');
    expect(findCronJob(loadCronJobs(home).jobs, 'f1')!.id).toBe(job.id);
    expect(findCronJob(loadCronJobs(home).jobs, 'nope')).toBeUndefined();
  });
});

describe('F-22 cron 存储健壮性', () => {
  it('坏 JSON：读降级（corrupt + warning），写拒绝', () => {
    const home = tmpHome();
    fs.writeFileSync(userCronConfigPath(home), '{ broken json', 'utf8');
    const r = loadCronJobs(home);
    expect(r.corrupt).toBe(true);
    expect(r.jobs).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(() => addSample(home)).toThrow(/无法解析/);
    expect(() => removeCronJob('x', home)).toThrow(/无法解析/);
  });

  it('非法条目跳过并警告；jobs 缺数组视为空清单', () => {
    const home = tmpHome();
    const file = userCronConfigPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, jobs: [{ id: 'x', name: 'n', cron: '* * * * *', prompt: 'p', cwd: '/tmp', createdAt: 't', updatedAt: 't' }, 'junk', { nope: 1 }] }),
      'utf8',
    );
    const r = loadCronJobs(home);
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0]!.name).toBe('n');
    expect(r.corrupt).toBe(false);
    expect(r.warnings).toHaveLength(2); // junk 与 {nope:1} 各一条

    fs.writeFileSync(file, JSON.stringify({ version: 1 }), 'utf8');
    expect(loadCronJobs(home).jobs).toEqual([]);
  });

  it('运行历史截断：超过 20 条滚动淘汰最旧', () => {
    const home = tmpHome();
    const job = addSample(home, 'hist');
    job.runs = Array.from({ length: 25 }, (_, i) => ({
      trigger: 'schedule' as const,
      startedAt: `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`,
      finishedAt: `2026-01-01T00:${String(i).padStart(2, '0')}:30.000Z`,
      durationMs: 30000,
      status: 'completed' as const,
      exitCode: 0,
    }));
    const { jobs } = loadCronJobs(home);
    jobs[0]!.runs = job.runs;
    saveCronJobs(jobs, home);
    const reloaded = loadCronJobs(home).jobs[0]!;
    expect(reloaded.runs).toHaveLength(MAX_RUN_HISTORY);
    expect(reloaded.runs[0]!.startedAt).toContain('05'); // 最旧 5 条被淘汰（25-20=5）
  });

  it('saveCronJobs 原子写：不留 tmp 文件', () => {
    const home = tmpHome();
    addSample(home);
    const dir = path.dirname(userCronConfigPath(home));
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });
});
