import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { RouteDef } from '../routes.js';
import { collectProjectFiles } from '../project-files.js';
import { collectProjectActivity } from '../project-activity.js';
import type { BuiltinHttpRouteContext } from './types.js';

export function appendProjectBuiltinRoutes(routeTable: RouteDef[], ctx: BuiltinHttpRouteContext): void {
  const { opts, service, json, err } = ctx;
  const activityDeps = {
    service,
    cronHomeDir: opts.cronHomeDir,
    backgroundTasks: opts.backgroundTasks,
  };

  routeTable.push(
    {
      method: 'GET',
      pattern: 'api/projects',
      auth: 'token',
      permission: 'read',
      description: '项目列表（?session_kind=chat 只计 chat 会话）',
      handler: async ({ res, url }) => {
        const chatOnly = url.searchParams.get('session_kind') === 'chat';
        return json(res, 200, service.listProjects(chatOnly ? { chatOnly: true } : {}));
      },
    },
    {
      method: 'POST',
      pattern: 'api/projects',
      auth: 'token',
      permission: 'write',
      description: '注册或复用项目（body.root 必填）',
      handler: async ({ res, readBody }) => {
        const body = await readBody();
        const root = String(body.root ?? '');
        if (!root) return err(res, 400, 'root is required');
        return json(res, 200, service.ensureProject(root));
      },
    },
    {
      method: 'DELETE',
      pattern: 'api/projects/:id',
      auth: 'token',
      permission: 'write',
      description: '删除项目（confirmName + 可选 hard）',
      handler: async ({ res, readBody, params }) => {
        const body = await readBody();
        try {
          service.removeProject(params.id!, String(body.confirmName ?? ''), { hard: body.hard === true });
          return json(res, 200, { ok: true });
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
      },
    },
    {
      method: 'GET',
      pattern: 'api/projects/:id/files',
      auth: 'token',
      permission: 'read',
      description: 'Composer @ 文件引用候选（?q= 前缀过滤）',
      handler: async ({ res, url, params }) => {
        const project = service.getProject(params.id!);
        if (!project) return err(res, 404, 'project not found');
        const files = await collectProjectFiles(project.root_path, url.searchParams.get('q') ?? '');
        return json(res, 200, { files });
      },
    },
    {
      method: 'POST',
      pattern: 'api/projects/:id/rename',
      auth: 'token',
      permission: 'write',
      description: '侧栏重命名（仅显示名）',
      handler: async ({ res, readBody, params }) => {
        const body = await readBody();
        try {
          return json(res, 200, service.renameProject(params.id!, String(body.name ?? '')));
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
      },
    },
    {
      method: 'POST',
      pattern: 'api/projects/:id/reveal',
      auth: 'token',
      permission: 'write',
      description: '在系统文件管理器中打开项目目录',
      handler: async ({ res, params }) => {
        const project = service.getProject(params.id!);
        if (!project) return err(res, 404, 'project not found');
        const dir = project.root_path;
        if (!fs.existsSync(dir)) return err(res, 400, `目录不存在：${dir}`);
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
        const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore' });
        child.on('error', () => undefined);
        child.unref();
        return json(res, 200, { ok: true });
      },
    },
    {
      method: 'GET',
      pattern: 'api/projects/:id/activity',
      auth: 'token',
      permission: 'read',
      description: '项目级 activity 聚合（4 类实体 CanonicalRunStatus）',
      handler: async ({ res, params }) => {
        return json(res, 200, { items: collectProjectActivity(activityDeps, params.id!) });
      },
    },
    {
      method: 'GET',
      pattern: 'api/projects/:id/activity/stream',
      auth: 'token',
      permission: 'read',
      description: 'activity SSE（连入快照 + 500ms 差分推送）',
      handler: async ({ req, res, params }) => {
        const pid = params.id!;
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        let last = JSON.stringify(collectProjectActivity(activityDeps, pid));
        res.write(`data: ${JSON.stringify({ type: 'activity_snapshot', items: JSON.parse(last) })}\n\n`);
        const diffTimer = setInterval(() => {
          try {
            const next = JSON.stringify(collectProjectActivity(activityDeps, pid));
            if (next !== last) {
              last = next;
              res.write(`data: ${JSON.stringify({ type: 'activity_changed', items: JSON.parse(next) })}\n\n`);
            }
          } catch {
            /* 下轮重试 */
          }
        }, 500);
        const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
        req.on('close', () => {
          clearInterval(diffTimer);
          clearInterval(ping);
        });
      },
    },
  );
}
