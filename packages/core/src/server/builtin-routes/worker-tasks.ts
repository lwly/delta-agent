import { isExternalModel } from '../../external/registry.js';
import { toWorkerTaskView } from '../../router/store.js';
import { parseDispatchArgs } from '../../tools/builtin/dispatch.js';
import type { WorkerTaskStatus } from '../../router/types.js';
import type { RouteDef } from '../routes.js';
import type { BuiltinHttpRouteContext } from './types.js';

export function appendWorkerTasksBuiltinRoutes(routeTable: RouteDef[], ctx: BuiltinHttpRouteContext): void {
  const { opts, service, hub, json, err } = ctx;
  const findRouterSession = (projectId: string) =>
    service.listSessions(projectId).find((s) => s.kind === 'router');

  routeTable.push(
    {
      method: 'POST',
      pattern: 'api/projects/:id/router',
      auth: 'token',
      permission: 'dispatch',
      description: '取或建 Router 会话（幂等；外部模型当 Router 400）',
      handler: async ({ res, readBody, params }) => {
        if (!opts.dispatcher) return err(res, 501, '调度能力未装配');
        const project = service.getProject(params.id!);
        if (!project) return err(res, 404, 'project not found');
        const existing = findRouterSession(project.id);
        if (existing) return json(res, 200, { session: existing });
        const body = await readBody();
        const model = body.model !== undefined ? String(body.model) : '';
        // §4.4 拦截点 1：外部 agent 不能当 Router（其内置工具 delta 无法收窄）
        if (isExternalModel(model)) {
          return err(res, 400, `Router 会话不允许使用外部模型（${model}）：外部 agent 的工具集无法收窄，不能担任 Router`);
        }
        const s = service.createSession(project.id, { title: body.title ? String(body.title) : 'Router', model });
        // kind 只由服务端写入（裁决 Q1：无任何客户端写入口）
        service.store.setSessionKind(s.id, 'router');
        // §4.1 L-权限层：Router 固定 plan 档（dispatch_task 归 read，不阻断派单）
        hub.setPermissionMode(s.id, 'plan');
        return json(res, 200, { session: service.getSession(s.id) });
      },
    },
    {
      method: 'GET',
      pattern: 'api/projects/:id/worker-tasks',
      auth: 'token',
      permission: 'read',
      description: '任务列表（?status=&limit=；任务台数据源）',
      handler: async ({ res, url, params }) => {
        if (!opts.dispatcher) return err(res, 501, '调度能力未装配');
        if (!service.getProject(params.id!)) return err(res, 404, 'project not found');
        const VALID_STATUSES: ReadonlySet<string> = new Set([
          'draft', 'queued', 'preflight', 'running', 'needs_decision', 'done', 'failed', 'canceled',
        ]);
        const status = url.searchParams.get('status');
        if (status !== null && status !== '' && !VALID_STATUSES.has(status)) {
          return err(res, 400, `非法 status：${status}`);
        }
        const limitRaw = Number(url.searchParams.get('limit'));
        const rows = service.workerTasks.list({
          projectId: params.id!,
          ...(status ? { status: status as WorkerTaskStatus } : {}),
          ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: Math.floor(limitRaw) } : {}),
        });
        return json(res, 200, { tasks: rows.map(toWorkerTaskView) });
      },
    },
    {
      method: 'POST',
      pattern: 'api/projects/:id/worker-tasks',
      auth: 'token',
      permission: 'dispatch',
      description: '手工建任务（body 同 dispatch_task；dispatch:true 落 queued 并立即派发）',
      handler: async ({ res, readBody, params }) => {
        if (!opts.dispatcher) return err(res, 501, '调度能力未装配');
        const dispatcher = opts.dispatcher!;
        const project = service.getProject(params.id!);
        if (!project) return err(res, 404, 'project not found');
        const body = await readBody();
        const parsed = parseDispatchArgs(body);
        if (!parsed.ok) return err(res, 400, parsed.error);
        // 无 Router 也能用：取或建（与 POST /router 同一服务端写入路径）
        let router = findRouterSession(project.id);
        if (!router) {
          const s = service.createSession(project.id, { title: 'Router', model: '' });
          service.store.setSessionKind(s.id, 'router');
          hub.setPermissionMode(s.id, 'plan');
          router = service.getSession(s.id)!;
        }
        const row = service.workerTasks.create({
          ...parsed.value,
          projectId: project.id,
          routerSessionId: router.id,
          status: body.dispatch === true ? 'queued' : 'draft',
        });
        if (body.dispatch === true) void dispatcher.claimSlot().catch(() => {});
        return json(res, 200, { task: toWorkerTaskView(row) });
      },
    },
    {
      method: 'POST',
      pattern: 'api/worker-tasks/:id/decision',
      auth: 'token',
      permission: 'dispatch',
      description: 'needs_decision 人工裁决（retry/cancel/accept；状态机拒绝 409）',
      handler: async ({ res, readBody, params }) => {
        if (!opts.dispatcher) return err(res, 501, '调度能力未装配');
        const dispatcher = opts.dispatcher!;
        const body = await readBody();
        const decision = String(body.decision ?? '');
        if (decision !== 'retry' && decision !== 'cancel' && decision !== 'accept') {
          return err(res, 400, 'decision 必须是 retry / cancel / accept');
        }
        const id = decodeURIComponent(params.id!);
        if (!service.workerTasks.find(id)) return err(res, 404, 'worker task not found');
        try {
          return json(res, 200, { task: toWorkerTaskView(dispatcher.decide(id, decision)) });
        } catch (e) {
          // 非 needs_decision 等状态机拒绝 → 409
          return err(res, 409, (e as Error).message);
        }
      },
    },
    {
      method: 'POST',
      pattern: 'api/worker-tasks/:id/cancel',
      auth: 'token',
      permission: 'dispatch',
      description: '取消任务（queued/running/needs_decision 均可；幂等；preflight 窗口 409）',
      handler: async ({ res, params }) => {
        if (!opts.dispatcher) return err(res, 501, '调度能力未装配');
        const dispatcher = opts.dispatcher!;
        const id = decodeURIComponent(params.id!);
        if (!service.workerTasks.find(id)) return err(res, 404, 'worker task not found');
        try {
          return json(res, 200, { task: toWorkerTaskView(dispatcher.cancel(id)) });
        } catch (e) {
          // preflight 阶段不支持直接取消（窗口极短）→ 409
          return err(res, 409, (e as Error).message);
        }
      },
    },
    {
      method: 'GET',
      pattern: 'api/projects/:id/inbox',
      auth: 'token',
      permission: 'read',
      description: '未送达条目（?delivered=0；Web 红点 + digest 播报同源）',
      handler: async ({ res, url, params }) => {
        if (!opts.dispatcher) return err(res, 501, '调度能力未装配');
        const project = service.getProject(params.id!);
        if (!project) return err(res, 404, 'project not found');
        const delivered = url.searchParams.get('delivered');
        if (delivered !== null && delivered !== '0') {
          return err(res, 400, '仅支持 delivered=0（未送达口径；送达标记由 dispatcher 播报流程写）');
        }
        const router = findRouterSession(project.id);
        return json(res, 200, { items: router ? service.inbox.listUndelivered(router.id) : [] });
      },
    },
  );
}
