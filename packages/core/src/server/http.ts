/**
 * delta 本地 Web 服务（technical-design §8/§10）
 * - 纯本地部署：默认 127.0.0.1:7900，仅监听回环地址
 * - REST API：projects / sessions / messages / trash / search / abort / confirm / answer
 * - SSE：GET /api/sessions/:id/events 推送 HubEvent
 * - 静态托管：Vue 构建产物目录（webDistDir），SPA fallback 到 index.html
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { ConfirmDecision } from '@delta/shared';
import type { SessionHub } from './hub.js';
import type { SessionService } from '../session/service.js';
import type { ProviderManager } from '../llm/manager.js';
import { normalizeIncomingImages, ImageError } from '../media/images.js';
import { normalizeRange, usageReportToJson } from '../session/usage.js';
import { discoverSkills } from '../skills/loader.js';
import {
  deleteSkill,
  listLayerSkills,
  readMcpConfigs,
  skillLayerDirs,
  validateConfigName,
  validateMcpServers,
  writeMcpServers,
  writeSkill,
} from './config-store.js';
import {
  addCronJob,
  cronJobToJson,
  loadCronJobs,
  removeCronJob,
  updateCronJob,
  findCronJob,
} from '../cron/store.js';
import { runDueCronJobs, type CronExecutor } from '../cron/runner.js';
// F-38 文件浏览器 + 变更面板：只读路由（分发见下方 `parts[3] === 'browse'` 分支）
import { handleBrowseRoute, type BrowseDeps } from './browse-routes.js';
// F-39 专家库路由（5 端点；分发在静态托管分支之前）
import { handleExpertsRoute, resolveExpertForCreate } from './experts-routes.js';
import { ExpertStore } from '../experts/store.js';
import { BROWSE_IGNORED_DIRS } from '../files/browse.js';
import {
  deriveNameFromUrl,
  findHubEntry,
  importSkillFromUrl,
  listHubSnapshot,
  readHubSources,
  validateHubSources,
  writeHubSources,
} from './skill-hub.js';

export interface ServeOptions {
  service: SessionService;
  hub: SessionHub;
  port?: number;
  host?: string;
  /** Vue 构建产物目录（存在则托管，SPA fallback index.html） */
  webDistDir?: string;
  /** 设置中心：Provider 管理（F-04a） */
  providers?: ProviderManager;
  /**
   * F-22 定时任务：Web 面板「立即运行」用的执行器（CLI serve 传 spawn 执行器）。
   * 缺省 = 不提供手动运行能力（GET/PATCH/DELETE 正常，POST run 返回 400）。
   */
  cronExecutor?: CronExecutor;
  /** F-22：cron.json 存储目录（缺省用户主目录；测试注入临时目录隔离） */
  cronHomeDir?: string;
  /** Composer 自动补全：用户级 skills 扫描目录（缺省 os.homedir()；测试注入临时目录隔离） */
  skillsHomeDir?: string;
  /** Skills/MCP 配置读写根目录（缺省回落 skillsHomeDir 再缺省 os.homedir()；测试注入临时目录隔离） */
  configHomeDir?: string;
  /**
   * F-38：面板「在文件管理器中显示」执行器（缺省 = OS 命令 + unref()）。
   * 测试注入以避免真的弹出系统窗口。
   */
  browseReveal?: (absPath: string, isDir: boolean) => void;
}

/**
 * Composer「@ 文件引用」候选收集（只读、白名单边界内）：
 * - 只返回相对路径；遍历范围锁定在项目根内，不跟随任何符号链接（防目录逃逸）
 * - 跳过构建产物/依赖目录（BROWSE_IGNORED_DIRS，F-38 D5 共享常量）与隐藏目录（. 开头），控制噪声
 * - maxEntries 截断 + 最大深度限制，防止大仓库/深目录拖垮端点
 * 注：点号目录由下方 `name.startsWith('.')` 兜底跳过，因此共享常量不含 .idea/.vscode，行为不变。
 */
const IGNORED_DIRS: ReadonlySet<string> = new Set(BROWSE_IGNORED_DIRS);
const MAX_FILE_CANDIDATES = 500;
const MAX_WALK_DEPTH = 8;

async function collectProjectFiles(root: string, q: string, maxEntries = MAX_FILE_CANDIDATES): Promise<string[]> {
  const out: string[] = [];
  const needle = q.toLowerCase();
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= maxEntries || depth > MAX_WALK_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 无权限/已消失：静默跳过该子树
    }
    for (const e of entries) {
      if (out.length >= maxEntries) return;
      if (e.isSymbolicLink()) continue; // 一律不跟随，防逃逸出项目根
      const rel = path.relative(root, path.join(dir, e.name));
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(path.join(dir, e.name), depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (needle && !rel.toLowerCase().includes(needle)) continue;
      out.push(rel.split(path.sep).join('/'));
    }
  };
  await walk(root, 0);
  return out.sort();
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * F-22b：解析 /api/cron 请求体中的新字段（permission / valid_from / valid_until）。
 * 兼容 camelCase（validFrom / validUntil，存量调用方容错）；PATCH 语义下 null = 清除。
 * 校验失败返回 { ok: false, error }（映射为 400），合法返回规范化后的补丁字段。
 */
