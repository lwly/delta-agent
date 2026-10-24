/**
 * F-22b cronBuilder 单测：五模式双向转换往返（roundtrip）、非标准表达式回填
 * custom 且原值保留、buildCron 非法组合返回 null、validateCronForm 校验。
 */
import { describe, expect, it } from 'vitest';
import { buildCron, parseCronToForm, validateCronForm, type CronFormSchedule } from './cronBuilder.js';

function sched(over: Partial<CronFormSchedule> = {}): CronFormSchedule {
  return { mode: 'daily', time: '09:00', weekDays: [], monthDay: null, customExpr: '', ...over };
}

describe('F-22b buildCron 五模式生成', () => {
  it('hourly/daily/weekly/monthly/custom 生成规则表', () => {
    expect(buildCron(sched({ mode: 'hourly' }))).toBe('0 * * * *');
    // PRD 验收 2：每天 09:00 → `0 9 * * *`（数值不补零）
    expect(buildCron(sched({ mode: 'daily', time: '09:05' }))).toBe('5 9 * * *');
    expect(buildCron(sched({ mode: 'weekly', time: '08:30', weekDays: [5, 1, 1] }))).toBe('30 8 * * 1,5');
    expect(buildCron(sched({ mode: 'monthly', time: '09:00', monthDay: 15 }))).toBe('0 9 15 * *');
    expect(buildCron(sched({ mode: 'custom', customExpr: '*/15 8-18 * * 1-5' }))).toBe('*/15 8-18 * * 1-5');
  });

  it('非法组合返回 null：weekly 未选星期 / monthly 未选日期 / 时间非法 / custom 为空', () => {
    expect(buildCron(sched({ mode: 'weekly', weekDays: [] }))).toBeNull();
    expect(buildCron(sched({ mode: 'monthly', monthDay: null }))).toBeNull();
    expect(buildCron(sched({ mode: 'daily', time: '25:00' }))).toBeNull();
    expect(buildCron(sched({ mode: 'daily', time: 'abc' }))).toBeNull();
    expect(buildCron(sched({ mode: 'custom', customExpr: '   ' }))).toBeNull();
    expect(buildCron(sched({ mode: 'monthly', monthDay: 32 }))).toBeNull();
  });
});

describe('F-22b parseCronToForm 解析回填', () => {
  it('标准模式往返一致（build → parse → build）', () => {
    for (const expr of ['0 9 * * *', '30 8 * * *', '30 8 * * 1,5', '0 9 15 * *', '0 * * * *']) {
      const f = parseCronToForm(expr);
      expect(buildCron(f)).toBe(expr);
    }
    expect(parseCronToForm('0 9 * * *').mode).toBe('daily');
    expect(parseCronToForm('30 8 * * 1,5')).toMatchObject({ mode: 'weekly', weekDays: [1, 5] });
    expect(parseCronToForm('0 9 15 * *')).toMatchObject({ mode: 'monthly', monthDay: 15 });
    expect(parseCronToForm('0 * * * *').mode).toBe('hourly');
  });

  it('别名映射：@hourly/@daily/@weekly/@monthly', () => {
    expect(parseCronToForm('@hourly').mode).toBe('hourly');
    expect(parseCronToForm('@daily')).toMatchObject({ mode: 'daily', time: '00:00' });
    expect(parseCronToForm('@weekly')).toMatchObject({ mode: 'weekly', weekDays: [0] });
    expect(parseCronToForm('@monthly')).toMatchObject({ mode: 'monthly', monthDay: 1 });
  });

  it('非标准表达式回填 custom 且原值保留（PRD 验收 3/G3）', () => {
    for (const expr of ['*/15 8-18 * * 1-5', '0 0 1 1 *', '@yearly', '30 25 * * *', '99 99 * * *', 'junk']) {
      const f = parseCronToForm(expr);
      expect(f.mode).toBe('custom');
      expect(f.customExpr).toBe(expr);
    }
    // 步进仅 describe 用：表单态仍回填 custom
    expect(parseCronToForm('*/15 * * * *')).toMatchObject({ mode: 'custom', customExpr: '*/15 * * * *' });
  });
});

describe('F-22b validateCronForm', () => {
  const base = {
    name: '日报',
    prompt: '整理日报',
    cwd: '/tmp/project',
    permission: 'default' as const,
    validity: 'forever' as const,
    validFrom: '',
    validUntil: '',
    schedule: sched(),
  };

  it('合法表单通过（空错误集）', () => {
    expect(validateCronForm(base)).toEqual({});
    expect(validateCronForm({ ...base, schedule: sched({ mode: 'custom', customExpr: '*/5 * * * *' }) })).toEqual({});
  });

  it('必填与路径校验', () => {
    expect(validateCronForm({ ...base, name: ' ' }).name).toBeTruthy();
    expect(validateCronForm({ ...base, prompt: '' }).prompt).toBeTruthy();
    expect(validateCronForm({ ...base, cwd: '' }).cwd).toBeTruthy();
    expect(validateCronForm({ ...base, cwd: 'relative/path' }).cwd).toContain('绝对路径');
  });

  it('每周/每月缺选与自定义 cron 为空 → 内联错误', () => {
    expect(validateCronForm({ ...base, schedule: sched({ mode: 'weekly', weekDays: [] }) }).weekDays).toBeTruthy();
    expect(validateCronForm({ ...base, schedule: sched({ mode: 'monthly', monthDay: null }) }).monthDay).toBeTruthy();
    expect(validateCronForm({ ...base, schedule: sched({ mode: 'custom', customExpr: '' }) }).customExpr).toBeTruthy();
  });

  it('自定义有效期：起止齐全且 start<=end', () => {
    expect(validateCronForm({ ...base, validity: 'custom', validFrom: '2026-06-01', validUntil: '' }).validUntil).toBeTruthy();
    expect(
      validateCronForm({ ...base, validity: 'custom', validFrom: '2026-06-02', validUntil: '2026-06-01' }).validUntil,
    ).toContain('不能晚于');
    expect(validateCronForm({ ...base, validity: 'custom', validFrom: '2026-06-01', validUntil: '2026-06-01' })).toEqual({});
  });
});
