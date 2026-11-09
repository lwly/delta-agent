import { readMcpConfigs, validateMcpServers, writeMcpServers } from '../config-store.js';
import type { RouteDef } from '../routes.js';
import type { BuiltinHttpRouteContext } from './types.js';
import { projectRoot, resolveConfigHome } from './config-home.js';

export function appendMcpBuiltinRoutes(routeTable: RouteDef[], ctx: BuiltinHttpRouteContext): void {
  const { opts, service, json, err } = ctx;
  const configHome = () => resolveConfigHome(opts);

  routeTable.push(
    {
      method: 'GET',
      pattern: 'api/mcp',
      auth: 'token',
      permission: 'read',
      description: '全局/项目两级 mcp.json 原始内容 + 合并视图',
      handler: async ({ res, url }) => {
        const projectId = url.searchParams.get('projectId');
        const projectRootPath = projectRoot(service, projectId);
        if (projectId && !projectRootPath) return err(res, 404, 'project not found');
        const home = configHome();
        const snapshot = await readMcpConfigs({ homeDir: home, ...(projectRootPath ? { projectRoot: projectRootPath } : {}) });
        return json(res, 200, { ...snapshot, projectEnabled: Boolean(projectRootPath) });
      },
    },
    {
      method: 'PUT',
      pattern: 'api/mcp',
      auth: 'token',
      permission: 'write',
      description: '整体写入某作用域 mcpServers（scope=global|project）',
      handler: async ({ res, readBody }) => {
        const body = await readBody();
        const scope = String(body.scope ?? '');
        if (scope !== 'global' && scope !== 'project') return err(res, 400, 'scope 必须是 global 或 project');
        const projectId = body.projectId ? String(body.projectId) : undefined;
        const projectRootPath = projectRoot(service, projectId);
        if (scope === 'project' && !projectRootPath) return err(res, 404, 'project not found');
        const home = configHome();
        let servers: ReturnType<typeof validateMcpServers>;
        try {
          servers = validateMcpServers(body.mcpServers);
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
        try {
          const file = await writeMcpServers(scope, servers, {
            homeDir: home,
            ...(projectRootPath ? { projectRoot: projectRootPath } : {}),
          });
          return json(res, 200, { ok: true, path: file });
        } catch (e) {
          return err(res, 500, (e as Error).message);
        }
      },
    },
  );
}
