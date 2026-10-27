import { describe, expect, it } from 'vitest';
import { computeCostUsd, priceFor, MODEL_PRICES_ENV } from '../src/llm/pricing.js';

describe('llm/pricing（费用维度激活）', () => {
  it('内置表前缀匹配：deepseek / claude / gpt 系列', () => {
    expect(priceFor('deepseek-v4.1-flash')).toEqual({ input: 0.28, output: 0.42 });
    expect(priceFor('deepseek-chat')).toEqual({ input: 0.28, output: 0.42 });
    expect(priceFor('claude-sonnet-4-5')?.input).toBe(3);
    expect(priceFor('gpt-4o-mini')?.input).toBe(0.15);
    // 长前缀优先：gpt-4o-mini 先于 gpt-4o 命中
    expect(priceFor('gpt-4o')).toEqual({ input: 2.5, output: 10 });
  });

  it('未收录模型返回 undefined（诚实缺省，不猜价）', () => {
    expect(priceFor('unknown-model-xyz')).toBeUndefined();
    expect(computeCostUsd('unknown-model-xyz', 1000, 1000)).toBeUndefined();
  });

  it('computeCostUsd：按 1M 单价换算', () => {
    // deepseek 0.28/0.42：1M in + 1M out = 0.70
    expect(computeCostUsd('deepseek-chat', 1_000_000, 1_000_000)).toBeCloseTo(0.7, 6);
    expect(computeCostUsd('deepseek-chat', 221_000, 0)).toBeCloseTo((221_000 / 1e6) * 0.28, 9);
  });

  it('环境变量覆盖内置表（DELTA_MODEL_PRICES_JSON）', () => {
    process.env[MODEL_PRICES_ENV] = JSON.stringify({ 'deepseek-v4.1-flash': { input: 0.1, output: 0.3 } });
    try {
      expect(priceFor('deepseek-v4.1-flash')).toEqual({ input: 0.1, output: 0.3 });
      // 未覆盖的模型仍走内置表
      expect(priceFor('deepseek-chat')).toEqual({ input: 0.28, output: 0.42 });
    } finally {
      delete process.env[MODEL_PRICES_ENV];
    }
  });

  it('非法环境变量 JSON 忽略（退回内置表）', () => {
    process.env[MODEL_PRICES_ENV] = '{oops';
    try {
      expect(priceFor('deepseek-chat')).toEqual({ input: 0.28, output: 0.42 });
    } finally {
      delete process.env[MODEL_PRICES_ENV];
    }
  });
});
