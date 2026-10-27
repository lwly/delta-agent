/**
 * 模型计价表（USD / 1M tokens，公开牌价的估算口径）。
 *
 * 背景：各 Provider 网关的 usage 均不回传费用，BudgetManager 的 maxCostUsd
 * 维度此前恒为 0（告警/硬停/报表全部失效）。这里以静态牌价估算费用：
 * - 未收录模型返回 undefined → 该次调用不计费（诚实缺省，不猜价）
 * - 环境变量 DELTA_MODEL_PRICES_JSON 可覆盖/扩充：JSON 对象，
 *   键 = 模型名前缀，值 = { "input": USD/1M, "output": USD/1M }
 *
 * 牌价随官方调整会过期，此处仅为预算守门估算，不作为账单依据。
 */
import * as fs from 'node:fs';

export interface ModelPrice {
  /** 输入单价（USD / 1M tokens） */
  input: number;
  /** 输出单价（USD / 1M tokens） */
  output: number;
}

/** 内置牌价（前缀匹配，长者优先；数据为 2025 公开牌价的近似值） */
const BUILTIN_PRICES: Array<[prefix: string, ModelPrice]> = [
  ['deepseek', { input: 0.28, output: 0.42 }],
  ['gpt-4o-mini', { input: 0.15, output: 0.6 }],
  ['gpt-4o', { input: 2.5, output: 10 }],
  ['gpt-4.1-mini', { input: 0.4, output: 1.6 }],
  ['gpt-4.1', { input: 2, output: 8 }],
  ['o4-mini', { input: 1.1, output: 4.4 }],
  ['o3', { input: 2, output: 8 }],
  ['claude-opus', { input: 15, output: 75 }],
  ['claude-sonnet', { input: 3, output: 15 }],
  ['claude-haiku', { input: 1, output: 5 }],
  ['qwen', { input: 0.4, output: 1.2 }],
];

export const MODEL_PRICES_ENV = 'DELTA_MODEL_PRICES_JSON';

let envPricesCache: Array<[prefix: string, ModelPrice]> | undefined;
let envPricesRaw: string | undefined;

/** 解析并缓存环境变量覆盖表（按原始串缓存，进程内改 env 立即生效；非法输入忽略不抛错） */
function loadEnvPrices(): Array<[prefix: string, ModelPrice]> {
  const raw = process.env[MODEL_PRICES_ENV];
  if (envPricesCache && envPricesRaw === raw) return envPricesCache;
  envPricesRaw = raw;
  envPricesCache = [];
  if (raw?.trim()) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [prefix, value] of Object.entries(parsed)) {
        if (typeof value !== 'object' || value === null) continue;
        const p = value as Record<string, unknown>;
        const input = Number(p.input);
        const output = Number(p.output);
        if (Number.isFinite(input) && input >= 0 && Number.isFinite(output) && output >= 0) {
          envPricesCache.push([prefix, { input, output }]);
        }
      }
    } catch {
      // 非法 JSON：忽略覆盖，退回内置表
    }
  }
  return envPricesCache;
}

/** 按模型名前缀查价（环境变量表优先于内置表，同为前缀匹配时先命中先返回） */
export function priceFor(model: string): ModelPrice | undefined {
  for (const [prefix, price] of loadEnvPrices()) {
    if (model.startsWith(prefix)) return price;
  }
  for (const [prefix, price] of BUILTIN_PRICES) {
    if (model.startsWith(prefix)) return price;
  }
  return undefined;
}

/** 一次调用的费用估算（未收录模型返回 undefined） */
export function computeCostUsd(model: string, inputTokens: number, outputTokens: number): number | undefined {
  const price = priceFor(model);
  if (!price) return undefined;
  return (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output;
}
