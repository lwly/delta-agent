import type { RouteDef } from '../routes.js';
import type { BuiltinHttpRouteContext } from './types.js';

export function appendProvidersBuiltinRoutes(routeTable: RouteDef[], ctx: BuiltinHttpRouteContext): void {
  const mgr = ctx.opts.providers;
  if (!mgr) return;
  const { json, err } = ctx;

  routeTable.push(
    {
      method: 'GET',
      pattern: 'api/providers',
      auth: 'token',
      permission: 'read',
      description: 'F-04a Provider 清单（Key 不回显）',
      handler: async ({ res }) => json(res, 200, mgr.list()),
    },
    {
      method: 'PUT',
      pattern: 'api/providers/:id',
      auth: 'token',
      permission: 'write',
      description: '新增/更新 Provider',
      handler: async ({ res, readBody, params }) => {
        const body = await readBody();
        try {
          mgr.add({
            id: params.id!,
            apiKey: String(body.apiKey ?? ''),
            baseUrl: body.baseUrl ? String(body.baseUrl) : undefined,
            model: body.model ? String(body.model) : undefined,
            setDefault: body.setDefault === true,
          });
          return json(res, 200, { ok: true });
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
      },
    },
    {
      method: 'DELETE',
      pattern: 'api/providers/:id',
      auth: 'token',
      permission: 'write',
      description: '删除 Provider',
      handler: async ({ res, params }) => json(res, 200, { ok: mgr.remove(params.id!) }),
    },
    {
      method: 'POST',
      pattern: 'api/providers/:id/default',
      auth: 'token',
      permission: 'write',
      description: '设为默认 Provider',
      handler: async ({ res, params }) => {
        try {
          mgr.setDefault(params.id!);
          return json(res, 200, { ok: true });
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
      },
    },
    {
      method: 'POST',
      pattern: 'api/providers/:id/enable',
      auth: 'token',
      permission: 'write',
      description: '启用/禁用 Provider',
      handler: async ({ res, readBody, params }) => {
        const body = await readBody();
        mgr.setEnabled(params.id!, body.enabled === true);
        return json(res, 200, { ok: true });
      },
    },
    {
      method: 'POST',
      pattern: 'api/providers/:id/move',
      auth: 'token',
      permission: 'write',
      description: '排序上/下移',
      handler: async ({ res, readBody, params }) => {
        const body = await readBody();
        mgr.move(params.id!, body.dir === 'down' ? 'down' : 'up');
        return json(res, 200, { ok: true });
      },
    },
    {
      method: 'POST',
      pattern: 'api/providers/:id/test',
      auth: 'token',
      permission: 'write',
      description: '已保存 Provider 连通性测试',
      handler: async ({ res, params }) => json(res, 200, await mgr.test(params.id!)),
    },
    {
      method: 'POST',
      pattern: 'api/providers/test',
      auth: 'token',
      permission: 'write',
      description: '表单态连通性探测（不落盘）',
      handler: async ({ res, readBody }) => {
        const body = await readBody();
        try {
          const r = await mgr.testAdhoc({
            id: String(body.id ?? ''),
            apiKey: body.apiKey === undefined ? undefined : String(body.apiKey),
            baseUrl: body.baseUrl ? String(body.baseUrl) : undefined,
            model: body.model ? String(body.model) : undefined,
          });
          return json(res, 200, r);
        } catch (e) {
          return json(res, 200, { ok: false, latencyMs: 0, detail: (e as Error).message });
        }
      },
    },
    {
      method: 'POST',
      pattern: 'api/providers/models',
      auth: 'token',
      permission: 'write',
      description: '拉取网关模型列表（不落盘）',
      handler: async ({ res, readBody }) => {
        const body = await readBody();
        try {
          const r = await mgr.listModels({
            id: String(body.id ?? ''),
            apiKey: body.apiKey === undefined ? undefined : String(body.apiKey),
            baseUrl: body.baseUrl ? String(body.baseUrl) : undefined,
          });
          return json(res, 200, r);
        } catch (e) {
          return json(res, 200, { ok: false, models: [], detail: (e as Error).message });
        }
      },
    },
  );
}
