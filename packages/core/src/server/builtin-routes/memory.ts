import type { RouteDef } from '../routes.js';
import type { BuiltinHttpRouteContext } from './types.js';

export function appendMemoryBuiltinRoutes(routeTable: RouteDef[], ctx: BuiltinHttpRouteContext): void {
  const { service, json, err } = ctx;
  const mem = () => service.memory;

  routeTable.push(
    {
      method: 'GET',
      pattern: 'api/memory',
      auth: 'token',
      permission: 'read',
      description: '记忆列表或召回预览（?q=）',
      handler: async ({ res, url }) => {
        const scope = url.searchParams.get('scope') ?? undefined;
        const kind = url.searchParams.get('kind') ?? undefined;
        const status = url.searchParams.get('status') ?? undefined;
        const q = url.searchParams.get('q');
        if (q) {
          const hits = mem().recall(q, scope ? [scope] : ['global'], 10);
          return json(res, 200, { hits: hits.map((h) => ({ ...h.item, score: h.score })) });
        }
        return json(res, 200, {
          items: mem().list({ scope, kind, status: status as never }),
          usage: scope ? mem().usage(scope) : undefined,
        });
      },
    },
    {
      method: 'GET',
      pattern: 'api/memory/export',
      auth: 'token',
      permission: 'read',
      description: '记忆导出 JSON',
      handler: async ({ res, url }) => json(res, 200, mem().export(url.searchParams.get('scope') ?? undefined)),
    },
    {
      method: 'GET',
      pattern: 'api/memory/trash',
      auth: 'token',
      permission: 'read',
      description: '记忆回收站',
      handler: async ({ res }) => json(res, 200, mem().listTrash()),
    },
    {
      method: 'POST',
      pattern: 'api/memory',
      auth: 'token',
      permission: 'write',
      description: '保存记忆',
      handler: async ({ res, readBody }) => {
        const body = await readBody();
        const content = String(body.content ?? '').trim();
        if (!content) return err(res, 400, 'content is required');
        try {
          const r = mem().save({
            scope: String(body.scope ?? 'global'),
            kind: String(body.kind ?? 'fact'),
            content,
            importance: body.importance === undefined ? undefined : Number(body.importance),
            confidence: body.confidence === undefined ? undefined : Number(body.confidence),
            keywords: body.keywords === undefined ? undefined : String(body.keywords),
            source: 'user',
          });
          return json(res, 200, r);
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
      },
    },
    {
      method: 'POST',
      pattern: 'api/memory/recall',
      auth: 'token',
      permission: 'read',
      description: '记忆召回预览',
      handler: async ({ res, readBody }) => {
        const body = await readBody();
        const query = String(body.query ?? '');
        const scopes = Array.isArray(body.scopes) ? (body.scopes as string[]) : ['global'];
        const hits = mem().recall(query, scopes, Number(body.topK ?? 5));
        return json(res, 200, hits.map((h) => ({ ...h.item, score: h.score })));
      },
    },
    {
      method: 'POST',
      pattern: 'api/memory/:id/approve',
      auth: 'token',
      permission: 'write',
      description: '批准记忆',
      handler: async ({ res, params }) => json(res, 200, { ok: mem().approve(params.id!) }),
    },
    {
      method: 'POST',
      pattern: 'api/memory/:id/reject',
      auth: 'token',
      permission: 'write',
      description: '拒绝记忆',
      handler: async ({ res, params }) => json(res, 200, { ok: mem().reject(params.id!) }),
    },
    {
      method: 'POST',
      pattern: 'api/memory/:id/restore',
      auth: 'token',
      permission: 'write',
      description: '从回收站恢复记忆',
      handler: async ({ res, params }) => json(res, 200, { ok: mem().restore(params.id!) }),
    },
    {
      method: 'PATCH',
      pattern: 'api/memory/:id',
      auth: 'token',
      permission: 'write',
      description: '编辑记忆',
      handler: async ({ res, readBody, params }) => {
        const body = await readBody();
        mem().update(params.id!, {
          content: body.content === undefined ? undefined : String(body.content),
          importance: body.importance === undefined ? undefined : Number(body.importance),
          confidence: body.confidence === undefined ? undefined : Number(body.confidence),
          kind: body.kind === undefined ? undefined : String(body.kind),
          keywords: body.keywords === undefined ? undefined : String(body.keywords),
        });
        return json(res, 200, { ok: true });
      },
    },
    {
      method: 'DELETE',
      pattern: 'api/memory/:id',
      auth: 'token',
      permission: 'write',
      description: '停用/删除记忆',
      handler: async ({ res, url, params }) =>
        json(res, 200, { ok: mem().remove(params.id!, url.searchParams.get('hard') === 'true') }),
    },
  );
}
