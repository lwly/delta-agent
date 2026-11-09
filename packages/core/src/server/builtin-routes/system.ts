import { viewContributionMetas } from '../../plugins/view-meta.js';
import type { RouteDef } from '../routes.js';
import type { BuiltinHttpRouteContext } from './types.js';

export function appendSystemBuiltinRoutes(routeTable: RouteDef[], ctx: BuiltinHttpRouteContext): void {
  const { opts, hub, json } = ctx;

  routeTable.push(
    {
      method: 'GET',
      pattern: 'api/status',
      auth: 'token',
      permission: 'read',
      description: 'F-22 调度器状态（D3 裁决；不可 /api/cron/status）',
      handler: async ({ res }) => {
        const st = opts.cronStatus?.() ?? { running: false, mode: 'off' as const };
        return json(res, 200, { cron: st });
      },
    },
    {
      method: 'GET',
      pattern: 'api/running-sessions',
      auth: 'token',
      permission: 'read',
      description: 'PASI-9 运行中会话 / 项目 id 列表',
      handler: async ({ res }) => json(res, 200, { ids: hub.runningSessionIds(), projects: hub.runningProjectIds() }),
    },
    {
      method: 'GET',
      pattern: 'api/tools',
      auth: 'token',
      permission: 'read',
      description: 'Web 设置页工具清单（内置 + MCP）',
      handler: async ({ res }) => json(res, 200, { items: hub.toolInventory() }),
    },
    {
      method: 'GET',
      pattern: 'api/plugins',
      auth: 'token',
      permission: 'read',
      description: 'P6 用户插件发现 + 视图元数据',
      handler: async ({ res }) =>
        json(res, 200, {
          plugins: opts.pluginsSnapshot ?? [],
          views: viewContributionMetas().map((v) => ({ name: v.name, path: v.path, slot: v.slot, module: v.module })),
        }),
    },
  );
}
