import { KNOWN_TASK_KINDS } from '../../llm/router.js';
import type { RouteDef } from '../routes.js';
import type { BuiltinHttpRouteContext } from './types.js';

export function appendModelsRoutingBuiltinRoutes(routeTable: RouteDef[], ctx: BuiltinHttpRouteContext): void {
  const mgr = ctx.opts.providers;
  if (!mgr) return;
  const { json, err } = ctx;

  routeTable.push(
    {
      method: 'GET',
      pattern: 'api/models/routing',
      auth: 'token',
      permission: 'read',
      description: 'F-42 模型路由配置',
      handler: async ({ res }) =>
        json(res, 200, {
          knownKinds: KNOWN_TASK_KINDS,
          routing: mgr.getRouting() ?? { enabled: false, rules: {} },
        }),
    },
    {
      method: 'PUT',
      pattern: 'api/models/routing',
      auth: 'token',
      permission: 'write',
      description: 'F-42 保存模型路由（rules 校验与 provider 归一）',
      handler: async ({ res, readBody }) => {
        const body = await readBody();
        try {
          const current = mgr.getRouting();
          const rules =
            body.rules !== undefined
              ? (body.rules as Record<string, { provider?: string; model: string }>)
              : current?.rules ?? {};
          const normalized: Record<string, { provider?: string; model: string }> = {};
          for (const [kind, rule] of Object.entries(rules)) {
            if (!rule || typeof rule !== 'object') continue;
            if (typeof rule.model !== 'string') {
              normalized[kind] = rule as { model: string };
              continue;
            }
            const model = rule.model.trim();
            if (model === '') continue;
            const provider =
              typeof rule.provider === 'string' && rule.provider.trim() !== '' ? rule.provider.trim() : undefined;
            normalized[kind] = provider ? { provider, model } : { model };
          }
          const enabled = typeof body.enabled === 'boolean' ? body.enabled : current?.enabled ?? false;
          if (enabled && Object.keys(normalized).length === 0) {
            return err(res, 400, '启用路由前请先配置至少一条规则');
          }
          mgr.setRouting({ enabled, rules: normalized });
          return json(res, 200, { ok: true, routing: mgr.getRouting() });
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
      },
    },
  );
}
