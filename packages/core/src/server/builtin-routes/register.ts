/**
 * P4 内置 HTTP 路由表装配。createWebServer 闭包注入后按组登记。
 */
import type { RouteDef } from '../routes.js';
import { appendCronBuiltinRoutes } from './cron.js';
import { appendWorkerTasksBuiltinRoutes } from './worker-tasks.js';
import { appendProjectBuiltinRoutes } from './projects.js';
import { appendSkillsBuiltinRoutes } from './skills.js';
import { appendMarketBuiltinRoutes } from './market.js';
import { appendMcpBuiltinRoutes } from './mcp.js';
import { appendLogsBuiltinRoutes } from './logs.js';
import { appendProvidersBuiltinRoutes } from './providers.js';
import { appendModelsRoutingBuiltinRoutes } from './models-routing.js';
import { appendSessionBuiltinRoutes } from './sessions.js';
import { appendSessionDetailBuiltinRoutes } from './sessions-detail.js';
import { appendSessionStreamBuiltinRoutes } from './sessions-stream.js';
import { appendBrowseBuiltinRoutes } from './browse.js';
import { appendExpertsBuiltinRoutes } from './experts.js';
import { appendTerminalBuiltinRoutes } from './terminal.js';
import { appendExternalAgentsBuiltinRoutes } from './external-agents.js';
import { appendMemoryBuiltinRoutes } from './memory.js';
import { appendUsageBuiltinRoutes } from './usage.js';
import { appendSettingsBudgetBuiltinRoutes } from './settings-budget.js';
import { appendTrashBuiltinRoutes } from './trash.js';
import { appendSearchBuiltinRoutes } from './search.js';
import { appendSystemBuiltinRoutes } from './system.js';
import type { BuiltinHttpRouteContext } from './types.js';

export { BUILTIN_HTTP_ROUTE_GROUPS, type BuiltinHttpRouteContext } from './types.js';

export function appendBuiltinHttpRoutes(routeTable: RouteDef[], ctx: BuiltinHttpRouteContext): void {
  appendCronBuiltinRoutes(routeTable, ctx);
  appendWorkerTasksBuiltinRoutes(routeTable, ctx);
  appendProjectBuiltinRoutes(routeTable, ctx);
  appendSkillsBuiltinRoutes(routeTable, ctx);
  appendMarketBuiltinRoutes(routeTable, ctx);
  appendMcpBuiltinRoutes(routeTable, ctx);
  appendLogsBuiltinRoutes(routeTable, ctx);
  appendProvidersBuiltinRoutes(routeTable, ctx);
  appendModelsRoutingBuiltinRoutes(routeTable, ctx);
  appendSessionBuiltinRoutes(routeTable, ctx);
  appendSessionDetailBuiltinRoutes(routeTable, ctx);
  appendSessionStreamBuiltinRoutes(routeTable, ctx);
  appendBrowseBuiltinRoutes(routeTable, ctx);
  appendExpertsBuiltinRoutes(routeTable, ctx);
  appendTerminalBuiltinRoutes(routeTable, ctx);
  appendExternalAgentsBuiltinRoutes(routeTable, ctx);
  appendMemoryBuiltinRoutes(routeTable, ctx);
  appendUsageBuiltinRoutes(routeTable, ctx);
  appendSettingsBudgetBuiltinRoutes(routeTable, ctx);
  appendTrashBuiltinRoutes(routeTable, ctx);
  appendSearchBuiltinRoutes(routeTable, ctx);
  appendSystemBuiltinRoutes(routeTable, ctx);
}
