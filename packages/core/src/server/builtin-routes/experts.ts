import { handleExpertsRoute, type ExpertsRouteDeps } from '../experts-routes.js';
import type { RouteHandlerCtx, RouteDef } from '../routes.js';
import type { BuiltinHttpRouteContext } from './types.js';
import { resolveConfigHome } from './config-home.js';

function expertsDeps(ctx: BuiltinHttpRouteContext): ExpertsRouteDeps {
  return {
    service: ctx.service,
    storeFor: ctx.expertStoreFor!,
    resetStores: ctx.resetExpertStores ?? (() => undefined),
    configHome: resolveConfigHome(ctx.opts),
    isRunning: (sessionId) => ctx.hub.isRunning(sessionId),
    json: ctx.json,
    err: ctx.err,
  };
}

async function dispatchExperts(ctx: BuiltinHttpRouteContext, call: RouteHandlerCtx, parts: string[]): Promise<void> {
  const handled = await handleExpertsRoute(
    call.req,
    call.req.method ?? 'GET',
    parts,
    call.url,
    call.res,
    expertsDeps(ctx),
  );
  if (!handled) ctx.err(call.res, 404, 'not found');
}

export function appendExpertsBuiltinRoutes(routeTable: RouteDef[], ctx: BuiltinHttpRouteContext): void {
  if (!ctx.expertStoreFor) return;

  const routes: Array<{ method: RouteDef['method']; pattern: string; parts: string[]; description: string }> = [
    { method: 'GET', pattern: 'api/experts', parts: ['api', 'experts'], description: '专家列表' },
    { method: 'POST', pattern: 'api/experts/import', parts: ['api', 'experts', 'import'], description: '导入专家' },
    { method: 'POST', pattern: 'api/experts/create', parts: ['api', 'experts', 'create'], description: '创建专家' },
    { method: 'GET', pattern: 'api/experts/:id', parts: ['api', 'experts', ':id'], description: '专家详情' },
    { method: 'DELETE', pattern: 'api/experts/:id', parts: ['api', 'experts', ':id'], description: '删除专家' },
    { method: 'GET', pattern: 'api/experts/:id/avatar', parts: ['api', 'experts', ':id', 'avatar'], description: '专家头像' },
    { method: 'GET', pattern: 'api/experts/:id/export', parts: ['api', 'experts', ':id', 'export'], description: '导出专家' },
    { method: 'POST', pattern: 'api/experts/:id/trust', parts: ['api', 'experts', ':id', 'trust'], description: '信任专家' },
    { method: 'DELETE', pattern: 'api/experts/:id/trust', parts: ['api', 'experts', ':id', 'trust'], description: '撤销信任' },
    { method: 'PATCH', pattern: 'api/experts/:id/disabled', parts: ['api', 'experts', ':id', 'disabled'], description: '禁用开关' },
    { method: 'GET', pattern: 'api/sessions/:id/expert', parts: ['api', 'sessions', ':id', 'expert'], description: '会话绑定专家' },
    { method: 'PATCH', pattern: 'api/sessions/:id/expert', parts: ['api', 'sessions', ':id', 'expert'], description: '切换会话专家' },
  ];

  for (const r of routes) {
    routeTable.push({
      method: r.method,
      pattern: r.pattern,
      auth: 'token',
      permission: r.method === 'GET' ? 'read' : 'write',
      description: r.description,
      handler: async (call) => {
        const parts = r.parts.map((seg) => (seg.startsWith(':') ? call.params[seg.slice(1)]! : seg));
        await dispatchExperts(ctx, call, parts);
      },
    });
  }
}