type CronFieldsResult =
  | { ok: false; error: string }
  | { ok: true; permission?: 'plan' | 'default' | 'yolo' | null; validFrom?: string | null; validUntil?: string | null };

function parseCronPermissionAndValidity(body: Record<string, unknown>): CronFieldsResult {
  const permission = body.permission;
  if (permission !== undefined && permission !== null) {
    const mode = String(permission);
    if (mode !== 'plan' && mode !== 'default' && mode !== 'yolo') {
      return { ok: false, error: 'permission must be one of: plan / default / yolo' };
    }
  }
  // null 是有意义的清除语义，不能用 ?? 兜底（?? 会把 null 视为空值落到 camelCase 分支）
  const rawFrom = body.valid_from !== undefined ? body.valid_from : body.validFrom;
  const rawUntil = body.valid_until !== undefined ? body.valid_until : body.validUntil;
  for (const v of [rawFrom, rawUntil]) {
    if (v !== undefined && v !== null && (typeof v !== 'string' || Number.isNaN(Date.parse(v)))) {
      return { ok: false, error: 'valid_from / valid_until must be a valid ISO date' };
    }
  }
  if (rawFrom != null && rawUntil != null && Date.parse(rawFrom as string) > Date.parse(rawUntil as string)) {
    return { ok: false, error: 'valid_from must be <= valid_until' };
  }
  return {
    ok: true,
    ...(permission !== undefined
      ? { permission: permission === null ? null : (String(permission) as 'plan' | 'default' | 'yolo') }
      : {}),
    ...(rawFrom !== undefined ? { validFrom: rawFrom === null ? null : String(rawFrom) } : {}),
    ...(rawUntil !== undefined ? { validUntil: rawUntil === null ? null : String(rawUntil) } : {}),
  };
}

