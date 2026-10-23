/**
 * F-22 定时任务 —— cron 解析与 nextRun 单测：
 * 别名展开、字段值域/步进/区间/列表、dom+dow OR 惯例、逐级跳转正确性、
 * 非法表达式报错、4 年搜索上限返回 null。
 */
import { describe, expect, it } from 'vitest';
import { nextRun, parseCron } from '../src/cron/parse.js';

/** 本地时区构造：new Date(year, month-1, day, hour, minute) */
function at(month: number, day: number, hour: number, minute: number, year = 2026): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

/** 断言 nextRun(expr, from) === expected（逐字段比较，规避时区噪声；year 缺省用 y） */
function expectNext(
  expr: string,
  from: Date,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  year?: number,
): void {
  const got = nextRun(expr, from);
  expect(got).not.toBeNull();
  expect(got!.getFullYear()).toBe(year ?? y);
  expect(got!.getMonth()).toBe(mo - 1);
  expect(got!.getDate()).toBe(d);
  expect(got!.getHours()).toBe(h);
  expect(got!.getMinutes()).toBe(mi);
  expect(got!.getSeconds()).toBe(0);
}

describe('F-22 parseCron 结构', () => {
  it('通配表达式：全字段 unrestricted', () => {
    const f = parseCron('* * * * *');
    expect(f.minutes.every(Boolean)).toBe(true);
    expect(f.hours.every(Boolean)).toBe(true);
    expect(f.months.slice(1).every(Boolean)).toBe(true); // 月表 1 基，索引 0 未用
    expect(f.doms.slice(1).every(Boolean)).toBe(true); // 日表 1 基
    expect(f.domRestricted).toBe(false);
    expect(f.dowRestricted).toBe(false);
  });

  it('dow=7 归一为周日（0）', () => {
    const f = parseCron('0 0 * * 7');
    expect(f.dowRestricted).toBe(true);
    expect(f.dows[0]).toBe(true);
  });

  it('步进与区间列表组合', () => {
    const f = parseCron('*/15,30 9-17/2 * * 1-5');
    expect(f.minutes[0]).toBe(true);
    expect(f.minutes[15]).toBe(true);
    expect(f.minutes[30]).toBe(true);
    expect(f.minutes[45]).toBe(true);
    expect(f.minutes[10]).toBe(false);
    expect(f.hours[9]).toBe(true);
    expect(f.hours[10]).toBe(false);
    expect(f.hours[11]).toBe(true);
  });
});

describe('F-22 nextRun 逐级跳转', () => {
  it('每分钟：严格晚于 from', () => {
    expectNext('* * * * *', at(10, 1, 8, 0), 2026, 10, 1, 8, 1);
    expectNext('* * * * *', at(10, 1, 8, 59), 2026, 10, 1, 9, 0);
  });

  it('每天 08:30：跳过当日已过时刻', () => {
    expectNext('30 8 * * *', at(10, 1, 9, 0), 2026, 10, 2, 8, 30);
    expectNext('30 8 * * *', at(10, 1, 8, 30), 2026, 10, 2, 8, 30); // 恰好等于 from → 明天
    expectNext('30 8 * * *', at(10, 1, 7, 0), 2026, 10, 1, 8, 30);
  });

  it('每小时整点', () => {
    expectNext('0 * * * *', at(10, 1, 8, 30), 2026, 10, 1, 9, 0);
  });

  it('每周一 09:00（dow=1）', () => {
    // 2026-10-01 是周四 → 下一个周一是 2026-10-05
    expectNext('0 9 * * 1', at(10, 1, 12, 0), 2026, 10, 5, 9, 0);
  });

  it('每月 1 号 00:00（dom=1）', () => {
    expectNext('0 0 1 * *', at(10, 15, 3, 0), 2026, 11, 1, 0, 0);
  });

  it('跨年：12 月 31 日之后到明年', () => {
    expectNext('0 0 1 1 *', at(12, 31, 12, 0, 2026), 2026, 1, 1, 0, 0, 2027);
  });

  it('dom 与 dow 同时受限 → OR（POSIX）', () => {
    // `0 0 13 * 5`：13 号或周五都触发。2026-10-13 是周二、下一个周五是 10-16 → 10-13 先到
    expectNext('0 0 13 * 5', at(10, 10, 0, 0), 2026, 10, 13, 0, 0);
    // 13 号已过 → 下一个周五 10-16
    expectNext('0 0 13 * 5', at(10, 14, 0, 0), 2026, 10, 16, 0, 0);
  });

  it('月末边界：1 月 31 日表达式在 2 月跳到 3 月 31 日', () => {
    expectNext('0 0 31 * *', at(2, 1, 0, 0), 2026, 3, 31, 0, 0);
  });

  it('别名展开：@daily / @hourly', () => {
    expectNext('@daily', at(10, 1, 5, 0), 2026, 10, 2, 0, 0);
    expectNext('@hourly', at(10, 1, 5, 30), 2026, 10, 1, 6, 0);
  });

  it('非法表达式抛错（含字段信息）', () => {
    expect(() => parseCron('60 * * * *')).toThrow(/分钟/);
    expect(() => parseCron('* 24 * * *')).toThrow(/小时/);
    expect(() => parseCron('* * 0 * *')).toThrow(/日/);
    expect(() => parseCron('* * * 13 *')).toThrow(/月/);
    expect(() => parseCron('* * * *')).toThrow(/5 个字段/);
    expect(() => parseCron('* * * * 8')).toThrow(/周/);
    expect(() => parseCron('a * * * *')).toThrow();
    expect(() => parseCron('*/0 * * * *')).toThrow(/步进/);
    expect(() => parseCron('5-2 * * * *')).toThrow();
    expect(() => nextRun('nope', new Date())).toThrow();
  });

  it('合法但四年内无命中 → null（2 月 30 日）', () => {
    expect(nextRun('0 0 30 2 *', at(1, 1, 0, 0))).toBeNull();
  });

  it('nextRun 不修改 from（纯函数语义）', () => {
    const from = at(10, 1, 8, 0);
    const ts = from.getTime();
    nextRun('30 8 * * *', from);
    expect(from.getTime()).toBe(ts);
  });
});
