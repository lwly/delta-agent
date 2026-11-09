/** `@delta/core/plugins` 公开入口（P7：主桶 `export *` 本模块；装配清单见 `@delta/host`）。 */
import './builtins.js';
export { registerEngine, resolveEngine, registeredEngineIds, type EngineId, type EngineRun } from './host.js';
export { registerTool, builtinTools } from './tools.js';
export { createServiceHost, type HostService, type ServiceHost } from './services.js';
export {
  registerBuiltinServices,
  BUILTIN_SERVICE_IDS,
  resetCronSchedulerActiveForTests,
  type BuiltinServicesHandles,
  type BuiltinServicesOptions,
} from './builtin-services/index.js';
export {
  loadPlugins,
  type LoadPluginsOptions,
  type LoadedPlugin,
  type PluginLayer,
  type PluginStatus,
} from './loader.js';
export {
  createPluginHost,
  invokePluginActivate,
  type PluginHost,
  type CommandContribution,
  type CreatePluginHostOptions,
} from './activate.js';
export {
  registerViewMeta,
  viewContributionMetas,
  resetViewMetasForTests,
  type ViewContributionMeta,
  type ViewSlot,
} from './view-meta.js';
