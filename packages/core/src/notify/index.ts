/** `@delta/core/notify` 公开入口。主桶 `@delta/core` 仍再导出这些符号。 */
export {
  DEFAULT_NOTIFY_CONFIG,
  NOTIFY_MERGE_FIELDS,
  noopNotifier,
  type Notifier,
  type NotifyConfig,
  type NotifyConfigSource,
  type NotifyConfigWarning,
  type NotifyMergeField,
  type NotifyTrigger,
} from './types.js';
export {
  loadNotifyConfig,
  normalizeNotifyLayer,
  projectNotifyConfigPath,
  updateUserNotifyEnabled,
  userNotifyConfigPath,
  type LoadNotifyConfigOptions,
  type NotifyConfigLayer,
  type ResolvedNotifyConfig,
  type UpdateUserNotifyEnabledResult,
} from './config.js';
export {
  buildNotifyCommand,
  createDesktopNotifier,
  DesktopNotifier,
  sanitizeBody,
  type DesktopNotifierOptions,
  type NotifyCommand,
} from './notifier.js';
