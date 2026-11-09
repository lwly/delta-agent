import * as path from 'node:path';
import {
  addCronJob,
  cronJobToJson,
  loadCronJobs,
  removeCronJob,
  updateCronJob,
  findCronJob,
} from '../../cron/store.js';
import { runDueCronJobs } from '../../cron/runner.js';
import type { RouteDef } from '../routes.js';
import { parseCronPermissionAndValidity } from './cron-fields.js';
import type { BuiltinHttpRouteContext } from './types.js';

export function appendCronBuiltinRoutes(routeTable: RouteDef[], ctx: BuiltinHttpRouteContext): void {
  const { opts, service, json, err } = ctx;
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
      handler: async ({ res, readBody }) => {
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
      handler: async ({ res, readBody, params }) => {
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
