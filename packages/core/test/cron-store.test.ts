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
  cronJobToJson,
  findCronJob,
  isInValidWindow,
  loadCronJobs,
  MAX_RUN_HISTORY,
  removeCronJob,
  saveCronJobs,
  updateCronJob,
  userCronConfigPath,
  type CronJob,
} from '../src/cron/store.js';
import { nextRun } from '../src/cron/parse.js';

/** 临时 home 目录（含 .delta） */
function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-cron-home-'));
  fs.mkdirSync(path.join(dir, '.delta'), { recursive: true });
  return dir;
}

/** 临时项目目录（作为 cwd） */
function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'delta-cron-proj-'));
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

describe('F-22b 有效期与权限字段', () => {
  it('addCronJob 携带新字段落盘并读回；cronJobToJson 输出 snake_case（存在才输出）', () => {
    const home = tmpHome();
    const job = addCronJob(
      {
        name: 'f22b',
        cron: '30 8 * * *',
        prompt: 'p',
        cwd: tmpProject(),
        permission: 'yolo',
        validFrom: '2026-01-01T00:00:00.000Z',
        validUntil: '2026-12-31T23:59:59.000Z',
      },
      home,
    );
    expect(job.permission).toBe('yolo');
    expect(job.validFrom).toBe('2026-01-01T00:00:00.000Z');
    const disk = loadCronJobs(home).jobs[0]!;
    expect(disk.permission).toBe('yolo');
    expect(disk.validUntil).toBe('2026-12-31T23:59:59.000Z');
    // 传输口径：snake_case，存在才输出
    const json = cronJobToJson(disk) as Record<string, unknown>;
    expect(json.permission).toBe('yolo');
    expect(json.valid_from).toBe('2026-01-01T00:00:00.000Z');
    expect(json.valid_until).toBe('2026-12-31T23:59:59.000Z');
    // 缺省任务：三字段均不输出（缺省 = default / 长期有效）
    const plainJob = addSample(home, 'plain');
    const plain = cronJobToJson(plainJob) as Record<string, unknown>;
    expect('permission' in plain).toBe(false);
    expect('valid_from' in plain).toBe(false);
    expect('valid_until' in plain).toBe(false);
  });

  it('updateCronJob：null 清除（恢复缺省）；undefined 不动；旧文件（无新字段）读写不丢原有字段', () => {
    const home = tmpHome();
    addCronJob(
      {
        name: 'patched',
        cron: '30 8 * * *',
        prompt: 'p',
        cwd: tmpProject(),
        permission: 'plan',
        validFrom: '2026-01-01T00:00:00.000Z',
        validUntil: '2026-12-31T23:59:59.000Z',
      },
      home,
    );
    // undefined = 不动
    let job = updateCronJob('patched', { prompt: 'p2' }, home);
    expect(job.permission).toBe('plan');
    expect(job.validFrom).toBeDefined();
    // null = 清除
    job = updateCronJob('patched', { permission: null, validFrom: null, validUntil: null }, home);
    expect(job.permission).toBeUndefined();
    expect(job.validFrom).toBeUndefined();
    expect(job.validUntil).toBeUndefined();
    // 落盘确认：字段被移除（存储缺省即清除态，不落 null）
    const disk = loadCronJobs(home).jobs[0]!;
    expect(disk.permission).toBeUndefined();
    expect(disk.validUntil).toBeUndefined();
    // 旧文件（无新字段）= 长期有效 + default，读写不丢原有字段
    const file = userCronConfigPath(home);
    const legacy = JSON.parse(fs.readFileSync(file, 'utf8')) as { jobs: Array<Record<string, unknown>> };
    legacy.jobs[0] = {
      id: 'legacy-1',
      name: 'legacy',
      cron: '* * * * *',
      prompt: 'p',
      cwd: '/tmp',
      enabled: true,
      maxCostUsd: 0.5,
      createdAt: 't',
      updatedAt: 't',
      nextRunAt: '2026-01-01T00:00:00.000Z',
      runs: [],
    };
    fs.writeFileSync(file, JSON.stringify(legacy), 'utf8');
    const reloaded = loadCronJobs(home).jobs.find((j) => j.name === 'legacy')!;
    expect(reloaded.permission).toBeUndefined();
    expect(reloaded.validFrom).toBeUndefined();
    expect(reloaded.validUntil).toBeUndefined();
    expect(reloaded.maxCostUsd).toBe(0.5);
    expect(reloaded.nextRunAt).toBe('2026-01-01T00:00:00.000Z');
    const saved = updateCronJob('legacy', { enabled: false }, home);
    expect(saved.maxCostUsd).toBe(0.5);
  });

  it('normalize 字段级降级：单字段非法只丢该字段，不丢整条任务', () => {
    const home = tmpHome();
    const file = userCronConfigPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: 'x1',
            name: 'degraded',
            cron: '* * * * *',
            prompt: 'p',
            cwd: '/tmp',
            enabled: true,
            createdAt: 't',
            updatedAt: 't',
            permission: 'sudo', // 非法枚举 → 丢弃（按 default 处理）
            validFrom: 'not-a-date', // 非 ISO → 丢弃
            validUntil: 12345, // 非字符串 → 丢弃
            runs: [],
          },
        ],
      }),
      'utf8',
    );
    const r = loadCronJobs(home);
    expect(r.warnings).toHaveLength(0); // 字段级降级不产生整条 warning
    expect(r.jobs).toHaveLength(1);
    const job = r.jobs[0]!;
    expect(job.name).toBe('degraded');
    expect(job.permission).toBeUndefined();
    expect(job.validFrom).toBeUndefined();
    expect(job.validUntil).toBeUndefined();
  });

  it('isInValidWindow 三态（窗口前/内/后）+ 含两端边界 + 非法日期字段视为无界', () => {
    const due = new Date(2026, 5, 1, 9, 0, 0);
    // 缺省字段 = 无界
    expect(isInValidWindow({}, due)).toBe(true);
    // 仅 validFrom：前 false / 等于（边界含）/ 后 true
    expect(isInValidWindow({ validFrom: new Date(2026, 5, 1, 9, 0, 1).toISOString() }, due)).toBe(false);
    expect(isInValidWindow({ validFrom: due.toISOString() }, due)).toBe(true);
    expect(isInValidWindow({ validFrom: new Date(2026, 4, 1).toISOString() }, due)).toBe(true);
    // 仅 validUntil：due 早于终点 true / 等于（边界含）true / due 晚于终点（窗口已过）false
    expect(isInValidWindow({ validUntil: new Date(2026, 5, 1, 9, 0, 1).toISOString() }, due)).toBe(true);
    expect(isInValidWindow({ validUntil: due.toISOString() }, due)).toBe(true);
    expect(isInValidWindow({ validUntil: new Date(2026, 5, 1, 8, 59, 59).toISOString() }, due)).toBe(false);
    // 双字段：窗口内 / 窗口外
    const win = { validFrom: new Date(2026, 4, 1).toISOString(), validUntil: new Date(2026, 5, 30).toISOString() };
    expect(isInValidWindow(win, due)).toBe(true);
    expect(isInValidWindow({ ...win, validUntil: new Date(2026, 4, 30).toISOString() }, due)).toBe(false);
    // 非法日期字段（normalize 后不应出现，但函数容错）：视为无界
    expect(isInValidWindow({ validFrom: 'garbage', validUntil: 'garbage' }, due)).toBe(true);
  });
});
