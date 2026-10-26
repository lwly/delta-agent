/**
 * F-39 P1（T16）：专家信任清单 + 停用清单（~/.delta/experts.json）
 *
 * 口径（design §12.1）：
 * - 信任只是**知情同意**，不是权限边界（RestrictedRegistry 仍是硬边界）
 * - 仅 user/project 层需要确认；builtin 视为已信任（随程序分发、可审计）
 * - `version` 或工具集（toolsHash）任一变化即失效，需重新确认
 *   —— 堵「先发只读版本、再偷偷换写权限」的路径
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { FILES, userConfigDir } from '../paths.js';
import type { ExpertRecord } from './types.js';

export interface TrustedEntry {
  name: string;
  version: string;
  /** 解析后工具集（排序拼接）的 sha1 前 12 位；专家未声明 tools 时为字面量 'none' */
  toolsHash: string;
  trustedAt: string;
}

export interface ExpertsConfig {
  /** 停用的专家包名（不出现在召唤面板，可恢复） */
  disabled: string[];
  trusted: TrustedEntry[];
}

export function expertsConfigPath(homeDir: string): string {
  return path.join(userConfigDir(homeDir), FILES.expertsConfig);
}

/** 宽容读取：文件缺失 / JSON 损坏 → 空配置（不抛错） */
export async function readExpertsConfig(homeDir: string): Promise<ExpertsConfig> {
  try {
    const raw = await fs.readFile(expertsConfigPath(homeDir), 'utf-8');
    const v = JSON.parse(raw) as Partial<ExpertsConfig>;
    return {
      disabled: Array.isArray(v.disabled) ? v.disabled.filter((x) => typeof x === 'string') : [],
      trusted: Array.isArray(v.trusted) ? v.trusted : [],
    };
  } catch {
    return { disabled: [], trusted: [] };
  }
}

/** 原子写入（临时文件 + rename，避免半写文件） */
export async function writeExpertsConfig(homeDir: string, cfg: ExpertsConfig): Promise<void> {
  const file = expertsConfigPath(homeDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), 'utf-8');
  await fs.rename(tmp, file);
}

/** 工具集指纹：allow 集合排序拼接的 sha1 前 12 位；未声明 tools = 'none' */
export function toolsHashOf(record: ExpertRecord): string {
  if (record.tools === null) return 'none';
  return createHash('sha1').update([...record.tools].sort().join('\n')).digest('hex').slice(0, 12);
}

/** builtin 恒已信任；user/project 需 name+version+toolsHash 全部命中 */
export function isTrusted(cfg: ExpertsConfig, record: ExpertRecord): boolean {
  if (record.layer === 'builtin') return true;
  const entry = cfg.trusted.find((t) => t.name === record.name);
  if (!entry) return false;
  return entry.version === record.version && entry.toolsHash === toolsHashOf(record);
}

/** 记录信任（已存在则覆盖为当前 version/hash） */
export async function recordTrust(homeDir: string, record: ExpertRecord): Promise<void> {
  const cfg = await readExpertsConfig(homeDir);
  const entry: TrustedEntry = {
    name: record.name,
    version: record.version,
    toolsHash: toolsHashOf(record),
    trustedAt: new Date().toISOString(),
  };
  const rest = cfg.trusted.filter((t) => t.name !== record.name);
  await writeExpertsConfig(homeDir, { ...cfg, trusted: [...rest, entry] });
}

export async function revokeTrust(homeDir: string, name: string): Promise<void> {
  const cfg = await readExpertsConfig(homeDir);
  await writeExpertsConfig(homeDir, { ...cfg, trusted: cfg.trusted.filter((t) => t.name !== name) });
}

export async function setDisabled(homeDir: string, name: string, disabled: boolean): Promise<void> {
  const cfg = await readExpertsConfig(homeDir);
  const set = new Set(cfg.disabled);
  if (disabled) set.add(name);
  else set.delete(name);
  await writeExpertsConfig(homeDir, { ...cfg, disabled: [...set] });
}
