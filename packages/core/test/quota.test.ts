/**
 * 架构收口 T7 —— QuotaStore 统一预算判定单测。
 * 判据对照：
 *  1. 同一 key 多条记录累计 + 本次预估 > 上限 → overage；chat/worker/cron 三类调用方同一实现；
 *  2. BudgetManager.guard 的费用硬停与 QuotaStore.check 共享 quotaExceeded（同一输入同一判定）；
 *  3. 金额不入表——QuotaStore 纯内存，worker_tasks 金额查询口径不变（usage 聚合）。
 */
import { describe, expect, it } from 'vitest';
import { QuotaStore, quotaExceeded } from '../src/quota/store.js';
import { BudgetManager } from '../src/context/budget.js';

describe('quotaExceeded（共享纯函数，判据 2）', () => {
  it('used + extra >= max 判超；strictly below 不判', () => {
    expect(quotaExceeded(0.7, 0.7)).toBe(true);
    expect(quotaExceeded(0.7, 0.7, 0.1)).toBe(true);
    expect(quotaExceeded(0.5, 0.7, 0.1)).toBe(false);
  });

  it('max <= 0 = 不限额（与 BudgetManager.usedCostPct 的 max>0 口径一致）', () => {
    expect(quotaExceeded(999, 0)).toBe(false);
    expect(quotaExceeded(999, -1)).toBe(false);
  });
});

describe('QuotaStore（判据 1：累计 + 预估 → overage）', () => {
  it('同一会话 3 条记录累计成本 + 本次预估超限 → ok=false 且 overage 正确', () => {
    const q = new QuotaStore();
    q.record('session', 's-1', 0.2, 0.5);
    q.record('session', 's-1', 0.15);
    q.record('session', 's-1', 0.1);
    const r = q.check('session', 's-1', 0.1); // 本次预估 0.1 → 0.45+0.1=0.55 > 0.5
    expect(r.ok).toBe(false);
    expect(r.usedCostUsd).toBeCloseTo(0.45, 10);
    expect(r.overage).toBeCloseTo(0.05, 10);
    // 不带预估：0.45 < 0.5 → ok
    expect(q.check('session', 's-1').ok).toBe(true);
  });

  it('三类调用方（chat / subagent / cron）同一实现同一行为（判据 1）', () => {
    const q = new QuotaStore();
    for (const [kind, key] of [
      ['session', 'chat-s1'],
      ['subagent', 'router-r1'],
      ['cron', 'cron-x'],
    ] as const) {
      q.record(kind, key, 0.3, 0.4);
      q.record(kind, key, 0.2);
      const r = q.check(kind, key);
      expect(r.ok).toBe(false);
      expect(r.overage).toBeCloseTo(0.1, 10);
    }
  });

  it('无记录 key = 未设上限 → ok（不过度拦截）；max=0 不限额', () => {
    const q = new QuotaStore();
    expect(q.check('session', 'ghost').ok).toBe(true);
    q.record('session', 'free', 100, 0);
    expect(q.check('session', 'free', 50).ok).toBe(true); // max=0 不限额
  });

  it('reset 清账本；record 更新上限；负数成本按 0 处理（不做退费）', () => {
    const q = new QuotaStore();
    q.record('cron', 'c1', 0.3, 0.4);
    q.record('cron', 'c1', -5); // 退费不生效
    expect(q.snapshot('cron', 'c1')?.usedCostUsd).toBeCloseTo(0.3, 10);
    q.record('cron', 'c1', 0, 1.0); // 上限更新为 1.0
    expect(q.check('cron', 'c1', 0.5).ok).toBe(true);
    q.reset('cron', 'c1');
    expect(q.snapshot('cron', 'c1')).toBeUndefined();
    expect(q.check('cron', 'c1').usedCostUsd).toBe(0);
  });
});

describe('BudgetManager 与 QuotaStore 同判定（判据 2）', () => {
  it('同一输入下 guard 的费用硬停与 quotaExceeded 结论一致', () => {
    const b = new BudgetManager({ maxCostUsd: 0.5 });
    b.record({ inputTokens: 0, outputTokens: 0, costUsd: 0.5 });
    const g = b.guard();
    expect(g.exceeded).toBe(true);
    expect(g.reason).toBe('cost');
    // 共享纯函数同判定
    expect(quotaExceeded(b.state.usedCostUsd, b.config.maxCostUsd)).toBe(true);
    // QuotaStore 同输入同结论
    const q = new QuotaStore();
    q.record('session', 'same', 0.5, 0.5);
    expect(q.check('session', 'same').ok).toBe(false);
  });

  it('guard 未超限 ↔ quotaExceeded false（含 0 上限不限额分支）', () => {
    const b = new BudgetManager({ maxCostUsd: 0 }); // 不限额
    b.record({ inputTokens: 0, outputTokens: 0, costUsd: 100 });
    expect(b.guard().exceeded).toBe(false);
    expect(quotaExceeded(100, 0)).toBe(false);
  });
});