export function createWebServer(opts: ServeOptions): http.Server {
  const service = opts.service;
  const hub = opts.hub;
  const json = (res: http.ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const err = (res: http.ServerResponse, code: number, message: string): void =>
    json(res, code, { error: message });

  const readBody = (req: http.IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        try {
          const v = raw ? JSON.parse(raw) : {};
          resolve(typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
        } catch {
          resolve({});
        }
      });
    });

  /**
   * F-38 面板路由依赖：json/err/readBody 是 `createWebServer` 的内部闭包，刻意**不**传给
   * `handleBrowseRoute`（它返回 `{status, body}`，由下方分发用既有 json() 写出）。
   */
  const browseDeps: BrowseDeps = opts.browseReveal ? { reveal: opts.browseReveal } : {};

  // F-39：按项目根缓存的专家库（homeDir 跟随 configHomeDir，测试可注入隔离）
  const expertStores = new Map<string, ExpertStore>();
  const expertStoreFor = (projectRoot: string | undefined): ExpertStore => {
    const key = projectRoot ?? '__global__';
    let store = expertStores.get(key);
    if (!store) {
      store = new ExpertStore({ ...(projectRoot ? { projectRoot } : {}), homeDir: opts.configHomeDir ?? opts.skillsHomeDir ?? os.homedir() });
      expertStores.set(key, store);
    }
    return store;
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method ?? 'GET';

    try {
      // ── SSE 订阅 ──────────────────────────────────────────────────────────
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'events') {
        const sessionId = parts[2]!;
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({ type: 'state', running: hub.isRunning(sessionId), paused: hub.isPaused(sessionId) })}\n\n`);
        const unsub = hub.subscribe(sessionId, (ev) => {
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        });
        const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
        req.on('close', () => {
          clearInterval(ping);
          unsub();
        });
        return;
      }

      // ── F-38 文件浏览器 + 变更面板（只读：tree / file / changes / diff / reveal）──
      // 两套作用域 /api/sessions/:sid/browse/* 与 /api/projects/:pid/browse/*，
      // 根解析在 browse-routes 内统一走 resolveWorkRoot / project.root_path。
      // 必须位于静态托管分支之前：否则 dist 存在的部署形态会先把 /api/... 吞成 SPA fallback。
      if (parts[0] === 'api' && (parts[1] === 'sessions' || parts[1] === 'projects') && parts[3] === 'browse') {
        const out = await handleBrowseRoute({ method, parts, url, req, service, browseDeps });
        if (out) return json(res, out.status, out.body);
      }

      // ── projects ──────────────────────────────────────────────────────────
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'projects' && parts.length === 2) {
        return json(res, 200, service.listProjects());
      }
      // PASI-9：运行中的会话 id 列表（侧栏 ⏸/✕ 切换与删除门禁的数据源）
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'running-sessions' && parts.length === 2) {
        return json(res, 200, { ids: hub.runningSessionIds() });
      }
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'projects' && parts.length === 2) {
        const body = await readBody(req);
        const root = String(body.root ?? '');
        if (!root) return err(res, 400, 'root is required');
        return json(res, 200, service.ensureProject(root));
      }
      if (method === 'DELETE' && parts[0] === 'api' && parts[1] === 'projects' && parts[2]) {
        const body = await readBody(req);
        try {
          service.removeProject(parts[2], String(body.confirmName ?? ''), {
            hard: body.hard === true,
          });
          return json(res, 200, { ok: true });
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
      }
      // GET /api/projects/:id/files?q=<前缀> —— Composer「@ 文件引用」候选（只读）
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'files' && parts.length === 4) {
        const project = service.getProject(parts[2]!);
        if (!project) return err(res, 404, 'project not found');
        const files = await collectProjectFiles(project.root_path, url.searchParams.get('q') ?? '');
        return json(res, 200, { files });
      }

      // POST /api/projects/:id/rename —— 侧栏更多菜单：重命名（仅改显示名）
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'rename' && parts.length === 4) {
        const body = await readBody(req);
        try {
          return json(res, 200, service.renameProject(parts[2]!, String(body.name ?? '')));
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
      }

      // POST /api/projects/:id/reveal —— 侧栏更多菜单：在系统文件管理器中打开项目目录
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'reveal' && parts.length === 4) {
        const project = service.getProject(parts[2]!);
        if (!project) return err(res, 404, 'project not found');
        const dir = project.root_path;
        if (!fs.existsSync(dir)) return err(res, 400, `目录不存在：${dir}`);
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
        const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore' });
        child.on('error', () => undefined); // 打开失败不阻塞响应（如无桌面环境）
        child.unref();
        return json(res, 200, { ok: true });
      }

      // GET /api/skills?projectId=<id> —— Composer「/ 技能」候选（三层发现，只读元数据）
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'skills' && parts.length === 2) {
        const projectId = url.searchParams.get('projectId');
        const projectRoot = projectId ? service.getProject(projectId)?.root_path : undefined;
        try {
          const { skills, errors } = await discoverSkills({
            homeDir: opts.skillsHomeDir ?? os.homedir(),
            ...(projectRoot ? { projectRoot } : {}),
          });
          return json(res, 200, {
            skills: skills.map((s) => ({ name: s.name, description: s.description, layer: s.layer })),
            errors,
          });
        } catch (e) {
          return err(res, 500, (e as Error).message);
        }
      }

      // ── Skills / MCP 配置中心（设置页 Skills / MCP 面板）──────────────────
      // 配置读写根：configHomeDir 优先（测试隔离），回落 skillsHomeDir，再缺省主目录
      const configHome = opts.configHomeDir ?? opts.skillsHomeDir ?? os.homedir();

      // GET /api/skills/detail?projectId=<id> —— 分层原始发现 + 合并视图（含同名覆盖标识）
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'skills' && parts[2] === 'detail' && parts.length === 3) {
        const projectId = url.searchParams.get('projectId');
        const projectRoot = projectId ? service.getProject(projectId)?.root_path : undefined;
        if (projectId && !projectRoot) return err(res, 404, 'project not found');
        const layers = skillLayerDirs({ homeDir: configHome, ...(projectRoot ? { projectRoot } : {}) });
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
            // 遍历顺序 builtin → user → project：高层覆盖低层；覆盖标记挂在胜出视图上
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
      }

      // POST /api/skills/:name —— 新建/覆盖一个用户级或项目级 Skill（内置层拒绝）
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'skills' && parts[2] && parts.length === 3) {
        const body = await readBody(req);
        const scope = String(body.scope ?? '');
        if (scope !== 'user' && scope !== 'project') return err(res, 400, 'scope 必须是 user 或 project');
        const projectId = body.projectId ? String(body.projectId) : undefined;
        const projectRoot = projectId ? service.getProject(projectId)?.root_path : undefined;
        if (scope === 'project' && !projectRoot) return err(res, 404, 'project not found');
        const toList = (v: unknown): string[] =>
          Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
        try {
          const file = await writeSkill(
            parts[2]!,
            scope,
            {
              description: String(body.description ?? ''),
              triggers: toList(body.triggers),
              toolsAllowlist: toList(body.toolsAllowlist),
              body: String(body.body ?? ''),
            },
            { homeDir: configHome, ...(projectRoot ? { projectRoot } : {}) },
          );
          return json(res, 200, { ok: true, path: file });
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
      }

      // DELETE /api/skills/:name?scope=user|project&projectId=<id> —— 删除用户级/项目级 Skill
      if (method === 'DELETE' && parts[0] === 'api' && parts[1] === 'skills' && parts[2] && parts.length === 3) {
        const scope = url.searchParams.get('scope');
        if (scope !== 'user' && scope !== 'project') return err(res, 400, 'scope 必须是 user 或 project');
        const projectId = url.searchParams.get('projectId');
        const projectRoot = projectId ? service.getProject(projectId)?.root_path : undefined;
        if (scope === 'project' && !projectRoot) return err(res, 404, 'project not found');
        try {
          await deleteSkill(parts[2]!, scope, { homeDir: configHome, ...(projectRoot ? { projectRoot } : {}) });
          return json(res, 200, { ok: true });
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
      }

      // ── Skill Hub（技能市场：目录浏览 / 预览 / 一键安装 / 远程源管理）──────
      // GET /api/skill-hub?projectId=<id> —— 合并目录（内置 + 远程源实时拉取）+ installedIn
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'skill-hub' && parts.length === 2) {
        const projectId = url.searchParams.get('projectId');
        const projectRoot = projectId ? service.getProject(projectId)?.root_path : undefined;
        if (projectId && !projectRoot) return err(res, 404, 'project not found');
        try {
          const snapshot = await listHubSnapshot(
            { homeDir: configHome, ...(projectRoot ? { projectRoot } : {}) },
            configHome,
          );
          return json(res, 200, snapshot);
        } catch (e) {
          return err(res, 500, (e as Error).message);
        }
      }

      // GET /api/skill-hub/item?source=builtin|<源名>&name=<名称>&projectId= —— 单条完整 entry（安装前预览）
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'skill-hub' && parts[2] === 'item' && parts.length === 3) {
        const source = url.searchParams.get('source') ?? 'builtin';
        const name = url.searchParams.get('name') ?? '';
        if (!name) return err(res, 400, 'name is required');
        try {
          const entry = await findHubEntry(configHome, source, name);
          return entry ? json(res, 200, entry) : err(res, 404, `条目不存在：${source}/${name}`);
        } catch (e) {
          return err(res, 502, (e as Error).message);
        }
      }

      // POST /api/skill-hub/install —— 安装到用户级/项目级
      // 两种模式：url 模式（导入 SKILL.md raw 原文）与目录模式（source+name 必须从目录取，防绕过校验）
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'skill-hub' && parts[2] === 'install' && parts.length === 3) {
        const body = await readBody(req);
        const scope = String(body.scope ?? '');
        if (scope !== 'user' && scope !== 'project') return err(res, 400, 'scope 必须是 user 或 project');
        const projectId = body.projectId ? String(body.projectId) : undefined;
        const projectRoot = projectId ? service.getProject(projectId)?.root_path : undefined;
        if (scope === 'project' && !projectRoot) return err(res, 404, 'project not found');
        const layers = { homeDir: configHome, ...(projectRoot ? { projectRoot } : {}) };

        try {
          let name: string;
          let skillInput: { description: string; triggers: string[]; toolsAllowlist: string[]; body: string };
          if (typeof body.url === 'string' && body.url.trim() !== '') {
            // url 导入模式：fetch SKILL.md 原文并解析 frontmatter
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
            // 目录模式：source+name 必须能在目录中找到（不接受客户端直接传内容）
            const source = String(body.source ?? 'builtin');
            name = String(body.name ?? '').trim();
            if (!name) return err(res, 400, 'name is required');
            const entry = await findHubEntry(configHome, source, name);
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
      }

      // GET /api/skill-hub/sources —— 读取远程源配置（skill-hub.json）
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'skill-hub' && parts[2] === 'sources' && parts.length === 3) {
        const { sources, error } = await readHubSources(configHome);
        return json(res, 200, { sources, ...(error ? { error } : {}) });
      }

      // PUT /api/skill-hub/sources —— 整体覆盖写入远程源配置（写入前形状校验）
      if (method === 'PUT' && parts[0] === 'api' && parts[1] === 'skill-hub' && parts[2] === 'sources' && parts.length === 3) {
        const body = await readBody(req);
        let validated;
        try {
          validated = validateHubSources(body.sources);
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
        try {
          const file = await writeHubSources(configHome, validated);
          return json(res, 200, { ok: true, path: file });
        } catch (e) {
          return err(res, 500, (e as Error).message);
        }
      }

      // GET /api/mcp?projectId=<id> —— 全局/项目两级 mcp.json 原始内容 + 合并视图
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'mcp' && parts.length === 2) {
        const projectId = url.searchParams.get('projectId');
        const projectRoot = projectId ? service.getProject(projectId)?.root_path : undefined;
        if (projectId && !projectRoot) return err(res, 404, 'project not found');
        const snapshot = await readMcpConfigs({ homeDir: configHome, ...(projectRoot ? { projectRoot } : {}) });
        return json(res, 200, { ...snapshot, projectEnabled: Boolean(projectRoot) });
      }

      // PUT /api/mcp —— 整体写入某作用域的 mcpServers（scope=global|project）
      if (method === 'PUT' && parts[0] === 'api' && parts[1] === 'mcp' && parts.length === 2) {
        const body = await readBody(req);
        const scope = String(body.scope ?? '');
        if (scope !== 'global' && scope !== 'project') return err(res, 400, 'scope 必须是 global 或 project');
        const projectId = body.projectId ? String(body.projectId) : undefined;
        const projectRoot = projectId ? service.getProject(projectId)?.root_path : undefined;
        if (scope === 'project' && !projectRoot) return err(res, 404, 'project not found');
        let servers: ReturnType<typeof validateMcpServers>;
        try {
          servers = validateMcpServers(body.mcpServers);
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
        try {
          const file = await writeMcpServers(scope, servers, {
            homeDir: configHome,
            ...(projectRoot ? { projectRoot } : {}),
          });
          return json(res, 200, { ok: true, path: file });
        } catch (e) {
          return err(res, 500, (e as Error).message);
        }
      }

      // ── F-39 专家库端点（必须在静态托管分支之前，SPA fallback 不吞 API）──
      if (parts[0] === 'api' && (parts[1] === 'experts' || (parts[1] === 'sessions' && parts[3] === 'expert'))) {
        const handled = await handleExpertsRoute(req, method, parts, url, res, {
          service,
          storeFor: expertStoreFor,
          resetStores: () => expertStores.clear(),
          configHome: opts.configHomeDir ?? opts.skillsHomeDir ?? os.homedir(),
          isRunning: (sessionId) => hub.isRunning(sessionId),
          json,
          err,
        });
        if (handled) return;
      }

      // ── sessions ──────────────────────────────────────────────────────────
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'sessions') {
        const body = await readBody(req);
        // F-39：专家绑定（创建时字段；未知 expert → 400 不建会话）
        const expertName = body.expert ? String(body.expert) : undefined;
        const projectRoot = service.getProject(parts[2]!)?.root_path;
        const resolved = await resolveExpertForCreate(expertStoreFor, projectRoot, expertName);
        if (!resolved.ok) return err(res, 400, resolved.message);
        const s = service.createSession(parts[2]!, {
          title: body.title ? String(body.title) : undefined,
          model: body.model ? String(body.model) : undefined,
          mode: body.mode ? String(body.mode) : undefined,
          ...(expertName ? { expert: expertName, expertType: resolved.expertType } : {}),
        });
        return json(res, 200, s);
      }
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'sessions') {
        return json(res, 200, service.listSessions(parts[2]!));
      }
      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2]) {
        const sessionId = parts[2];

        if (method === 'GET' && parts.length === 3) {
          const s = service.getSession(sessionId);
          if (!s) return err(res, 404, 'session not found');
          return json(res, 200, { session: s, messages: service.getHistory(sessionId) });
        }
        if (method === 'PATCH' && parts.length === 3) {
          const body = await readBody(req);
          try {
            service.renameSession(sessionId, String(body.title ?? ''));
            return json(res, 200, { ok: true });
          } catch (e) {
            return err(res, 404, (e as Error).message);
          }
        }
        // 会话级权限模式（plan 只读 / default 询问确认 / yolo 全部放行）
        if (method === 'GET' && parts[3] === 'permission' && parts.length === 4) {
          return json(res, 200, { mode: hub.getPermissionMode(sessionId) });
        }
        if (method === 'PATCH' && parts[3] === 'permission' && parts.length === 4) {
          const body = await readBody(req);
          const mode = String(body.mode ?? '');
          if (mode !== 'plan' && mode !== 'default' && mode !== 'yolo') {
            return err(res, 400, `非法权限模式：${mode}（可选 plan / default / yolo）`);
          }
          hub.setPermissionMode(sessionId, mode);
          return json(res, 200, { ok: true, mode });
        }
        if (method === 'DELETE' && parts.length === 3) {
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
        }
        // F-18 会话回放：任务列表 + 单次任务时间线
        if (method === 'GET' && parts[3] === 'runs' && parts.length === 4) {
          return json(res, 200, service.getRuns(sessionId));
        }
        if (method === 'GET' && parts[3] === 'runs' && parts[4] !== undefined) {
          const timeline = service.getRunTimeline(sessionId, Number(parts[4]));
          return timeline ? json(res, 200, timeline) : err(res, 404, 'run not found');
        }
        // ── F-37 git 分支切换 + worktree 会话级隔离（4 端点，/permission 同级同风格）──
        // GET /api/sessions/:id/git —— 底栏状态（SessionGitState）
        if (method === 'GET' && parts[3] === 'git' && parts.length === 4) {
          if (!service.getSession(sessionId)) return err(res, 404, 'session not found');
          try {
            return json(res, 200, await hub.worktreeState(sessionId));
          } catch (e) {
            return err(res, 400, (e as Error).message);
          }
        }
        // GET /api/sessions/:id/branches —— 本地分支列表（非 repo / git 失败 → 400）
        if (method === 'GET' && parts[3] === 'branches' && parts.length === 4) {
          if (!service.getSession(sessionId)) return err(res, 404, 'session not found');
          const r = await hub.listBranches(sessionId);
          return r.ok ? json(res, 200, r) : err(res, 400, r.reason);
        }
        // POST /api/sessions/:id/checkout —— 会话级分支切换（运行中 409；git 失败 200 {ok:false}）
        if (method === 'POST' && parts[3] === 'checkout' && parts.length === 4) {
          const body = await readBody(req);
          const branch = body.branch ? String(body.branch) : undefined;
          const newBranch = body.newBranch ? String(body.newBranch) : undefined;
          if (!branch && !newBranch) return err(res, 400, 'branch or newBranch is required');
          if (hub.isRunning(sessionId)) return err(res, 409, '会话运行中，请先停止或等待任务结束后再切换分支');
          return json(res, 200, await hub.checkoutBranch(sessionId, { branch, newBranch }));
        }
        // POST /api/sessions/:id/worktree —— worktree 开关（运行中 409；失败 200 {ok:false}）
        if (method === 'POST' && parts[3] === 'worktree' && parts.length === 4) {
          const body = await readBody(req);
          const enabled = body.enabled === true;
          const branch = body.branch ? String(body.branch) : undefined;
          const newBranch = body.newBranch ? String(body.newBranch) : undefined;
          if (hub.isRunning(sessionId)) return err(res, 409, '会话运行中，请先停止或等待任务结束后再切换工作区');
          return json(res, 200, await hub.setWorktree(sessionId, enabled, { branch, newBranch }));
        }
        // 发起一轮对话：后台运行，事件走 SSE
        if (method === 'POST' && parts[3] === 'messages') {
          const body = await readBody(req);
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
        }
        if (method === 'POST' && parts[3] === 'abort') {
          return json(res, 200, { ok: hub.abort(sessionId) });
        }
        // PASI-9：暂停执行中的会话（中止本轮 + 状态落库 paused；发消息即恢复）
        if (method === 'POST' && parts[3] === 'pause') {
          const ok = hub.pause(sessionId);
          return ok ? json(res, 200, { ok: true }) : err(res, 409, '会话未在执行中，无需暂停');
        }
        if (method === 'POST' && parts[3] === 'confirm') {
          const body = await readBody(req);
          const ok = hub.confirm(String(body.requestId ?? ''), body.decision as ConfirmDecision);
          return ok ? json(res, 200, { ok: true }) : err(res, 404, 'no pending confirm');
        }
        if (method === 'POST' && parts[3] === 'answer') {
          const body = await readBody(req);
          const ok = hub.answer(String(body.requestId ?? ''), String(body.answer ?? ''));
          return ok ? json(res, 200, { ok: true }) : err(res, 404, 'no pending ask');
        }
        // F-14 计划审批回填：decision = {kind:'approve'|'reject'} | {kind:'edit', plan}
        if (method === 'POST' && parts[3] === 'plan') {
          const body = await readBody(req);
          const d = body.decision as { kind?: string; plan?: unknown; reason?: string };
          const decision =
            d?.kind === 'edit'
              ? { kind: 'edit' as const, plan: d.plan as never }
              : d?.kind === 'reject'
                ? { kind: 'reject' as const, reason: d.reason ? String(d.reason) : undefined }
                : { kind: 'approve' as const };
          const ok = hub.planDecision(String(body.requestId ?? ''), decision);
          return ok ? json(res, 200, { ok: true }) : err(res, 404, 'no pending plan approval');
        }
      }

      // ── providers（设置中心，F-04a；Key 加密存储、接口不回显）──────────────
      if (parts[0] === 'api' && parts[1] === 'providers' && opts.providers) {
        const mgr = opts.providers;
        const pid = parts[2];
        if (method === 'GET' && !pid) return json(res, 200, mgr.list());
        if (method === 'PUT' && pid) {
          const body = await readBody(req);
          try {
            mgr.add({
              id: pid,
              apiKey: String(body.apiKey ?? ''),
              baseUrl: body.baseUrl ? String(body.baseUrl) : undefined,
              model: body.model ? String(body.model) : undefined,
              setDefault: body.setDefault === true,
            });
            return json(res, 200, { ok: true });
          } catch (e) {
            return err(res, 400, (e as Error).message);
          }
        }
        if (method === 'DELETE' && pid) {
          return json(res, 200, { ok: mgr.remove(pid) });
        }
        if (method === 'POST' && pid && parts[3] === 'default') {
          try {
            mgr.setDefault(pid);
            return json(res, 200, { ok: true });
          } catch (e) {
            return err(res, 400, (e as Error).message);
          }
        }
        if (method === 'POST' && pid && parts[3] === 'enable') {
          const body = await readBody(req);
          mgr.setEnabled(pid, body.enabled === true);
          return json(res, 200, { ok: true });
        }
        if (method === 'POST' && pid && parts[3] === 'move') {
          const body = await readBody(req);
          mgr.move(pid, body.dir === 'down' ? 'down' : 'up');
          return json(res, 200, { ok: true });
        }
        if (method === 'POST' && pid && parts[3] === 'test') {
          const r = await mgr.test(pid);
          return json(res, 200, r);
        }
      }

      // ── memory（记忆里程碑：F-06a 记忆面板 + 工具共用同一存储）───────────────
      if (parts[0] === 'api' && parts[1] === 'memory') {
        const mem = service.memory;
        const id = parts[2];
        // GET /api/memory?scope=&kind=&status=
        if (method === 'GET' && !id) {
          const scope = url.searchParams.get('scope') ?? undefined;
          const kind = url.searchParams.get('kind') ?? undefined;
          const status = url.searchParams.get('status') ?? undefined;
          const q = url.searchParams.get('q');
          if (q) {
            // 召回预览（score 预览，面板展示用；不落访问统计——用临时链路）
            const hits = mem.recall(q, scope ? [scope] : ['global'], 10);
            return json(res, 200, { hits: hits.map((h) => ({ ...h.item, score: h.score })) });
          }
          return json(res, 200, { items: mem.list({ scope, kind, status: status as never }), usage: scope ? mem.usage(scope) : undefined });
        }
        // GET /api/memory/export —— 导出 JSON
        if (method === 'GET' && id === 'export') {
          return json(res, 200, mem.export(url.searchParams.get('scope') ?? undefined));
        }
        // GET /api/memory/trash
        if (method === 'GET' && id === 'trash') {
          return json(res, 200, mem.listTrash());
        }
        // POST /api/memory —— 保存
        if (method === 'POST' && !id) {
          const body = await readBody(req);
          const content = String(body.content ?? '').trim();
          if (!content) return err(res, 400, 'content is required');
          try {
            const r = mem.save({
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
        }
        // POST /api/memory/recall —— 召回预览
        if (method === 'POST' && id === 'recall') {
          const body = await readBody(req);
          const query = String(body.query ?? '');
          const scopes = Array.isArray(body.scopes) ? (body.scopes as string[]) : ['global'];
          const hits = mem.recall(query, scopes, Number(body.topK ?? 5));
          return json(res, 200, hits.map((h) => ({ ...h.item, score: h.score })));
        }
        if (id) {
          // POST /api/memory/:id/approve | reject | restore
          if (method === 'POST' && parts[3]) {
            const action = parts[3];
            if (action === 'approve') return json(res, 200, { ok: mem.approve(id) });
            if (action === 'reject') return json(res, 200, { ok: mem.reject(id) });
            if (action === 'restore') return json(res, 200, { ok: mem.restore(id) });
            return err(res, 404, 'not found');
          }
          // PATCH /api/memory/:id —— 编辑（content/importance/kind…）
          if (method === 'PATCH') {
            const body = await readBody(req);
            mem.update(id, {
              content: body.content === undefined ? undefined : String(body.content),
              importance: body.importance === undefined ? undefined : Number(body.importance),
              confidence: body.confidence === undefined ? undefined : Number(body.confidence),
              kind: body.kind === undefined ? undefined : String(body.kind),
              keywords: body.keywords === undefined ? undefined : String(body.keywords),
            });
            return json(res, 200, { ok: true });
          }
          // DELETE /api/memory/:id?hard=true —— 停用（软删）/彻底清除
          if (method === 'DELETE') {
            return json(res, 200, { ok: mem.remove(id, url.searchParams.get('hard') === 'true') });
          }
        }
      }

      // ── usage（F-31 成本与用量报告：聚合汇总 + 逐会话明细）────────────────
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'usage' && parts.length === 3) {
        // 非法 range 归一化为 all 并在响应中回显实际生效范围
        const range = normalizeRange(url.searchParams.get('range'));
        const project = url.searchParams.get('project') ?? undefined;
        if (parts[2] === 'summary') {
          const report = service.usage.summary({ range, projectId: project });
          return json(res, 200, usageReportToJson(report, project ?? null));
        }
        if (parts[2] === 'sessions') {
          const items = service.usage.bySession({ range, projectId: project });
          return json(res, 200, { range, project: project ?? null, items });
        }
      }

      // ── cron（F-22 定时任务面板：清单/增改删/立即运行；存储与 CLI 共用 ~/.delta/cron.json）──
      if (parts[0] === 'api' && parts[1] === 'cron') {
        const cronHome = opts.cronHomeDir;
        const cronJobs = (): ReturnType<typeof loadCronJobs>['jobs'] => loadCronJobs(cronHome).jobs;
        const id = parts[2];
        // GET /api/cron → 全量清单（含 warnings 供面板提示配置异常；workspaces 供表单工作空间下拉）
        if (method === 'GET' && !id) {
          const { jobs, warnings } = loadCronJobs(cronHome);
          // F-22b 工作空间候选：serve 启动目录优先 + 既有任务 cwd 按首次出现去重（服务端一次算好）
          const workspaces: string[] = [];
          const pushWorkspace = (dir: string): void => {
            const abs = path.resolve(dir);
            if (!workspaces.includes(abs)) workspaces.push(abs);
          };
          pushWorkspace(process.cwd());
          for (const j of jobs) pushWorkspace(j.cwd);
          return json(res, 200, { jobs: jobs.map(cronJobToJson), warnings, workspaces });
        }
        // GET /api/cron/:id → 单任务（运行中轮询用）
        if (method === 'GET' && id) {
          const job = findCronJob(cronJobs(), id);
          return job ? json(res, 200, cronJobToJson(job)) : err(res, 404, 'job not found');
        }
        // POST /api/cron → 新增
        if (method === 'POST' && !id) {
          const body = await readBody(req);
          const name = String(body.name ?? '').trim();
          const cron = String(body.cron ?? '').trim();
          const prompt = String(body.prompt ?? '');
          if (!name || !cron || !prompt.trim()) return err(res, 400, 'name / cron / prompt are required');
          // F-22b 新字段校验（permission 枚举 / ISO 日期 / start<=end），失败 400
          const fields = parseCronPermissionAndValidity(body);
          if (!fields.ok) return err(res, 400, fields.error);
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
              },
              cronHome,
            );
            return json(res, 200, cronJobToJson(job));
          } catch (e) {
            return err(res, 400, (e as Error).message);
          }
        }
        if (id) {
          // PATCH /api/cron/:id → 编辑（enabled / cron / prompt / cwd / name / maxCostUsd / permission / 有效期）
          if (method === 'PATCH') {
            const body = await readBody(req);
            // F-22b 新字段校验；null = 清除（恢复默认权限 / 长期有效）
            const fields = parseCronPermissionAndValidity(body);
            if (!fields.ok) return err(res, 400, fields.error);
            const maxCostRaw = body.max_cost_usd ?? body.maxCostUsd;
            try {
              const job = updateCronJob(
                id,
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
                },
                cronHome,
              );
              return json(res, 200, cronJobToJson(job));
            } catch (e) {
              return err(res, 400, (e as Error).message);
            }
          }
          // DELETE /api/cron/:id → 删除
          if (method === 'DELETE') {
            try {
              removeCronJob(id, cronHome);
              return json(res, 200, { ok: true });
            } catch (e) {
              return err(res, 404, (e as Error).message);
            }
          }
          // POST /api/cron/:id/run → 立即运行一次（无视调度；执行中 202，前端轮询 lastRun）
          if (method === 'POST' && parts[3] === 'run') {
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
            }).catch(() => undefined);
            return json(res, 202, { ok: true, running: true });
          }
        }
      }

      // ── trash / search ───────────────────────────────────────────────────
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'trash' && parts.length === 2) {
        return json(res, 200, service.listTrash());
      }
      // POST /api/trash/restore/:kind/:id
      if (method === 'POST' && parts[1] === 'trash' && parts[2] === 'restore' && parts[3] && parts[4]) {
        try {
          service.restore(parts[3] === 'project' ? 'project' : 'session', parts[4]);
          return json(res, 200, { ok: true });
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
      }
      // DELETE /api/trash/:kind/:id（回收站内彻底清除）
      if (method === 'DELETE' && parts[1] === 'trash' && (parts[2] === 'project' || parts[2] === 'session') && parts[3]) {
        try {
          service.purgeTrash(parts[2] as 'project' | 'session', parts[3]);
          return json(res, 200, { ok: true });
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
      }
      // POST /api/trash/purge-batch —— 批量彻底清除
      // 结构校验（空/非数组/条目缺 kind|id）→ 400；条目不在回收站 → 单条计入 failed
      if (method === 'POST' && parts[1] === 'trash' && parts[2] === 'purge-batch' && parts.length === 3) {
        const body = await readBody(req);
        const items = Array.isArray(body.items) ? body.items : [];
        const isValidItem = (it: unknown): it is { kind: 'project' | 'session'; id: string } =>
          typeof it === 'object' &&
          it !== null &&
          ((it as { kind?: unknown }).kind === 'project' || (it as { kind?: unknown }).kind === 'session') &&
          typeof (it as { id?: unknown }).id === 'string' &&
          (it as { id?: unknown }).id !== '';
        if (items.length === 0 || items.some((it) => !isValidItem(it))) {
          return err(res, 400, 'items must be a non-empty array of { kind: project|session, id: string }');
        }
        const result = service.purgeTrashBatch(items);
        // 单条失败不整体报错：ok 恒为 true，失败明细在 failed 中由前端展示
        return json(res, 200, { ok: true, purged: result.purged, failed: result.failed });
      }
      // F-17 对话检索：全文/语义搜索历史消息（置于 /api/search 之前避免被会话检索截获）
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'search' && parts[2] === 'messages') {
        const q = url.searchParams.get('q') ?? '';
        const mode = url.searchParams.get('mode');
        const limit = url.searchParams.get('limit');
        const hits = await service.searchMessages(q, {
          mode: mode === 'fulltext' || mode === 'semantic' ? mode : 'auto',
          limit: limit ? Number(limit) : undefined,
        });
        return json(res, 200, hits);
      }
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'search') {
        return json(res, 200, service.searchSessions(url.searchParams.get('q') ?? ''));
      }

      // ── 静态资源（Vue 构建产物，SPA fallback）─────────────────────────────
      if (opts.webDistDir && (method === 'GET' || method === 'HEAD') && !parts[0]?.startsWith('api')) {
        const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const file = path.resolve(opts.webDistDir, rel);
        if (file.startsWith(path.resolve(opts.webDistDir)) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
          fs.createReadStream(file).pipe(res);
          return;
        }
        const index = path.join(opts.webDistDir, 'index.html');
        if (fs.existsSync(index)) {
          res.writeHead(200, { 'content-type': MIME['.html']! });
          fs.createReadStream(index).pipe(res);
          return;
        }
      }

      if (parts[0] === 'api') return err(res, 404, 'not found');
      return err(res, 404, 'not found (web dist not built; run packages/web build)');
    } catch (e) {
      return err(res, 500, (e as Error).message);
    }
  });
}
