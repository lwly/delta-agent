/** 与 `packages/web/src/builtin-views/constants.ts` 同步。 */
export const BUILTIN_VIEW_IDS = ['cron', 'logs', 'settings', 'replay'] as const;
export type BuiltinViewId = (typeof BUILTIN_VIEW_IDS)[number];
