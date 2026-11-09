import type { RouteDef } from '../routes.js';
import type { BuiltinHttpRouteContext } from './types.js';

export function appendSearchBuiltinRoutes(routeTable: RouteDef[], ctx: BuiltinHttpRouteContext): void {
  const { service, json } = ctx;

  routeTable.push(
    {
      method: 'GET',
      pattern: 'api/search/messages',
      auth: 'token',
      permission: 'read',
      description: 'F-17 对话全文/语义检索',
      handler: async ({ res, url }) => {
        const q = url.searchParams.get('q') ?? '';
        const mode = url.searchParams.get('mode');
        const limit = url.searchParams.get('limit');
        const hits = await service.searchMessages(q, {
          mode: mode === 'fulltext' || mode === 'semantic' ? mode : 'auto',
          limit: limit ? Number(limit) : undefined,
        });
        return json(res, 200, hits);
      },
    },
    {
      method: 'GET',
      pattern: 'api/search',
      auth: 'token',
      permission: 'read',
      description: '会话标题检索',
      handler: async ({ res, url }) => json(res, 200, service.searchSessions(url.searchParams.get('q') ?? '')),
    },
  );
}
