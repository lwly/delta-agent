import {
  findMarketEntry,
  installMarketMcp,
  installMarketSkill,
  listMarketSnapshot,
  removeMarketItem,
  wrapMarketPreview,
  type MarketEntry,
} from '../../market/install.js';
import { readMarketSources, validateMarketSources, writeMarketSources } from '../../market/registry.js';
import type { RouteDef } from '../routes.js';
import type { BuiltinHttpRouteContext } from './types.js';
import { projectRoot, resolveConfigHome } from './config-home.js';

export function appendMarketBuiltinRoutes(routeTable: RouteDef[], ctx: BuiltinHttpRouteContext): void {
  const { opts, service, json, err } = ctx;
  const configHome = () => resolveConfigHome(opts);

  routeTable.push(
    {
      method: 'GET',
      pattern: 'api/market',
      auth: 'token',
      permission: 'read',
      description: 'F-52 市场合并快照（内置 + registry 订阅源）',
      handler: async ({ res, url }) => {
        const projectId = url.searchParams.get('projectId');
        const projectRootPath = projectRoot(service, projectId);
        if (projectId && !projectRootPath) return err(res, 404, 'project not found');
        const home = configHome();
        try {
          const snapshot = await listMarketSnapshot({ homeDir: home, ...(projectRootPath ? { projectRoot: projectRootPath } : {}) });
          const items = snapshot.items.map((i) => ({ ...i.entry, source: i.source, installedIn: i.installedIn }));
          return json(res, 200, { ...snapshot, items });
        } catch (e) {
          return err(res, 500, (e as Error).message);
        }
      },
    },
    {
      method: 'GET',
      pattern: 'api/market/item',
      auth: 'token',
      permission: 'read',
      description: '市场单条条目（远程附 untrusted 预览）',
      handler: async ({ res, url }) => {
        const kind = url.searchParams.get('kind');
        if (kind !== 'skill' && kind !== 'mcp') return err(res, 400, 'kind 必须是 skill 或 mcp');
        const source = url.searchParams.get('source') ?? 'builtin';
        const name = url.searchParams.get('name') ?? '';
        if (!name) return err(res, 400, 'name is required');
        const home = configHome();
        try {
          const entry = await findMarketEntry({ homeDir: home }, kind, source, name);
          if (!entry) return err(res, 404, `市场条目不存在：${source}/${name}（订阅源拉取失败或已下架）`);
          const preview = source === 'builtin' ? undefined : wrapMarketPreview(entry, source);
          return json(res, 200, { entry, ...(preview ? { preview } : {}) });
        } catch (e) {
          return err(res, 502, (e as Error).message);
        }
      },
    },
    {
      method: 'POST',
      pattern: 'api/market/install',
      auth: 'token',
      permission: 'write',
      description: '安装 Skill 或 MCP（scripts 未确认可 409）',
      handler: async ({ res, readBody }) => {
        const body = await readBody();
        const kind = body.kind;
        if (kind !== 'skill' && kind !== 'mcp') return err(res, 400, 'kind 必须是 skill 或 mcp');
        const scope = String(body.scope ?? 'user');
        const projectId = body.projectId ? String(body.projectId) : undefined;
        const projectRootPath = projectRoot(service, projectId);
        const home = configHome();
        const layers = { homeDir: home, ...(projectRootPath ? { projectRoot: projectRootPath } : {}) };
        try {
          const entry = await findMarketEntry(
            { homeDir: home, ...(projectRootPath ? { projectRoot: projectRootPath } : {}) },
            kind,
            String(body.source ?? 'builtin'),
            String(body.name ?? '').trim(),
          );
          if (!entry) return err(res, 404, `市场条目不存在：${body.source ?? 'builtin'}/${body.name}（订阅源拉取失败或已下架）`);
          if (kind === 'skill') {
            if (scope !== 'user' && scope !== 'project') return err(res, 400, 'scope 必须是 user 或 project');
            const r = await installMarketSkill(entry as MarketEntry & { kind: 'skill' }, {
              layers,
              scope,
              force: Boolean(body.force),
              confirmScripts: Boolean(body.confirmScripts),
            });
            if (r.status === 'scripts_required') {
              return json(res, 409, { status: r.status, scripts: r.scripts });
            }
            return json(res, 200, { ok: true, name: entry.name, path: r.path, scriptsWritten: r.scriptsWritten ?? [] });
          }
          if (scope !== 'global' && scope !== 'project') return err(res, 400, 'MCP 安装 scope 必须是 global 或 project');
          if (scope === 'project' && !projectRootPath) return err(res, 404, 'project not found');
          const r = await installMarketMcp(entry as MarketEntry & { kind: 'mcp' }, {
            homeDir: home,
            projectRoot: projectRootPath,
            scope,
          });
          if (r.status === 'connect_failed') {
            return err(res, 502, r.error ?? '连通性测试失败');
          }
          return json(res, 200, { ok: true, name: entry.name, path: r.path, toolCount: r.toolCount });
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
      },
    },
    {
      method: 'DELETE',
      pattern: 'api/market/item',
      auth: 'token',
      permission: 'write',
      description: '卸载市场条目（内置 Skill 拒绝）',
      handler: async ({ res, url }) => {
        const kind = url.searchParams.get('kind');
        if (kind !== 'skill' && kind !== 'mcp') return err(res, 400, 'kind 必须是 skill 或 mcp');
        const name = url.searchParams.get('name') ?? '';
        const scope = url.searchParams.get('scope') ?? 'user';
        const projectId = url.searchParams.get('projectId');
        const projectRootPath = projectRoot(service, projectId);
        if (projectId && !projectRootPath) return err(res, 404, 'project not found');
        const home = configHome();
        try {
          if (kind === 'skill' && (url.searchParams.get('source') ?? '') === 'builtin') {
            return err(res, 403, '内置 Skill 不可卸载');
          }
          const r = await removeMarketItem(kind, name, scope as 'user' | 'project' | 'global', {
            homeDir: home,
            ...(projectRootPath ? { projectRoot: projectRootPath } : {}),
          });
          return json(res, 200, { ok: true, ...r });
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
      },
    },
    {
      method: 'GET',
      pattern: 'api/market/sources',
      auth: 'token',
      permission: 'read',
      description: 'registry.json 订阅源',
      handler: async ({ res }) => {
        const { sources, legacy, error } = await readMarketSources(configHome());
        return json(res, 200, { sources, ...(legacy ? { legacy } : {}), ...(error ? { error } : {}) });
      },
    },
    {
      method: 'PUT',
      pattern: 'api/market/sources',
      auth: 'token',
      permission: 'write',
      description: '整体覆盖写入 registry.json',
      handler: async ({ res, readBody }) => {
        const body = await readBody();
        let validated;
        try {
          validated = validateMarketSources(body.sources);
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
        try {
          const file = await writeMarketSources(configHome(), validated);
          return json(res, 200, { ok: true, path: file });
        } catch (e) {
          return err(res, 500, (e as Error).message);
        }
      },
    },
  );
}
