import { describe, expect, it } from 'vitest';
import { estimateTextTokens, estimateMessagesTokens } from '../src/context/tokens.js';
import { BudgetManager } from '../src/context/budget.js';

describe('token estimation', () => {
  it('CJK ~1 token per char', () => {
    expect(estimateTextTokens('你好世界')).toBe(4);
  });
  it('latin ~3 chars per token', () => {
    expect(estimateTextTokens('abcdefghij')).toBe(4); // ceil(10/3)
  });
  it('mixed text', () => {
    // 2 CJK + 6 latin => 2 + ceil(6/3) = 4
    expect(estimateTextTokens('你好abcdef')).toBe(4);
  });
  it('messages include overhead and tool calls', () => {
    const t = estimateMessagesTokens([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ argsJson: '{"a":1}' }] },
    ]);
    expect(t).toBeGreaterThan(0);
  });
});

describe('BudgetManager', () => {
  it('guards below thresholds', () => {
    const b = new BudgetManager({ maxTokens: 1000, maxCostUsd: 1 });
    b.record({ inputTokens: 500, outputTokens: 100 });
    expect(b.guard().exceeded).toBe(false);
    expect(b.usedTokenPct()).toBeCloseTo(0.6);
  });

  it('takeAlert：未超 50% 零告警', () => {
    const b = new BudgetManager({ maxTokens: 1000, maxCostUsd: 1 });
    b.record({ inputTokens: 400, outputTokens: 0 });
    expect(b.takeAlert()).toBeNull();
    expect(b.guard().exceeded).toBe(false);
  });

  it('takeAlert：50% 恰好触发且一次性（重复调用返回 null）', () => {
    const b = new BudgetManager({ maxTokens: 1000, maxCostUsd: 1 });
    b.record({ inputTokens: 500, outputTokens: 0 });
    expect(b.takeAlert()).toMatchObject({ level: 0.5, usedTokenPct: 0.5 });
    expect(b.takeAlert()).toBeNull();
  });

  it('takeAlert：80% 升级一次，随后静默', () => {
    const b = new BudgetManager({ maxTokens: 1000, maxCostUsd: 1 });
    b.record({ inputTokens: 500, outputTokens: 0 });
    expect(b.takeAlert()?.level).toBe(0.5);
    b.record({ inputTokens: 350, outputTokens: 0 }); // 85%
    expect(b.takeAlert()).toMatchObject({ level: 0.8 });
    // 同级继续消耗不再告警
    b.record({ inputTokens: 50, outputTokens: 0 }); // 90%
    expect(b.takeAlert()).toBeNull();
  });

  it('takeAlert：跨级跳变（40%→90%）只发 0.8 一条', () => {
    const b = new BudgetManager({ maxTokens: 1000, maxCostUsd: 1 });
    b.record({ inputTokens: 400, outputTokens: 0 }); // 40%，无告警
    expect(b.takeAlert()).toBeNull();
    b.record({ inputTokens: 500, outputTokens: 0 }); // 直接到 90%
    expect(b.takeAlert()).toMatchObject({ level: 0.8 });
    expect(b.takeAlert()).toBeNull(); // 不补发 0.5
  });

  it('takeAlert：双维度取高（token 50% / cost 80% → 发 0.8）', () => {
    const b = new BudgetManager({ maxTokens: 1000, maxCostUsd: 1 });
    b.record({ inputTokens: 500, outputTokens: 0, costUsd: 0.8 });
    const alert = b.takeAlert();
    expect(alert?.level).toBe(0.8);
    expect(alert?.usedTokenPct).toBeCloseTo(0.5);
    expect(alert?.usedCostPct).toBeCloseTo(0.8);
  });

  it('takeAlert：纯费用维度也能触发', () => {
    const b = new BudgetManager({ maxTokens: 1_000_000, maxCostUsd: 1 });
    b.record({ inputTokens: 10, outputTokens: 10, costUsd: 0.6 });
    expect(b.takeAlert()?.level).toBe(0.5);
    b.record({ inputTokens: 10, outputTokens: 10, costUsd: 0.25 });
    expect(b.takeAlert()?.level).toBe(0.8);
  });

  it('takeAlert：100% 各一次，且与 guard 硬停语义独立', () => {
    const b = new BudgetManager({ maxTokens: 1000, maxCostUsd: 1 });
    b.record({ inputTokens: 550, outputTokens: 0 });
    expect(b.takeAlert()?.level).toBe(0.5);
    b.record({ inputTokens: 300, outputTokens: 0 });
    expect(b.takeAlert()?.level).toBe(0.8);
    b.record({ inputTokens: 150, outputTokens: 0 }); // 100%
    expect(b.takeAlert()).toMatchObject({ level: 1.0 });
    expect(b.takeAlert()).toBeNull();
    // 硬停照旧（退出码 4 协议依赖）
    expect(b.guard().exceeded).toBe(true);
  });

  it('hard-stops at token budget exhaustion', () => {
    const b = new BudgetManager({ maxTokens: 1000, maxCostUsd: 1 });
    b.record({ inputTokens: 800, outputTokens: 300 });
    const g = b.guard();
    expect(g.exceeded).toBe(true);
    expect(g.reason).toBe('token');
  });

  it('hard-stops at cost budget exhaustion', () => {
    const b = new BudgetManager({ maxTokens: 1_000_000, maxCostUsd: 0.5 });
    b.record({ inputTokens: 10, outputTokens: 10, costUsd: 0.6 });
    expect(b.guard().exceeded).toBe(true);
    expect(b.guard().reason).toBe('cost');
  });

  it('summary is human readable', () => {
    const b = new BudgetManager({ maxTokens: 1000, maxCostUsd: 1 });
    b.record({ inputTokens: 1000, outputTokens: 0, costUsd: 1 });
    expect(b.summarize()).toContain('预算耗尽');
  });

  it('summarize 支持 degraded 文案（方案 D）', () => {
    const b = new BudgetManager({ maxTokens: 1000, maxCostUsd: 1 });
    b.record({ inputTokens: 1000, outputTokens: 0 });
    expect(b.summarize('degraded')).toContain('已降级续跑');
    expect(b.summarize()).toContain('任务已安全停止');
  });

  // ── 方案 C：子代理配额预留（并行派生防超卖）──

  it('reserveTokens：预留量受 maxTokens − 已用 − 已预留 约束', () => {
    const b = new BudgetManager({ maxTokens: 100_000, maxCostUsd: 1 });
    b.record({ inputTokens: 50_000, outputTokens: 0 });
    expect(b.reserveTokens(60_000)).toBe(50_000); // 剩余 50k
    expect(b.remainingTokens()).toBe(0);
    expect(b.reserveTokens(1)).toBe(0); // 已无余量
    b.releaseTokens(50_000);
    expect(b.remainingTokens()).toBe(50_000);
  });

  it('reserveTokens：并行按序预留，总量不超过父剩余', () => {
    const b = new BudgetManager({ maxTokens: 100_000, maxCostUsd: 1 });
    expect(b.reserveTokens(60_000)).toBe(60_000);
    expect(b.reserveTokens(60_000)).toBe(40_000); // 第二个并行子代理只拿到剩余
    expect(b.reserveTokens(1)).toBe(0);
  });

  it('reserveTokens：已超限（used > max）时返回 0（fail-fast 依据）', () => {
    const b = new BudgetManager({ maxTokens: 1000, maxCostUsd: 1 });
    b.record({ inputTokens: 1200, outputTokens: 0 });
    expect(b.reserveTokens(60_000)).toBe(0);
    expect(b.remainingTokens()).toBe(0);
  });

  it('releaseTokens：释放后配额归还，实际用量不受影响', () => {
    const b = new BudgetManager({ maxTokens: 100_000, maxCostUsd: 1 });
    const r = b.reserveTokens(60_000);
    b.record({ inputTokens: 20_000, outputTokens: 0 });
    b.releaseTokens(r);
    expect(b.remainingTokens()).toBe(80_000); // 100k − 20k 用量
    expect(b.usedTokens()).toBe(20_000);
  });
});
