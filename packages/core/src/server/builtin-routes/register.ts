/**
 * P4 内置 HTTP 路由表（cron / worker-tasks / sessions / system）。
 * createWebServer 闭包注入后登记；未命中仍落 http.ts if/else。
 */
import * as path from 'node:path';
import type { ConfirmDecision } from '@delta/shared';
import { exportSession, type ExportFormat } from '../../session/export.js';
import {
  addCronJob,
  cronJobToJson,
  loadCronJobs,
  removeCronJob,
  updateCronJob,
  findCronJob,
} from '../../cron/store.js';
import { runDueCronJobs } from '../../cron/runner.js';
import { isExternalModel } from '../../external/registry.js';
import { toWorkerTaskView } from '../../router/store.js';
import { parseDispatchArgs } from '../../tools/builtin/dispatch.js';
import type { WorkerTaskStatus } from '../../router/types.js';
import type { SessionKind } from '../../session/store.js';
import { normalizeIncomingImages, ImageError } from '../../media/images.js';
import type { RouteDef } from '../routes.js';
import { viewContributionMetas } from '../../plugins/view-meta.js';
import { parseCronPermissionAndValidity } from './cron-fields.js';
import { appendProjectBuiltinRoutes } from './projects.js';
import { appendSkillsBuiltinRoutes } from './skills.js';
import { appendMarketBuiltinRoutes } from './market.js';
import { appendMcpBuiltinRoutes } from './mcp.js';
import { appendLogsBuiltinRoutes } from './logs.js';
import { appendProvidersBuiltinRoutes } from './providers.js';
import { appendModelsRoutingBuiltinRoutes } from './models-routing.js';
import { appendSessionStreamBuiltinRoutes } from './sessions-stream.js';
import { appendBrowseBuiltinRoutes } from './browse.js';
import { appendExpertsBuiltinRoutes } from './experts.js';
import { appendTerminalBuiltinRoutes } from './terminal.js';
import { appendExternalAgentsBuiltinRoutes } from './external-agents.js';
import { appendMemoryBuiltinRoutes } from './memory.js';
import { appendUsageBuiltinRoutes } from './usage.js';
import { appendSettingsBudgetBuiltinRoutes } from './settings-budget.js';
import { appendTrashBuiltinRoutes } from './trash.js';
import { appendSearchBuiltinRoutes } from './search.js';
import { resolveExpertForCreate } from '../experts-routes.js';
import type { BuiltinHttpRouteContext } from './types.js';

export { BUILTIN_HTTP_ROUTE_GROUPS, type BuiltinHttpRouteContext } from './types.js';

