import { handleBrowseRoute } from '../browse-routes.js';
import type { RouteDef } from '../routes.js';
import type { BuiltinHttpRouteContext } from './types.js';

const BROWSE_ACTIONS: Array<{ action: string; method: 'GET' | 'POST' }> = [
  { action: 'tree', method: 'GET' },
  { action: 'file', method: 'GET' },
  { action: 'changes', method: 'GET' },
  { action: 'diff', method: 'GET' },
  { action: 'reveal', method: 'POST' },
];

export function appendBrowseBuiltinRoutes(routeTable: RouteDef[], ctx: BuiltinHttpRouteContext): void {
  const { service, json, err } = ctx;
  const browseDeps = ctx.browseDeps ?? {};

  for (const family of ['sessions', 'projects'] as const) {
    for (const { action, method } of BROWSE_ACTIONS) {
      routeTable.push({
        method,
        pattern: `api/${family}/:id/browse/${action}`,
        auth: 'token',
        permission: method === 'POST' ? 'write' : 'read',
        description: `F-38 ${family} browse/${action}`,
        handler: async ({ req, res, url, params }) => {
          const parts = ['api', family, params.id!, 'browse', action];
          const out = await handleBrowseRoute({ method, parts, url, req, service, browseDeps });
          if (!out) return err(res, 404, 'not found');
          return json(res, out.status, out.body);
        },
      });
    }
  }
}
