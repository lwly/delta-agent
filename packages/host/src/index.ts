/**
 * P7 宿主装配门面：serve 运行时 + 插件 API + 内置贡献包清单（SEA / desktop 入口）。
 */
export {
  createServeRuntime,
  createWebServer,
  SessionHub,
  type ServeRuntime,
  type ServeRuntimeOptions,
  type ServeOptions,
} from '@delta/core/server';
export {
  createPluginHost,
  loadPlugins,
  registerBuiltinServices,
  BUILTIN_SERVICE_IDS,
  type PluginHost,
  type LoadedPlugin,
} from '@delta/core/plugins';
export {
  BUILTIN_CONTRIBUTION_PACKAGES,
  BUILTIN_HTTP_ROUTE_GROUPS,
  BUILTIN_VIEW_IDS,
} from './builtins.js';
