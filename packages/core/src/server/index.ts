/**
 * `@delta/core/server` 公开入口：Hub、HTTP 装配、声明式路由与只读领域端点。
 * 主桶 `@delta/core` 仅兼容再导出本模块符号（P7 瘦身）。
 */
export {
  SessionHub,
  createSkillRuntime,
  type HubEvent,
  type SessionHubDeps,
  type SessionGitState,
  type BranchSwitchResult,
} from './hub.js';
export { createWebServer, type ServeOptions } from './http.js';
export {
  createServeRuntime,
  type ServeRuntime,
  type ServeRuntimeOptions,
} from './runtime.js';
export {
  appendRoutes,
  assertRouteDecls,
  matchRoute,
  type RouteAuth,
  type RouteDef,
  type RouteHandlerCtx,
  type RouteMethod,
  type RouteParams,
} from './routes.js';
export {
  handleBrowseRoute,
  type BrowseDeps,
  type BrowseRouteInput,
  type BrowseRouteOutcome,
} from './browse-routes.js';
export {
  handleExpertsRoute,
  resolveExpertForCreate,
  listExpertNames,
  type ExpertsRouteDeps,
} from './experts-routes.js';
