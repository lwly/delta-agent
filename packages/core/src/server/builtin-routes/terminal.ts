import type { RouteDef } from '../routes.js';
import type { BuiltinHttpRouteContext } from './types.js';

export function appendTerminalBuiltinRoutes(routeTable: RouteDef[], ctx: BuiltinHttpRouteContext): void {
  const { opts, json, err } = ctx;
  routeTable.push(
    {
      method: 'GET',
      pattern: 'api/terminal/status',
      auth: 'token',
      permission: 'read',
      description: 'F-47 终端能力状态',
      handler: async ({ res }) => {
        if (!opts.terminal) return json(res, 200, { available: false, reason: '终端能力未装配', active: 0, max: 0 });
        return json(res, 200, await opts.terminal.status());
      },
    },
    {
      method: 'DELETE',
      pattern: 'api/terminal/:tid',
      auth: 'token',
      permission: 'write',
      description: 'F-47 关闭终端',
      handler: async ({ res, params }) => {
        if (!opts.terminal) return err(res, 501, '终端能力未装配');
        return json(res, 200, { ok: opts.terminal.close(params.tid!) });
      },
    },
  );
}
