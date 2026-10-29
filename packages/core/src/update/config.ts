/**
 * F-50 自动更新 —— 配置读写（`~/.delta/update.json`，配置面 + 状态面共用）。
 *
 * 惯例对齐 notify/config.ts：
 *  - 读路径宽松归一化：非法值降级默认 + warning，永不 throw（配置写错不该让 agent 起不来）；
 *  - 写路径（updateState）写前读、只改状态字段、tmp+rename 原子写；坏 JSON 拒绝写入并抛错。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FILES, userConfigDir } from '../paths.js';
import type { UpdateConfig, UpdateConfigAndState, UpdateSource, UpdateState, UpdateSourceType } from './types.js';

export const DEFAULT_UPDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 每周一次（AC-50-1）

export const DEFAULT_UPDATE_SOURCE: UpdateSource = { type: 'gitee', repo: 'lwly/delta-agent' };

export const DEFAULT_UPDATE_CONFIG: UpdateConfig = {
  enabled: true,
  source: DEFAULT_UPDATE_SOURCE,
  intervalMs: DEFAULT_UPDATE_INTERVAL_MS,
};

const SOURCE_TYPES: readonly UpdateSourceType[] = ['github', 'gitee', 'json'];

export interface UpdateConfigWarning {
  field?: string;
  message: string;
}

export interface ResolvedUpdateConfig {
  config: UpdateConfigAndState;
  warnings: UpdateConfigWarning[];
}

/** 配置文件路径（CLI status 展示与检查器复用，保证单点）。 */
export function userUpdateConfigPath(homeDir: string = os.homedir()): string {
  return path.join(userConfigDir(homeDir), FILES.update);
}

/**
 * 单字段归一化（永不 throw）：非法值保持 undefined（= 用默认）+ warning。
 * source 是整体对象：结构不合法整字段忽略，不做半套字段修补。
 */
function normalizeLayer(raw: unknown, file: string, warnings: UpdateConfigWarning[]): Partial<UpdateConfigAndState> {
  const out: Partial<UpdateConfigAndState> = {};
  if (raw === undefined) return out;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push({ message: `update 配置不是 JSON 对象，已忽略：${file}` });
    return out;
  }
  const record = raw as Record<string, unknown>;
  const warn = (field: string, message: string): void => {
    warnings.push({ field, message });
  };

  if (record.enabled !== undefined) {
    if (typeof record.enabled === 'boolean') out.enabled = record.enabled;
    else warn('enabled', `enabled 必须为 boolean，收到 ${JSON.stringify(record.enabled)}，已用默认值`);
  }
  if (record.intervalMs !== undefined) {
    const v = record.intervalMs;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 60_000 && v <= 365 * 24 * 60 * 60 * 1000) {
      out.intervalMs = v;
    } else {
      warn('intervalMs', 'intervalMs 必须是 [1分钟, 1年] 内的数字，已用默认值');
    }
  }
  if (record.source !== undefined) {
    const s = record.source;
    if (s !== null && typeof s === 'object' && !Array.isArray(s)) {
      const src = s as Record<string, unknown>;
      const type = src.type;
      if (typeof type === 'string' && SOURCE_TYPES.includes(type as UpdateSourceType)) {
        const source: UpdateSource = { type: type as UpdateSourceType };
        if (typeof src.repo === 'string' && src.repo.trim() !== '') source.repo = src.repo.trim();
        if (typeof src.url === 'string' && src.url.trim() !== '') source.url = src.url.trim();
        out.source = source;
      } else {
        warn('source.type', `source.type 必须是 ${SOURCE_TYPES.join('|')}，收到 ${JSON.stringify(type)}，已用默认源`);
      }
    } else {
      warn('source', 'source 必须是对象，已用默认源');
    }
  }
  // 状态面（lastCheckAt / lastSeenVersion）：字符串透传，不校验语义
  if (typeof record.lastCheckAt === 'string') out.lastCheckAt = record.lastCheckAt;
  if (typeof record.lastSeenVersion === 'string') out.lastSeenVersion = record.lastSeenVersion;

  return out;
}

/**
 * 加载配置 + 状态（文件缺失返回纯默认值）。
 * **永不 throw**：坏 JSON / 非法值都降级为 warning 或默认值。
 */
export function loadUpdateConfig(homeDir: string = os.homedir()): ResolvedUpdateConfig {
  const warnings: UpdateConfigWarning[] = [];
  const file = userUpdateConfigPath(homeDir);
  let raw: unknown;
  try {
    if (!fs.existsSync(file)) return { config: { ...DEFAULT_UPDATE_CONFIG }, warnings };
    const text = fs.readFileSync(file, 'utf8');
    if (text.trim() === '') {
      warnings.push({ message: `update 配置为空文件，已忽略：${file}` });
      return { config: { ...DEFAULT_UPDATE_CONFIG }, warnings };
    }
    raw = JSON.parse(text);
  } catch (e) {
    warnings.push({ message: `update 配置无法解析 ${file}：${(e as Error).message}（已用默认值）` });
    return { config: { ...DEFAULT_UPDATE_CONFIG }, warnings };
  }
  const layer = normalizeLayer(raw, file, warnings);
  const config: UpdateConfigAndState = { ...DEFAULT_UPDATE_CONFIG };
  for (const key of ['enabled', 'intervalMs', 'source', 'lastCheckAt', 'lastSeenVersion'] as const) {
    const value = layer[key];
    if (value !== undefined) (config as unknown as Record<string, unknown>)[key] = value;
  }
  return { config, warnings };
}

export interface UpdateStateResult {
  path: string;
}

/**
 * 回写状态面（lastCheckAt / lastSeenVersion），**只改这两个字段**，其它原样保留。
 * 约束：tmp+rename 原子写；既有文件坏 JSON 时拒绝写入并抛错（宁可失败不覆盖用户文件）。
 */
export function updateUpdateState(state: UpdateState, opts: { homeDir?: string } = {}): UpdateStateResult {
  const file = userUpdateConfigPath(opts.homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let raw: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('不是 JSON 对象');
      }
      raw = parsed as Record<string, unknown>;
    } catch (e) {
      throw new Error(`更新配置 ${file} 无法解析（${(e as Error).message}），请手工修复后再试`);
    }
  }
  if (state.lastCheckAt !== undefined) raw.lastCheckAt = state.lastCheckAt;
  if (state.lastSeenVersion !== undefined) raw.lastSeenVersion = state.lastSeenVersion;

  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return { path: file };
}
