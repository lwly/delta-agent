import { normalizeRange, usageReportToJson } from '../../session/usage.js';
import type { RouteDef } from '../routes.js';
import type { BuiltinHttpRouteContext } from './types.js';

export function appendUsageBuiltinRoutes(routeTable: RouteDef[], ctx: BuiltinHttpRouteContext): void {
  const { service, json } = ctx;

  routeTable.push(
    {
      method: 'GET',
      pattern: 'api/usage/summary',
      auth: 'token',
      permission: 'read',
      description: 'F-31 用量汇总',
      handler: async ({ res, url }) => {
        const range = normalizeRange(url.searchParams.get('range'));
        const project = url.searchParams.get('project') ?? undefined;
        const report = service.usage.summary({ range, projectId: project });
        return json(res, 200, usageReportToJson(report, project ?? null));
      },
    },
    {
      method: 'GET',
      pattern: 'api/usage/sessions',
      auth: 'token',
      permission: 'read',
      description: 'F-31 按会话用量',
      handler: async ({ res, url }) => {
        const range = normalizeRange(url.searchParams.get('range'));
        const project = url.searchParams.get('project') ?? undefined;
        const items = service.usage.bySession({ range, projectId: project });
        return json(res, 200, { range, project: project ?? null, items });
      },
    },
  );
}
