/**
 * F-50 自动更新 —— 类型定义。
 *
 * 配置与状态共用 `~/.delta/update.json`：
 *  - 配置面：enabled / source / intervalMs（用户手工编辑或 CLI 写入）
 *  - 状态面：lastCheckAt / lastSeenVersion（检查器自动回写，节流用）
 */

/** 更新源类型：GitHub Release / Gitee Release / 自定义 JSON 端点 */
export type UpdateSourceType = 'github' | 'gitee' | 'json';

export interface UpdateSource {
  type: UpdateSourceType;
  /** github/gitee：`owner/repo`；json：完整 URL */
  repo?: string;
  /** json：完整 URL（type=json 时必填） */
  url?: string;
}

export interface UpdateConfig {
  /** 启动检查总开关（`delta update` 手动检查不受影响） */
  enabled: boolean;
  /** 更新源（缺省 Gitee 主仓） */
  source: UpdateSource;
  /** 启动检查最小间隔（缺省一周） */
  intervalMs: number;
}

/** update.json 状态面（检查器回写，用户无需关心） */
export interface UpdateState {
  /** 上次启动检查时间（ISO）；`delta update` 手动检查不回写，避免吃掉节流窗口 */
  lastCheckAt?: string;
  /** 上次检查发现的新版本（提示去重用） */
  lastSeenVersion?: string;
}

export interface UpdateConfigAndState extends UpdateConfig, UpdateState {}

/** 单次检查结果 */
export interface UpdateCheckResult {
  /** 当前安装版本 */
  currentVersion: string;
  /** 远端最新版本（剥 v 前缀） */
  latestVersion: string;
  /** latestVersion > currentVersion 才为 true（降级一律视为无需更新） */
  hasUpdate: boolean;
  /** Release 页 / 自定义 JSON 的落地页（无则为空串） */
  releaseUrl: string;
  /** Release 说明（远端未提供则为空串） */
  notes: string;
  /** Release 资产清单（github/gitee 才有；json 源无） */
  assets: UpdateAsset[];
}

export interface UpdateAsset {
  name: string;
  downloadUrl: string;
}
