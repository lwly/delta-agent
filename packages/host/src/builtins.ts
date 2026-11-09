/**
 * P7 产物链：声明对内置贡献 workspace 包的依赖（commands 槽由 CLI 本体承担，
 * 不引 @delta/plugin-builtin-commands，避免 host→cli 环）。
 * 运行时登记仍由 core 侧载（builtins / mount / router），此处不重复 import 引擎 register。
 */
export { BUILTIN_HTTP_ROUTE_GROUPS } from '@delta/plugin-builtin-routes';
export { BUILTIN_VIEW_IDS, type BuiltinViewId } from '@delta/plugin-builtin-views';

export const BUILTIN_CONTRIBUTION_PACKAGES = [
  '@delta/plugin-builtin-engines',
  '@delta/plugin-builtin-services',
  '@delta/plugin-builtin-routes',
  '@delta/plugin-builtin-commands',
  '@delta/plugin-builtin-views',
] as const;
