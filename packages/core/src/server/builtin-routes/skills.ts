import { discoverSkills } from '../../skills/loader.js';
import {
  deleteSkill,
  listLayerSkills,
  skillLayerDirs,
  validateConfigName,
  writeSkill,
} from '../config-store.js';
import {
  deriveNameFromUrl,
  findHubEntry,
  importSkillFromUrl,
  listHubSnapshot,
  readHubSources,
  validateHubSources,
  writeHubSources,
} from '../skill-hub.js';
import type { RouteDef } from '../routes.js';
import type { BuiltinHttpRouteContext } from './types.js';
import { projectRoot, resolveConfigHome } from './config-home.js';

const toList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];

export function appendSkillsBuiltinRoutes(routeTable: RouteDef[], ctx: BuiltinHttpRouteContext): void {
  const { opts, service, json, err } = ctx;
  const configHome = () => resolveConfigHome(opts);
  const skillsHome = () => opts.skillsHomeDir ?? resolveConfigHome(opts);

  routeTable.push(
    {
      method: 'GET',
      pattern: 'api/skills',
      auth: 'token',
      permission: 'read',
      description: 'Composer / 技能候选（三层发现，只读元数据）',
      handler: async ({ res, url }) => {
        const pid = url.searchParams.get('projectId');
        const root = projectRoot(service, pid);
        try {
          const { skills, errors } = await discoverSkills({
            homeDir: skillsHome(),
            ...(root ? { projectRoot: root } : {}),
          });
          return json(res, 200, {
            skills: skills.map((s) => ({ name: s.name, description: s.description, layer: s.layer })),
            errors,
          });
        } catch (e) {
          return err(res, 500, (e as Error).message);
        }
      },
    },
    {
      method: 'GET',
      pattern: 'api/skills/detail',
      auth: 'token',
      permission: 'read',
      description: '分层原始发现 + 合并视图（含同名覆盖标识）',
      handler: async ({ res, url }) => {
        const projectId = url.searchParams.get('projectId');
        const projectRootPath = projectRoot(service, projectId);
        if (projectId && !projectRootPath) return err(res, 404, 'project not found');
        const home = configHome();
        const layers = skillLayerDirs({ homeDir: home, ...(projectRootPath ? { projectRoot: projectRootPath } : {}) });
        const dirs: Array<{ layer: 'builtin' | 'user' | 'project'; dir: string | null }> = [
          { layer: 'builtin', dir: layers.builtin },
          { layer: 'user', dir: layers.user },
          { layer: 'project', dir: layers.project },
        ];
        const errors: string[] = [];
        const perLayer: Record<string, Array<Record<string, unknown>>> = { builtin: [], user: [], project: [] };
        const byName = new Map<string, Record<string, unknown>>();
        const availability = new Map<string, Array<'builtin' | 'user' | 'project'>>();
        for (const { layer, dir } of dirs) {
          if (!dir) continue;
          const { skills, errors: layerErrors } = await listLayerSkills(dir, layer);
          errors.push(...layerErrors);
          for (const s of skills) {
            const view = {
              name: s.name,
              description: s.description,
              triggers: s.triggers,
              toolsAllowlist: s.toolsAllowlist,
              layer: s.layer,
              dir: s.dir,
              references: s.references,
              body: s.body,
            };
            perLayer[layer].push(view);
            const prev = byName.get(s.name);
            if (prev) (view as { shadowing?: string }).shadowing = (prev as { layer: string }).layer;
            byName.set(s.name, view);
            const av = availability.get(s.name) ?? [];
            av.push(layer);
            availability.set(s.name, av);
          }
        }
        return json(res, 200, {
          skills: [...byName.values()],
          layers: perLayer,
          availability: Object.fromEntries(availability),
          errors,
        });
      },
    },
    {
      method: 'POST',
      pattern: 'api/skills/:name',
      auth: 'token',
      permission: 'write',
      description: '新建/覆盖用户级或项目级 Skill（内置层拒绝）',
      handler: async ({ res, readBody, params }) => {
        const body = await readBody();
        const scope = String(body.scope ?? '');
        if (scope !== 'user' && scope !== 'project') return err(res, 400, 'scope 必须是 user 或 project');
        const projectId = body.projectId ? String(body.projectId) : undefined;
        const projectRootPath = projectRoot(service, projectId);
        if (scope === 'project' && !projectRootPath) return err(res, 404, 'project not found');
        const home = configHome();
        try {
          const file = await writeSkill(
            params.name!,
            scope,
            {
              description: String(body.description ?? ''),
              triggers: toList(body.triggers),
              toolsAllowlist: toList(body.toolsAllowlist),
              body: String(body.body ?? ''),
            },
            { homeDir: home, ...(projectRootPath ? { projectRoot: projectRootPath } : {}) },
          );
          return json(res, 200, { ok: true, path: file });
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
      },
    },
    {
      method: 'DELETE',
      pattern: 'api/skills/:name',
      auth: 'token',
      permission: 'write',
      description: '删除用户级/项目级 Skill',
      handler: async ({ res, url, params }) => {
        const scope = url.searchParams.get('scope');
        if (scope !== 'user' && scope !== 'project') return err(res, 400, 'scope 必须是 user 或 project');
        const projectId = url.searchParams.get('projectId');
        const projectRootPath = projectRoot(service, projectId);
        if (scope === 'project' && !projectRootPath) return err(res, 404, 'project not found');
        const home = configHome();
        try {
          await deleteSkill(params.name!, scope, { homeDir: home, ...(projectRootPath ? { projectRoot: projectRootPath } : {}) });
          return json(res, 200, { ok: true });
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
      },
    },
    {
      method: 'GET',
      pattern: 'api/skill-hub',
      auth: 'token',
      permission: 'read',
      description: '技能市场目录（内置 + 远程源）+ installedIn',
      handler: async ({ res, url }) => {
        const projectId = url.searchParams.get('projectId');
        const projectRootPath = projectRoot(service, projectId);
        if (projectId && !projectRootPath) return err(res, 404, 'project not found');
        const home = configHome();
        try {
          const snapshot = await listHubSnapshot(
            { homeDir: home, ...(projectRootPath ? { projectRoot: projectRootPath } : {}) },
            home,
          );
          return json(res, 200, snapshot);
        } catch (e) {
          return err(res, 500, (e as Error).message);
        }
      },
    },
    {
      method: 'GET',
      pattern: 'api/skill-hub/item',
      auth: 'token',
      permission: 'read',
      description: '单条完整 entry（安装前预览）',
      handler: async ({ res, url }) => {
        const source = url.searchParams.get('source') ?? 'builtin';
        const name = url.searchParams.get('name') ?? '';
        if (!name) return err(res, 400, 'name is required');
        const home = configHome();
        try {
          const entry = await findHubEntry(home, source, name);
          return entry ? json(res, 200, entry) : err(res, 404, `条目不存在：${source}/${name}`);
        } catch (e) {
          return err(res, 502, (e as Error).message);
        }
      },
    },
    {
      method: 'POST',
      pattern: 'api/skill-hub/install',
      auth: 'token',
      permission: 'write',
      description: '安装到用户级/项目级（url 或 source+name 目录模式）',
      handler: async ({ res, readBody }) => {
        const body = await readBody();
        const scope = String(body.scope ?? '');
        if (scope !== 'user' && scope !== 'project') return err(res, 400, 'scope 必须是 user 或 project');
        const projectId = body.projectId ? String(body.projectId) : undefined;
        const projectRootPath = projectRoot(service, projectId);
        if (scope === 'project' && !projectRootPath) return err(res, 404, 'project not found');
        const home = configHome();
        const layers = { homeDir: home, ...(projectRootPath ? { projectRoot: projectRootPath } : {}) };
        try {
          let name: string;
          let skillInput: { description: string; triggers: string[]; toolsAllowlist: string[]; body: string };
          if (typeof body.url === 'string' && body.url.trim() !== '') {
            const importUrl = body.url.trim();
            const imported = await importSkillFromUrl(importUrl);
            const derived = body.name ? String(body.name).trim() : deriveNameFromUrl(importUrl) ?? '';
            name = derived;
            const invalid = validateConfigName(name);
            if (invalid) {
              return err(res, 400, `无法确定合法 Skill 名称（${invalid}）；请显式传入 name`);
            }
            skillInput = imported;
          } else {
            const source = String(body.source ?? 'builtin');
            name = String(body.name ?? '').trim();
            if (!name) return err(res, 400, 'name is required');
            const entry = await findHubEntry(home, source, name);
            if (!entry) {
              return err(res, 404, `目录中不存在条目：${source}/${name}（远程源拉取失败或已下架）`);
            }
            name = entry.name;
            skillInput = {
              description: entry.description,
              triggers: entry.triggers,
              toolsAllowlist: entry.toolsAllowlist,
              body: entry.body,
            };
          }
          const file = await writeSkill(name, scope, skillInput, layers);
          return json(res, 200, { ok: true, name, path: file });
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
      },
    },
    {
      method: 'GET',
      pattern: 'api/skill-hub/sources',
      auth: 'token',
      permission: 'read',
      description: '读取远程源配置（skill-hub.json）',
      handler: async ({ res }) => {
        const { sources, error } = await readHubSources(configHome());
        return json(res, 200, { sources, ...(error ? { error } : {}) });
      },
    },
    {
      method: 'PUT',
      pattern: 'api/skill-hub/sources',
      auth: 'token',
      permission: 'write',
      description: '整体覆盖写入远程源配置',
      handler: async ({ res, readBody }) => {
        const body = await readBody();
        let validated;
        try {
          validated = validateHubSources(body.sources);
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
        try {
          const file = await writeHubSources(configHome(), validated);
          return json(res, 200, { ok: true, path: file });
        } catch (e) {
          return err(res, 500, (e as Error).message);
        }
      },
    },
  );
}
