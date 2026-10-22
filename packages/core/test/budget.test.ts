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

  it('warns at >=80%', () => {
    const b = new BudgetManager({ maxTokens: 1000, maxCostUsd: 1 });
    b.record({ inputTokens: 900, outputTokens: 0 });
    expect(b.shouldWarn()).toBe(true);
    expect(b.guard().exceeded).toBe(false);
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
});
