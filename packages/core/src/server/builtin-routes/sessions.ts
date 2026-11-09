import type { ChatMessage } from '@delta/shared';
import type { SessionKind } from '../../session/store.js';
import { resolveExpertForCreate } from '../experts-routes.js';
import type { RouteDef } from '../routes.js';
import type { BuiltinHttpRouteContext } from './types.js';

/**
 * F-53 消息分页摘要化（AC-53-4）：tool 消息超大输出不随页整体传输，
 * 只下发头部 + 截断标记（contentTruncated/contentLength），全文由客户端按需拉取。
 */
const TOOL_RESULT_INLINE_LIMIT = 4000;
const TOOL_RESULT_INLINE_HEAD = 1200;

function summarizeToolContent(item: { seq: number; message: ChatMessage }): { seq: number; message: ChatMessage } {
  const m = item.message;
  if (m.role !== 'tool' || m.content.length <= TOOL_RESULT_INLINE_LIMIT) return item;
  return {
    seq: item.seq,
    message: {
      ...m,
      content: `${m.content.slice(0, TOOL_RESULT_INLINE_HEAD)}\n…[已摘要化：完整输出共 ${m.content.length} 字符，工具卡内可加载全文]`,
      contentTruncated: true,
      contentLength: m.content.length,
    },
  };
}

