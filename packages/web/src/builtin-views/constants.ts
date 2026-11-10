/** P5 内置视图 id（与 registerView 的 name 一致）。 */
export const BUILTIN_VIEW_IDS = ['cron', 'usage', 'settings', 'replay'] as const;
export type BuiltinViewId = (typeof BUILTIN_VIEW_IDS)[number];
