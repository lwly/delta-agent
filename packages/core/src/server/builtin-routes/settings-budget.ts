import { DEFAULT_SESSION_BUDGET } from '../../context/budget.js';
import { readBudgetSetting, writeBudgetSetting } from '../settings-store.js';
import type { RouteDef } from '../routes.js';
import type { BuiltinHttpRouteContext } from './types.js';
import { resolveConfigHome } from './config-home.js';

export function appendSettingsBudgetBuiltinRoutes(routeTable: RouteDef[], ctx: BuiltinHttpRouteContext): void {
  const { json, err } = ctx;
  const settingsHome = () => resolveConfigHome(ctx.opts);

  routeTable.push(
    {
      method: 'GET',
      pattern: 'api/settings/budget',
      auth: 'token',
      permission: 'read',
      description: '会话预算设置读',
      handler: async ({ res }) => json(res, 200, { ...readBudgetSetting(settingsHome()), defaults: DEFAULT_SESSION_BUDGET }),
    },
    {
      method: 'PUT',
      pattern: 'api/settings/budget',
      auth: 'token',
      permission: 'write',
      description: '会话预算设置写',
      handler: async ({ res, readBody }) => {
        const body = await readBody();
        const pick = (snake: string, camel: string): { present: boolean; value: unknown } => {
          if (snake in body) return { present: true, value: body[snake] };
          if (camel in body) return { present: true, value: body[camel] };
          return { present: false, value: undefined };
        };
        const t = pick('max_tokens', 'maxTokens');
        const c = pick('max_cost_usd', 'maxCostUsd');
        try {
          const saved = writeBudgetSetting(
            {
              maxTokens: t.present ? (t.value === null ? null : Number(t.value)) : undefined,
              maxCostUsd: c.present ? (c.value === null ? null : Number(c.value)) : undefined,
            },
            settingsHome(),
          );
          return json(res, 200, { ok: true, ...saved });
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
      },
    },
    {
      method: 'POST',
      pattern: 'api/settings/budget/extend',
      auth: 'token',
      permission: 'write',
      description: '预算追加倍数（方案 D）',
      handler: async ({ res, readBody }) => {
        const body = await readBody();
        const multiply = Number(body.multiply ?? 2);
        if (!Number.isFinite(multiply) || multiply <= 0 || multiply > 100) {
          return err(res, 400, 'multiply 必须是 (0, 100] 内的数值');
        }
        const home = settingsHome();
        const cur = readBudgetSetting(home);
        const next = writeBudgetSetting(
          {
            maxTokens: Math.round((cur.maxTokens ?? DEFAULT_SESSION_BUDGET.maxTokens) * multiply),
            maxCostUsd: (cur.maxCostUsd ?? DEFAULT_SESSION_BUDGET.maxCostUsd) * multiply,
          },
          home,
        );
        return json(res, 200, { ok: true, ...next });
      },
    },
  );
}
