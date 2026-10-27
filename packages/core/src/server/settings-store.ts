/**
 * 会话预算设置存取（~/.delta/settings.json 的 budget 键）。
 *
 * Web 设置页「用量」面板读写；hub.send 每轮新建 BudgetManager 时重新读取，
 * 修改后下一轮运行即生效，无需重启 serve。
 * settings.json 为共享 KV 文件（其他设置键原样保留），本模块只操作 budget 键。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FILES, userConfigDir } from '../paths.js';

export interface BudgetSetting {
  /** 单轮任务累计 token 上限（input+output 按轮累加口径） */
  maxTokens?: number;
  /** 单轮任务累计费用上限（USD；由静态牌价估算） */
  maxCostUsd?: number;
}

function settingsFile(homeDir: string = os.homedir()): string {
  return path.join(userConfigDir(homeDir), FILES.settings);
}

/** 读取整个 settings.json（不存在/坏 JSON → 空对象，不抛错） */
function readSettings(homeDir: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(settingsFile(homeDir), 'utf-8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 宽松归一化：仅接受正数，非法值静默丢弃 */
function normalizeBudget(raw: unknown): BudgetSetting {
  if (typeof raw !== 'object' || raw === null) return {};
  const b = raw as Record<string, unknown>;
  const out: BudgetSetting = {};
  if (typeof b.maxTokens === 'number' && Number.isFinite(b.maxTokens) && b.maxTokens > 0) {
    out.maxTokens = Math.round(b.maxTokens);
  }
  if (typeof b.maxCostUsd === 'number' && Number.isFinite(b.maxCostUsd) && b.maxCostUsd > 0) {
    out.maxCostUsd = b.maxCostUsd;
  }
  return out;
}

/** 读取当前预算设置（未设置的字段由调用方回退 DEFAULT_SESSION_BUDGET） */
export function readBudgetSetting(homeDir: string = os.homedir()): BudgetSetting {
  return normalizeBudget(readSettings(homeDir).budget);
}

/**
 * 更新预算设置（merge 语义）：传 null 删除该字段（回退默认），
 * 传非正数抛错。返回归一化后的完整 budget 键。
 */
export function writeBudgetSetting(
  patch: { maxTokens?: number | null; maxCostUsd?: number | null },
  homeDir: string = os.homedir(),
): BudgetSetting {
  const all = readSettings(homeDir);
  const cur: Record<string, unknown> = { ...normalizeBudget(all.budget) };
  if (patch.maxTokens === null) {
    delete cur.maxTokens;
  } else if (patch.maxTokens !== undefined) {
    cur.maxTokens = Number(patch.maxTokens);
  }
  if (patch.maxCostUsd === null) {
    delete cur.maxCostUsd;
  } else if (patch.maxCostUsd !== undefined) {
    cur.maxCostUsd = Number(patch.maxCostUsd);
  }
  const next = normalizeBudget(cur);
  // 显式传入却非法 → 报错给调用方（HTTP 400），静默丢弃只该发生在读文件路径
  if (patch.maxTokens !== undefined && patch.maxTokens !== null && next.maxTokens === undefined) {
    throw new Error('maxTokens 必须是正数');
  }
  if (patch.maxCostUsd !== undefined && patch.maxCostUsd !== null && next.maxCostUsd === undefined) {
    throw new Error('maxCostUsd 必须是正数');
  }
  all.budget = next;
  const file = settingsFile(homeDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, 'utf-8');
  return next;
}
