/**
 * F-50 自动更新 —— 桶导出（详见 docs/design-f50-auto-update.md）。
 */
export type {
  UpdateAsset,
  UpdateCheckResult,
  UpdateConfig,
  UpdateConfigAndState,
  UpdateSource,
  UpdateSourceType,
  UpdateState,
} from './types.js';
export {
  DEFAULT_UPDATE_CONFIG,
  DEFAULT_UPDATE_INTERVAL_MS,
  DEFAULT_UPDATE_SOURCE,
  loadUpdateConfig,
  userUpdateConfigPath,
  updateUpdateState,
  type ResolvedUpdateConfig,
  type UpdateConfigWarning,
} from './config.js';
export { compareVersions, isNewerVersion, parseVersion } from './version.js';
export {
  checkForUpdate,
  detectChannel,
  maybeCheckOnStartup,
  resolveSourceUrl,
  type CheckForUpdateOptions,
  type FetchLike,
  type MaybeCheckOnStartupOptions,
  type UpdateChannel,
} from './checker.js';
export { applyBinarySwap, downloadUpdateAsset, type ApplyBinarySwapResult, type DownloadUpdateAssetResult } from './install.js';