export function appendBuiltinHttpRoutes(routeTable: RouteDef[], ctx: BuiltinHttpRouteContext): void {
  const { opts, service, hub, json, err, summarizeToolContent } = ctx;

  // ── ① cron 组（F-22 定时任务面板；存储与 CLI 共用 ~/.delta/cron.json）────────
  {
    const cronHome = opts.cronHomeDir;
    // T6：项目根引用（旧文件任务按 cwd 前缀惰性回填 projectId，仅内存；编辑时才落盘）
    const projectRoots = (): Array<{ id: string; root: string }> =>
      service.listProjects().map((p) => ({ id: p.id, root: p.root_path }));
    const cronJobs = (): ReturnType<typeof loadCronJobs>['jobs'] =>
      loadCronJobs(cronHome, { projectRoots: projectRoots() }).jobs;

    routeTable.push(
      {
        method: 'GET',
        pattern: 'api/cron',
        auth: 'token',
        permission: 'read',
        description: '定时任务清单（T6 支持 ?project_id= 后端过滤）+ warnings + workspaces 候选',
        handler: async ({ res, url }) => {
          const { jobs, warnings } = loadCronJobs(cronHome, { projectRoots: projectRoots() });
          const projectIdFilter = url.searchParams.get('project_id');
          const scoped = projectIdFilter ? jobs.filter((j) => j.projectId === projectIdFilter) : jobs;
          // F-22b 工作空间候选：serve 启动目录优先 + 既有任务 cwd 按首次出现去重（服务端一次算好）
          const workspaces: string[] = [];
          const pushWorkspace = (dir: string): void => {
            const abs = path.resolve(dir);
            if (!workspaces.includes(abs)) workspaces.push(abs);
          };
          pushWorkspace(process.cwd());
          for (const j of jobs) pushWorkspace(j.cwd);
          return json(res, 200, { jobs: scoped.map(cronJobToJson), warnings, workspaces });
        },
      },
      {
        method: 'GET',
        pattern: 'api/cron/:id',
        auth: 'token',
        permission: 'read',
        description: '单任务（运行中轮询用）',
        handler: async ({ res, params }) => {
          const job = findCronJob(cronJobs(), params.id!);
          return job ? json(res, 200, cronJobToJson(job)) : err(res, 404, 'job not found');
        },
      },
      {
        method: 'POST',
        pattern: 'api/cron',
        auth: 'token',
        permission: 'write',
        description: '新增定时任务（name/cron/prompt 必填；F-22b 新字段校验；T6 project_id 校验）',
        handler: async ({ res, req, readBody }) => {
          const body = await readBody();
          const name = String(body.name ?? '').trim();
          const cron = String(body.cron ?? '').trim();
          const prompt = String(body.prompt ?? '');
          if (!name || !cron || !prompt.trim()) return err(res, 400, 'name / cron / prompt are required');
          // F-22b 新字段校验（permission 枚举 / ISO 日期 / start<=end），失败 400
          const fields = parseCronPermissionAndValidity(body);
          if (!fields.ok) return err(res, 400, fields.error);
          // T6（D4 裁决）：project_id 可不传 = 全局任务（桌面端无 cwd 概念）；传了必须存在于 projects 表
          let projectId: string | undefined;
          if (body.project_id != null && body.project_id !== '') {
            const pid = String(body.project_id);
            if (!service.getProject(pid)) return err(res, 400, `project not found: ${pid}`);
            projectId = pid;
          }
          // 既有口径修复：Web 端发送 snake_case max_cost_usd，服务端双读兼容 camelCase
          const maxCostRaw = body.max_cost_usd ?? body.maxCostUsd;
          try {
            const job = addCronJob(
              {
                name,
                cron,
                prompt,
                cwd: String(body.cwd ?? process.cwd()),
                enabled: body.enabled === false ? false : true,
                ...(maxCostRaw !== undefined && Number(maxCostRaw) > 0 ? { maxCostUsd: Number(maxCostRaw) } : {}),
                // F-22b：POST 中 null 视为未提供（缺省 = default / 长期有效）
                ...(fields.permission ? { permission: fields.permission } : {}),
                ...(fields.validFrom ? { validFrom: fields.validFrom } : {}),
                ...(fields.validUntil ? { validUntil: fields.validUntil } : {}),
                ...(projectId ? { projectId } : {}),
              },
              cronHome,
            );
            return json(res, 200, cronJobToJson(job));
          } catch (e) {
            return err(res, 400, (e as Error).message);
          }
        },
      },
      {
        method: 'PATCH',
        pattern: 'api/cron/:id',
        auth: 'token',
        permission: 'write',
        description: '编辑定时任务（enabled/cron/prompt/cwd/name/maxCostUsd/permission/有效期/project_id）',
        handler: async ({ res, req, readBody, params }) => {
          const body = await readBody();
          // F-22b 新字段校验；null = 清除（恢复默认权限 / 长期有效）
          const fields = parseCronPermissionAndValidity(body);
          if (!fields.ok) return err(res, 400, fields.error);
          const maxCostRaw = body.max_cost_usd ?? body.maxCostUsd;
          // T6：project_id 校验（null = 清除恢复全局任务；undefined = 不动——
          // 旧文件任务经 loadCronJobs 惰性回填的归属随本次编辑一并落盘）
          let projectIdPatch: string | null | undefined;
          if (body.project_id !== undefined) {
            if (body.project_id === null || body.project_id === '') {
              projectIdPatch = null;
            } else {
              const pid = String(body.project_id);
              if (!service.getProject(pid)) return err(res, 400, `project not found: ${pid}`);
              projectIdPatch = pid;
            }
          }
          try {
            const job = updateCronJob(
              params.id!,
              {
                ...(body.enabled !== undefined ? { enabled: body.enabled === true } : {}),
                ...(body.cron !== undefined ? { cron: String(body.cron) } : {}),
                ...(body.prompt !== undefined ? { prompt: String(body.prompt) } : {}),
                ...(body.cwd !== undefined ? { cwd: String(body.cwd) } : {}),
                ...(body.name !== undefined ? { name: String(body.name) } : {}),
                ...(maxCostRaw !== undefined ? { maxCostUsd: Number(maxCostRaw) } : {}),
                ...(fields.permission !== undefined ? { permission: fields.permission } : {}),
                ...(fields.validFrom !== undefined ? { validFrom: fields.validFrom } : {}),
                ...(fields.validUntil !== undefined ? { validUntil: fields.validUntil } : {}),
                ...(projectIdPatch !== undefined ? { projectId: projectIdPatch } : {}),
              },
              cronHome,
              { projectRoots: projectRoots() },
            );
            return json(res, 200, cronJobToJson(job));
          } catch (e) {
            return err(res, 400, (e as Error).message);
          }
        },
      },
      {
        method: 'DELETE',
        pattern: 'api/cron/:id',
        auth: 'token',
        permission: 'write',
        description: '删除定时任务',
        handler: async ({ res, params }) => {
          try {
            removeCronJob(params.id!, cronHome);
            return json(res, 200, { ok: true });
          } catch (e) {
            return err(res, 404, (e as Error).message);
          }
        },
      },
      {
        method: 'POST',
        pattern: 'api/cron/:id/run',
        auth: 'token',
        permission: 'write',
        description: '立即运行一次（202 后台执行；未配执行器 400 / 运行中 409）',
        handler: async ({ res, params }) => {
          const id = params.id!;
          if (!opts.cronExecutor) return err(res, 400, 'cron executor not configured');
          const job = findCronJob(cronJobs(), id);
          if (!job) return err(res, 404, 'job not found');
          if (job.runningSince) return err(res, 409, 'job is running');
          // 后台执行：锁由 runner 写入/清除，前端轮询 GET /api/cron/:id 观察
          void runDueCronJobs({
            executor: opts.cronExecutor,
            onlyJobId: job.id,
            trigger: 'manual',
            homeDir: cronHome,
            projectRoots: projectRoots(), // T6：立即运行同样按 cwd 回填归属（运行记录/日志带 project_id）
            // T7：立即运行同样过 cron 配额账本（与内置调度同一判定实现）
            ...(opts.quota ? { quota: opts.quota } : {}),
            // F-41：调度过程行（到期/跳过/结果）落运行日志（Web 日志页可见）；
            // T6：ctx.projectId → LogEntry.projectId（项目作用域下可见 cron 调度行）
            ...(opts.runLog
              ? { logger: (line: string, ctx?: { projectId?: string }) => opts.runLog!.append('info', 'cron', line, undefined, ctx?.projectId) }
              : {}),
          }).catch(() => undefined);
          return json(res, 202, { ok: true, running: true });
        },
      },
    );
  }

  // ── ② worker-tasks 组（F-58 调度端点；dispatcher 未装配一律 501）──────────────
  {
    const findRouterSession = (projectId: string) =>
      service.listSessions(projectId).find((s) => s.kind === 'router');

    routeTable.push(
      {
        method: 'POST',
        pattern: 'api/projects/:id/router',
        auth: 'token',
        permission: 'dispatch',
        description: '取或建 Router 会话（幂等；外部模型当 Router 400）',
        handler: async ({ res, req, readBody, params }) => {
          if (!opts.dispatcher) return err(res, 501, '调度能力未装配');
          const dispatcher = opts.dispatcher!;
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
        handler: async ({ res, req, readBody, params }) => {
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
        handler: async ({ res, req, readBody, params }) => {
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

  // ── ③ projects 组（CRUD / files / activity / 项目级会话列表）────────────────
  appendProjectBuiltinRoutes(routeTable, ctx);

  // ── skills / market / mcp 组（设置页 Skills·MCP·市场面板）──────────────────
  appendSkillsBuiltinRoutes(routeTable, ctx);
  appendMarketBuiltinRoutes(routeTable, ctx);
  appendMcpBuiltinRoutes(routeTable, ctx);
  appendLogsBuiltinRoutes(routeTable, ctx);
  appendProvidersBuiltinRoutes(routeTable, ctx);
  appendModelsRoutingBuiltinRoutes(routeTable, ctx);

  // ── ④ sessions 组（单会话端点 + 项目下会话列表）──────────────────────────────
  {
    const { expertStoreFor } = ctx;
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
    );
    routeTable.push(
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
        handler: async ({ res, req, readBody, params }) => {
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
        handler: async ({ res, req, readBody, params }) => {
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
      {
        method: 'GET',
        pattern: 'api/sessions/:id/runs',
        auth: 'token',
        permission: 'read',
        description: 'F-18 会话回放：任务列表',
        handler: async ({ res, params }) => {
          return json(res, 200, service.getRuns(params.id!));
        },
      },
      {
        method: 'GET',
        pattern: 'api/sessions/:id/runs/:seq',
        auth: 'token',
        permission: 'read',
        description: 'F-18 会话回放：单次任务时间线',
        handler: async ({ res, params }) => {
          const timeline = service.getRunTimeline(params.id!, Number(params.seq));
          return timeline ? json(res, 200, timeline) : err(res, 404, 'run not found');
        },
      },
      {
        method: 'GET',
        pattern: 'api/sessions/:id/export',
        auth: 'token',
        permission: 'read',
        description: 'F-49 会话导出（html|md；流式写出，默认脱敏）',
        handler: async ({ res, url, params }) => {
          const sessionId = params.id!;
          const format = url.searchParams.get('format');
          if (format !== 'html' && format !== 'md') return err(res, 400, '非法导出格式：仅支持 html | md');
          if (!service.getSession(sessionId)) return err(res, 404, 'session not found');
          const mime = format === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8';
          res.writeHead(200, {
            'content-type': mime,
            'content-disposition': `attachment; filename="delta-export-${sessionId}.${format}"`,
          });
          try {
            await exportSession(service, sessionId, { format: format as ExportFormat }, (chunk) => res.write(chunk));
          } catch (e) {
            // 头已写出，无法改状态码：截断流并以错误注释收尾
            res.write(format === 'html' ? `<!-- export error: ${(e as Error).message} -->` : `\n\nexport error: ${(e as Error).message}\n`);
          }
          res.end();
        },
      },
      {
        method: 'GET',
        pattern: 'api/sessions/:id/git',
        auth: 'token',
        permission: 'read',
        description: 'F-37 底栏 git 状态（SessionGitState）',
        handler: async ({ res, params }) => {
          const sessionId = params.id!;
          if (!service.getSession(sessionId)) return err(res, 404, 'session not found');
          try {
            return json(res, 200, await hub.worktreeState(sessionId));
          } catch (e) {
            return err(res, 400, (e as Error).message);
          }
        },
      },
      {
        method: 'GET',
        pattern: 'api/sessions/:id/branches',
        auth: 'token',
        permission: 'read',
        description: 'F-37 本地分支列表（非 repo / git 失败 → 400）',
        handler: async ({ res, params }) => {
          const sessionId = params.id!;
          if (!service.getSession(sessionId)) return err(res, 404, 'session not found');
          const r = await hub.listBranches(sessionId);
          return r.ok ? json(res, 200, r) : err(res, 400, r.reason);
        },
      },
      {
        method: 'POST',
        pattern: 'api/sessions/:id/checkout',
        auth: 'token',
        permission: 'write',
        description: 'F-37 会话级分支切换（运行中 409；git 失败 200 {ok:false}）',
        handler: async ({ res, req, readBody, params }) => {
          const sessionId = params.id!;
          const body = await readBody();
          const branch = body.branch ? String(body.branch) : undefined;
          const newBranch = body.newBranch ? String(body.newBranch) : undefined;
          if (!branch && !newBranch) return err(res, 400, 'branch or newBranch is required');
          if (hub.isRunning(sessionId)) return err(res, 409, '会话运行中，请先停止或等待任务结束后再切换分支');
          return json(res, 200, await hub.checkoutBranch(sessionId, { branch, newBranch }));
        },
      },
      {
        method: 'POST',
        pattern: 'api/sessions/:id/worktree',
        auth: 'token',
        permission: 'write',
        description: 'F-37 worktree 开关（运行中 409；失败 200 {ok:false}）',
        handler: async ({ res, req, readBody, params }) => {
          const sessionId = params.id!;
          const body = await readBody();
          const enabled = body.enabled === true;
          const branch = body.branch ? String(body.branch) : undefined;
          const newBranch = body.newBranch ? String(body.newBranch) : undefined;
          if (hub.isRunning(sessionId)) return err(res, 409, '会话运行中，请先停止或等待任务结束后再切换工作区');
          return json(res, 200, await hub.setWorktree(sessionId, enabled, { branch, newBranch }));
        },
      },
      {
        method: 'GET',
        pattern: 'api/sessions/:id/background-tasks',
        auth: 'token',
        permission: 'read',
        description: 'F-54 会话内后台任务列表（能力未装配 501）',
        handler: async ({ res, params }) => {
          const sessionId = params.id!;
          if (!opts.backgroundTasks) return err(res, 501, '后台任务能力未装配');
          return json(res, 200, opts.backgroundTasks.list(sessionId));
        },
      },
      {
        method: 'DELETE',
        pattern: 'api/sessions/:id/background-tasks/:taskId',
        auth: 'token',
        permission: 'write',
        description: 'F-54 终止后台任务（不存在 / 已结束 404）',
        handler: async ({ res, params }) => {
          const sessionId = params.id!;
          if (!opts.backgroundTasks) return err(res, 501, '后台任务能力未装配');
          const killed = opts.backgroundTasks.kill(sessionId, decodeURIComponent(params.taskId!));
          return killed ? json(res, 200, { ok: true }) : err(res, 404, '任务不存在或已结束');
        },
      },
      {
        method: 'POST',
        pattern: 'api/sessions/:id/messages',
        auth: 'token',
        permission: 'write',
        description: '发起一轮对话（202 后台运行，事件走 SSE；运行中 409）',
        handler: async ({ res, req, readBody, params }) => {
          const sessionId = params.id!;
          const body = await readBody();
          const input = String(body.input ?? '');
          if (!input.trim() && !Array.isArray(body.images)) return err(res, 400, 'input is required');
          if (hub.isRunning(sessionId)) return err(res, 409, 'session is running');
          // F-25 多模态：可选图片附件（base64，服务端校验格式/大小/数量）
          let images;
          try {
            images = normalizeIncomingImages(body.images);
          } catch (e) {
            if (e instanceof ImageError) return err(res, 400, e.message);
            throw e;
          }
          void hub.send(sessionId, input, images).catch((e) => {
            // run 前置失败（session/project 校验等）：日志留痕，前端经 state running:false 收尾
            console.error('[hub] send crashed before run_error publish:', (e as Error).message);
          });
          return json(res, 202, { ok: true, running: true });
        },
      },
      {
        method: 'POST',
        pattern: 'api/sessions/:id/abort',
        auth: 'token',
        permission: 'write',
        description: '中止当前运行',
        handler: async ({ res, params }) => {
          return json(res, 200, { ok: hub.abort(params.id!) });
        },
      },
      {
        method: 'POST',
        pattern: 'api/sessions/:id/pause',
        auth: 'token',
        permission: 'write',
        description: 'PASI-9 暂停会话（中止本轮 + 状态落库 paused；发消息即恢复）',
        handler: async ({ res, params }) => {
          const ok = hub.pause(params.id!);
          return ok ? json(res, 200, { ok: true }) : err(res, 409, '会话未在执行中，无需暂停');
        },
      },
      {
        method: 'POST',
        pattern: 'api/sessions/:id/fork',
        auth: 'token',
        permission: 'write',
        description: 'F-46 会话分叉（copy-on-write 前缀复制；可选 run=true 自动重跑）',
        handler: async ({ res, req, readBody, params }) => {
          const sessionId = params.id!;
          const body = await readBody();
          const afterIndex = Number(body.after_index);
          if (!Number.isInteger(afterIndex) || afterIndex < 0) return err(res, 400, 'after_index 非法（非负整数）');
          if (hub.isRunning(sessionId)) return err(res, 409, '会话运行中，请先停止再分叉');
          let forked;
          try {
            forked = service.forkSession(sessionId, afterIndex);
          } catch (e) {
            return err(res, 400, (e as Error).message);
          }
          const sourceMessages = service.getHistory(sessionId);
          const content = body.content !== undefined ? String(body.content) : sourceMessages[afterIndex]?.content ?? '';
          if (body.run === false || !content.trim()) {
            return json(res, 200, { ok: true, session_id: forked.id, run: false });
          }
          // 自动重跑：与普通发送同链路；失败经 run_error 事件收尾，不阻塞响应
          void hub.send(forked.id, content).catch((e) => {
            console.error('[hub] fork rerun crashed before run_error publish:', (e as Error).message);
          });
          return json(res, 200, { ok: true, session_id: forked.id, run: true });
        },
      },
      {
        method: 'POST',
        pattern: 'api/sessions/:id/terminal',
        auth: 'token',
        permission: 'write',
        description: 'F-47 创建内嵌终端（pty cwd = 会话工作根；能力未装配 501）',
        handler: async ({ res, params }) => {
          if (!opts.terminal) return err(res, 501, '终端能力未装配（旧版 serve 或 node-pty 缺失）');
          const r = await opts.terminal.create(params.id!);
          return r.ok ? json(res, 200, { ok: true, terminal_id: r.terminalId, work_root: r.workRoot, shell: r.shell }) : json(res, 400, { ok: false, error: r.reason });
        },
      },
      {
        method: 'POST',
        pattern: 'api/sessions/:id/confirm',
        auth: 'token',
        permission: 'write',
        description: 'F-23 确认卡回填（allow/reject/edit）',
        handler: async ({ res, req, readBody, params }) => {
          const body = await readBody();
          const ok = hub.confirm(String(body.requestId ?? ''), body.decision as ConfirmDecision);
          return ok ? json(res, 200, { ok: true }) : err(res, 404, 'no pending confirm');
        },
      },
      {
        method: 'POST',
        pattern: 'api/sessions/:id/answer',
        auth: 'token',
        permission: 'write',
        description: '提问回填（ask_user 的 answer）',
        handler: async ({ res, req, readBody, params }) => {
          const body = await readBody();
          const ok = hub.answer(String(body.requestId ?? ''), String(body.answer ?? ''));
          return ok ? json(res, 200, { ok: true }) : err(res, 404, 'no pending ask');
        },
      },
      {
        method: 'POST',
        pattern: 'api/sessions/:id/plan',
        auth: 'token',
        permission: 'write',
        description: 'F-14 计划审批回填（approve/reject/edit）',
        handler: async ({ res, req, readBody, params }) => {
          const body = await readBody();
          const d = body.decision as { kind?: string; plan?: unknown; reason?: string };
          const decision =
            d?.kind === 'edit'
              ? { kind: 'edit' as const, plan: d.plan as never }
              : d?.kind === 'reject'
                ? { kind: 'reject' as const, reason: d.reason ? String(d.reason) : undefined }
                : { kind: 'approve' as const };
          const ok = hub.planDecision(String(body.requestId ?? ''), decision);
          return ok ? json(res, 200, { ok: true }) : err(res, 404, 'no pending plan approval');
        },
      },
    );
  }

  appendSessionStreamBuiltinRoutes(routeTable, ctx);
  appendBrowseBuiltinRoutes(routeTable, ctx);
  appendExpertsBuiltinRoutes(routeTable, ctx);
  appendTerminalBuiltinRoutes(routeTable, ctx);
  appendExternalAgentsBuiltinRoutes(routeTable, ctx);
  appendMemoryBuiltinRoutes(routeTable, ctx);
  appendUsageBuiltinRoutes(routeTable, ctx);
  appendSettingsBudgetBuiltinRoutes(routeTable, ctx);
  appendTrashBuiltinRoutes(routeTable, ctx);
  appendSearchBuiltinRoutes(routeTable, ctx);

  // ── ⑤ system 组（P4：全局只读端点，避免落 api/cron/:id 通配）──
  routeTable.push(
    {
      method: 'GET',
      pattern: 'api/status',
      auth: 'token',
      permission: 'read',
      description: 'F-22 调度器状态（D3 裁决；不可 /api/cron/status）',
      handler: async ({ res }) => {
        const st = opts.cronStatus?.() ?? { running: false, mode: 'off' as const };
        return json(res, 200, { cron: st });
      },
    },
    {
      method: 'GET',
      pattern: 'api/running-sessions',
      auth: 'token',
      permission: 'read',
      description: 'PASI-9 运行中会话 / 项目 id 列表',
      handler: async ({ res }) => json(res, 200, { ids: hub.runningSessionIds(), projects: hub.runningProjectIds() }),
    },
    {
      method: 'GET',
      pattern: 'api/tools',
      auth: 'token',
      permission: 'read',
      description: 'Web 设置页工具清单（内置 + MCP）',
      handler: async ({ res }) => json(res, 200, { items: hub.toolInventory() }),
    },
    {
      method: 'GET',
      pattern: 'api/plugins',
      auth: 'token',
      permission: 'read',
      description: 'P6 用户插件发现 + 视图元数据',
      handler: async ({ res }) =>
        json(res, 200, {
          plugins: opts.pluginsSnapshot ?? [],
          views: viewContributionMetas().map((v) => ({ name: v.name, path: v.path, slot: v.slot, module: v.module })),
        }),
    },
  );
}