/** 项目下会话列表/新建 + 单会话 CRUD / 消息分页 / 权限。 */
export function appendSessionBuiltinRoutes(routeTable: RouteDef[], ctx: BuiltinHttpRouteContext): void {
  const { service, hub, json, err, expertStoreFor } = ctx;

  routeTable.push(
    {
      method: 'POST',
      pattern: 'api/projects/:id/sessions',
      auth: 'token',
      permission: 'write',
      description: '在项目下新建会话（可选 expert / model / mode）',
      handler: async ({ res, readBody, params }) => {
        const body = await readBody();
        const expertName = body.expert ? String(body.expert) : undefined;
        const projectRoot = service.getProject(params.id!)?.root_path;
        const resolved = await resolveExpertForCreate(expertStoreFor!, projectRoot, expertName);
        if (!resolved.ok) return err(res, 400, resolved.message);
        const s = service.createSession(params.id!, {
          title: body.title ? String(body.title) : undefined,
          model: body.model ? String(body.model) : undefined,
          mode: body.mode ? String(body.mode) : undefined,
          ...(expertName ? { expert: expertName, expertType: resolved.expertType } : {}),
        });
        return json(res, 200, s);
      },
    },
    {
      method: 'GET',
      pattern: 'api/projects/:id/sessions',
      auth: 'token',
      permission: 'read',
      description: '项目会话列表或游标分页（?limit=&kind=）',
      handler: async ({ res, url, params }) => {
        const limitParam = url.searchParams.get('limit');
        const kindParam = url.searchParams.get('kind');
        const kinds: SessionKind[] | undefined = kindParam === 'chat' ? ['chat'] : undefined;
        if (limitParam != null) {
          const before = url.searchParams.get('before');
          return json(res, 200, service.listSessionsPage(params.id!, {
            ...(before ? { before } : {}),
            ...(kinds ? { kinds } : {}),
            limit: Number(limitParam) || 50,
          }));
        }
        return json(res, 200, service.listSessions(params.id!, kinds ? { kinds } : {}));
      },
    },
    {
      method: 'GET',
      pattern: 'api/sessions/:id',
      auth: 'token',
      permission: 'read',
      description: '会话详情 + 全量消息历史',
      handler: async ({ res, params }) => {
        const sessionId = params.id!;
        const s = service.getSession(sessionId);
        if (!s) return err(res, 404, 'session not found');
        return json(res, 200, { session: s, messages: service.getHistory(sessionId) });
      },
    },
    {
      method: 'GET',
      pattern: 'api/sessions/:id/meta',
      auth: 'token',
      permission: 'read',
      description: 'F-53：仅会话元信息（首屏历史走 messages 分页端点）',
      handler: async ({ res, params }) => {
        const sessionId = params.id!;
        const s = service.getSession(sessionId);
        if (!s) return err(res, 404, 'session not found');
        return json(res, 200, { session: s });
      },
    },
    {
      method: 'GET',
      pattern: 'api/sessions/:id/messages',
      auth: 'token',
      permission: 'read',
      description: 'F-53 消息历史游标分页（limit/before/after）',
      handler: async ({ res, url, params }) => {
        const sessionId = params.id!;
        if (!service.getSession(sessionId)) return err(res, 404, 'session not found');
        const limitRaw = Number(url.searchParams.get('limit'));
        const beforeRaw = url.searchParams.get('before');
        const afterRaw = url.searchParams.get('after');
        const page = service.getMessagesPage(sessionId, {
          limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50,
          ...(beforeRaw != null ? { before: Number(beforeRaw) } : {}),
          ...(afterRaw != null ? { after: Number(afterRaw) } : {}),
        });
        return json(res, 200, {
          messages: page.items.map(summarizeToolContent),
          has_more: page.has_more,
          next_before: page.next_before,
        });
      },
    },
    {
      method: 'GET',
      pattern: 'api/sessions/:id/messages/:seq/content',
      auth: 'token',
      permission: 'read',
      description: 'F-53 tool_result 大字段懒加载：按 seq 取单条消息全文',
      handler: async ({ res, params }) => {
        const sessionId = params.id!;
        if (!service.getSession(sessionId)) return err(res, 404, 'session not found');
        const seq = Number(params.seq);
        if (!Number.isInteger(seq)) return err(res, 400, 'seq must be an integer');
        try {
          return json(res, 200, service.getMessageBySeq(sessionId, seq));
        } catch (e) {
          return err(res, 404, (e as Error).message);
        }
      },
    },
    {
      method: 'PATCH',
      pattern: 'api/sessions/:id',
      auth: 'token',
      permission: 'write',
      description: '改名 / 切模型（F-56：model 切换下一条消息生效）',
      handler: async ({ res, readBody, params }) => {
        const sessionId = params.id!;
        const body = await readBody();
        try {
          // F-56：title / model 均为可选——model 切换即改会话引擎（下一条消息生效）
          if (body.model !== undefined) service.setSessionModel(sessionId, String(body.model));
          if (body.title !== undefined) service.renameSession(sessionId, String(body.title));
          return json(res, 200, { ok: true });
        } catch (e) {
          return err(res, 404, (e as Error).message);
        }
      },
    },
    {
      method: 'GET',
      pattern: 'api/sessions/:id/permission',
      auth: 'token',
      permission: 'read',
      description: '会话级权限模式读取',
      handler: async ({ res, params }) => {
        return json(res, 200, { mode: hub.getPermissionMode(params.id!) });
      },
    },
    {
      method: 'PATCH',
      pattern: 'api/sessions/:id/permission',
      auth: 'token',
      permission: 'write',
      description: '设置会话权限模式（Router 会话固定 plan，400）',
      handler: async ({ res, readBody, params }) => {
        const sessionId = params.id!;
        // F-58（§4.1 L-权限层，裁决 Q3）：Router 会话固定 plan 档，UI 置灰不可改
        if (service.getSession(sessionId)?.kind === 'router') {
          return err(res, 400, 'Router 会话固定 plan（只读）档，不可修改权限模式');
        }
        const body = await readBody();
        const mode = String(body.mode ?? '');
        if (mode !== 'plan' && mode !== 'default' && mode !== 'yolo') {
          return err(res, 400, `非法权限模式：${mode}（可选 plan / default / yolo）`);
        }
        hub.setPermissionMode(sessionId, mode);
        return json(res, 200, { ok: true, mode });
      },
    },
    {
      method: 'DELETE',
      pattern: 'api/sessions/:id',
      auth: 'token',
      permission: 'write',
      description: '删除会话（执行中 409；?hard=true 物理删除）',
      handler: async ({ res, url, params }) => {
        const sessionId = params.id!;
        // PASI-9：执行中的会话禁止删除（hub.running 覆盖「引擎收尾中」窗口，比 service.activeRuns 更严格）
        if (hub.isRunning(sessionId)) return err(res, 409, '会话执行中，请先暂停或停止后再删除');
        try {
          service.removeSession(sessionId, { hard: url.searchParams.get('hard') === 'true' });
          return json(res, 200, { ok: true });
        } catch (e) {
          const msg = (e as Error).message;
          if (msg.includes('执行中')) return err(res, 409, msg);
          return err(res, 404, 'session not found');
        }
      },
    },
  );
}
