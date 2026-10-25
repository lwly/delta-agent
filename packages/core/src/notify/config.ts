/**
 * F-33 桌面通知 —— 配置体系（设计 §3，样例沿用 F-30 sandbox/config.ts）：
 *  - 两级 JSON（`~/.delta/notify.json` < `.delta/notify.json`）逐字段覆盖
 *  - 非法值 ⇒ 降级默认 + warning，**永不 throw**（配置写错不该让 agent 起不来）
 *  - `updateUserNotifyEnabled`：CLI enable/disable 唯一写入口——写前读、只改 enabled、tmp+rename 原子写
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FILES, projectConfigDir, userConfigDir } from '../paths.js';
import {
  DEFAULT_NOTIFY_CONFIG,
  NOTIFY_MERGE_FIELDS,
  type NotifyConfig,
  type NotifyConfigSource,
  type NotifyConfigWarning,
  type NotifyMergeField,
} from './types.js';

/** 单层归一化后的配置（未声明的字段保持 undefined，不参与 merge） */
export type NotifyConfigLayer = Partial<NotifyConfig>;

export interface ResolvedNotifyConfig {
  config: NotifyConfig;
  warnings: NotifyConfigWarning[];
  /** 任一字段被显式配置过（用户层或项目层）时为 true */
  explicit: boolean;
}

// ── 单层归一化 ──────────────────────────────────────────────────────────────

/**
 * 单层归一化：非法值降级为「未声明」+ warning；坏结构整层忽略。
 * 该函数**从不抛异常**。
 */
export function normalizeNotifyLayer(
  raw: unknown,
  source: NotifyConfigSource,
  warnings: NotifyConfigWarning[],
): NotifyConfigLayer {
  const layer: NotifyConfigLayer = {};
  if (raw === undefined) return layer;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push({ source, message: `notify 配置（${source}）不是 JSON 对象，已忽略该层` });
    return layer;
  }
  const record = raw as Record<string, unknown>;
  const warn = (field: string, message: string): void => {
    warnings.push({ source, field, message });
  };

  if (record.enabled !== undefined) {
    if (typeof record.enabled === 'boolean') layer.enabled = record.enabled;
    else warn('enabled', `enabled 必须为 boolean，收到 ${JSON.stringify(record.enabled)}，已忽略`);
  }
  if (record.onDone !== undefined) {
    if (typeof record.onDone === 'boolean') layer.onDone = record.onDone;
    else warn('onDone', `onDone 必须为 boolean，收到 ${JSON.stringify(record.onDone)}，已忽略`);
  }
  if (record.onConfirm !== undefined) {
    if (typeof record.onConfirm === 'boolean') layer.onConfirm = record.onConfirm;
    else warn('onConfirm', `onConfirm 必须为 boolean，收到 ${JSON.stringify(record.onConfirm)}，已忽略`);
  }
  if (record.minDurationMs !== undefined) {
    const v = record.minDurationMs;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 24 * 60 * 60 * 1000) {
      layer.minDurationMs = v;
    } else {
      warn('minDurationMs', `minDurationMs 必须是 [0, 86400000] 内的数字，收到 ${JSON.stringify(v)}，已用默认值`);
    }
  }

  // 未知键：warning 忽略（不阻断，避免版本升级时旧配置炸掉）
  for (const key of Object.keys(record)) {
    if (!NOTIFY_MERGE_FIELDS.includes(key as NotifyMergeField)) warn(key, `未知配置项 ${key}，已忽略`);
  }

  return layer;
}

// ── 加载（两级文件）─────────────────────────────────────────────────────────

/** 全局配置文件路径（`notify enable/disable` 与 status 展示复用，保证单点）。 */
export function userNotifyConfigPath(homeDir: string = os.homedir()): string {
  return path.join(userConfigDir(homeDir), FILES.notify);
}

/** 项目配置文件路径。 */
export function projectNotifyConfigPath(projectRoot: string): string {
  return path.join(projectConfigDir(projectRoot), FILES.notify);
}

export interface LoadNotifyConfigOptions {
  projectRoot: string;
  /** 缺省 os.homedir() */
  homeDir?: string;
}

/**
 * 加载生效配置：用户层 → 项目层逐字段覆盖。
 * **永不 throw**：坏 JSON / 非法值都降级为 warning 或「该层不生效」。
 * 文件缺失时只做一次 `existsSync`（对齐 F-30 Z2：启动零成本）。
 */
export function loadNotifyConfig(opts: LoadNotifyConfigOptions): ResolvedNotifyConfig {
  const warnings: NotifyConfigWarning[] = [];

  const homeDir = opts.homeDir ?? os.homedir();
  const userLayer = normalizeNotifyLayer(
    readNotifyFile(userNotifyConfigPath(homeDir), 'user', warnings),
    'user',
    warnings,
  );
  const projectLayer = normalizeNotifyLayer(
    readNotifyFile(projectNotifyConfigPath(opts.projectRoot), 'project', warnings),
    'project',
    warnings,
  );

  const config: NotifyConfig = { ...DEFAULT_NOTIFY_CONFIG };
  let explicit = false;
  for (const field of NOTIFY_MERGE_FIELDS) {
    for (const layer of [userLayer, projectLayer]) {
      const value = layer[field];
      if (value !== undefined) {
        (config as unknown as Record<string, unknown>)[field] = value;
        explicit = true;
      }
    }
  }
  return { config, warnings, explicit };
}

function readNotifyFile(file: string, source: NotifyConfigSource, warnings: NotifyConfigWarning[]): unknown {
  try {
    if (!fs.existsSync(file)) return undefined;
    const text = fs.readFileSync(file, 'utf8');
    if (text.trim() === '') {
      warnings.push({ source, message: `notify 配置（${source}）为空文件，已忽略：${file}` });
      return undefined;
    }
    return JSON.parse(text) as unknown;
  } catch (e) {
    // 坏 JSON 不致命：该层不生效 + warning（对齐 sandbox / hooks 的既有惯例）
    warnings.push({
      source,
      message: `notify 配置（${source}）无法解析 ${file}：${(e as Error).message}（已忽略该层）`,
    });
    return undefined;
  }
}

// ── enable/disable 写路径（设计 §3：只改 enabled、写前读、tmp+rename 原子写）──

export interface UpdateUserNotifyEnabledResult {
  path: string;
  /** 写入前的 enabled（文件不存在视为默认值 true） */
  previous: boolean;
}

/**
 * 修改**全局**通知总开关（`delta notify enable/disable` 唯一写入口）。
 * 约束：
 *  - 只改 `enabled` 一个字段，文件内其它字段**原样保留**（写前读）；
 *  - tmp + rename 原子写（进程中断不会留下半个 JSON）；
 *  - 既有文件坏 JSON 时**拒绝写入**并抛错（覆盖用户文件属于破坏性动作，宁可失败）。
 */
export function updateUserNotifyEnabled(
  enabled: boolean,
  opts: { homeDir?: string } = {},
): UpdateUserNotifyEnabledResult {
  const file = userNotifyConfigPath(opts.homeDir);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  let raw: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('不是 JSON 对象');
      }
      raw = parsed as Record<string, unknown>;
    } catch (e) {
      throw new Error(`通知配置 ${file} 无法解析（${(e as Error).message}），请手工修复后再试`);
    }
  }
  const previous = raw.enabled === false ? false : true;
  raw.enabled = enabled;

  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return { path: file, previous };
}
