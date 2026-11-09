import type { RouteDef } from '../routes.js';
import type { BuiltinHttpRouteContext } from './types.js';

export function appendTrashBuiltinRoutes(routeTable: RouteDef[], ctx: BuiltinHttpRouteContext): void {
  const { service, json, err } = ctx;

  routeTable.push(
    {
      method: 'GET',
      pattern: 'api/trash',
      auth: 'token',
      permission: 'read',
      description: '回收站列表',
      handler: async ({ res }) => json(res, 200, service.listTrash()),
    },
    {
      method: 'POST',
      pattern: 'api/trash/restore/:kind/:id',
      auth: 'token',
      permission: 'write',
      description: '从回收站恢复',
      handler: async ({ res, params }) => {
        try {
          service.restore(params.kind! === 'project' ? 'project' : 'session', params.id!);
          return json(res, 200, { ok: true });
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
      },
    },
    {
      method: 'DELETE',
      pattern: 'api/trash/:kind/:id',
      auth: 'token',
      permission: 'write',
      description: '回收站彻底清除',
      handler: async ({ res, params }) => {
        if (params.kind !== 'project' && params.kind !== 'session') return err(res, 404, 'not found');
        try {
          service.purgeTrash(params.kind, params.id!);
          return json(res, 200, { ok: true });
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
      },
    },
    {
      method: 'POST',
      pattern: 'api/trash/purge-batch',
      auth: 'token',
      permission: 'write',
      description: '批量清除回收站',
      handler: async ({ res, readBody }) => {
        const body = await readBody();
        const items = Array.isArray(body.items) ? body.items : [];
        const isValidItem = (it: unknown): it is { kind: 'project' | 'session'; id: string } =>
          typeof it === 'object' &&
          it !== null &&
          ((it as { kind?: unknown }).kind === 'project' || (it as { kind?: unknown }).kind === 'session') &&
          typeof (it as { id?: unknown }).id === 'string' &&
          (it as { id?: unknown }).id !== '';
        if (items.length === 0 || items.some((it) => !isValidItem(it))) {
          return err(res, 400, 'items must be a non-empty array of { kind: project|session, id: string }');
        }
        const result = service.purgeTrashBatch(items);
        return json(res, 200, { ok: true, purged: result.purged, failed: result.failed });
      },
    },
  );
}
