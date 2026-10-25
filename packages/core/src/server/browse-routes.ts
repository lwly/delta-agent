/**
 * F-38 HTTP 只读路由：`/api/{sessions/:sid|projects/:pid}/browse/*`
 *
 * 设计：docs/design-f38-project-file-panel.md（D1 / D3 / §4 / §6 / §8）
 * - 两套作用域共用同一 handler 与同一根解析：
 *   session → resolveWorkRoot(session, project.root_path)（F-37 唯一入口，禁止自行拼 worktree 路径）
 *   project → project.root_path
 * - 5 个端点：GET tree / GET file / GET changes / GET diff / POST reveal
 *   （reveal 只调 OS 文件管理器，不写任何项目文件）
 * - 本文件不持有 `json/err/readBody`：返回 `{ status, body }` 由 http.ts 用既有 json() 写出，
 *   未匹配返回 `null`（http.ts 继续走后续分发）
 * - 错误体只有一种形状 `{ error: '<中文>' }`；业务态失败（非 git / git 超时）仍是 200 + ok:false
 */
import type * as http from 'node:http';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { SessionService } from '../session/service.js';
import { resolveWorkRoot } from '../session/service.js';
import {
  listDir,
  mapFsError,
  normalizeRelPath,
  readFileForPreview,
  resolveInRoot,
  type RootResolveFailure,
} from '../files/browse.js';
import { listWorkspaceChanges, readFileDiff } from '../files/changes.js';

/** 路由依赖注入（测试用 reveal 钩子避免真的弹出文件管理器窗口）。 */
export interface BrowseDeps {
  /** 「在文件管理器中显示」执行器：absPath + 是否目录。缺省 = OS 命令 + unref() */
  reveal?: (absPath: string, isDir: boolean) => void;
}

export interface BrowseRouteInput {
  method: string;
  /** url.pathname.split('/').filter(Boolean) */
  parts: string[];
  url: URL;
  req: http.IncomingMessage;
  service: SessionService;
  browseDeps?: BrowseDeps;
}

/** 路由结果：由 http.ts 用既有 json() 写出。 */
export interface BrowseRouteOutcome {
  status: number;
  body: unknown;
}

// ── 小工具 ─────────────────────────────────────────────────────────────────

/**
 * 读取请求体（与 http.ts 内部 readBody 同实现）。
 * 刻意复制而非 export http.ts 的内部闭包：保持 http.ts 只加一行分发（D4）。
 */
function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      try {
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        resolve(typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/** 根内解析失败 → HTTP 状态码（400 路径边界 / 403 权限 / 404 不存在，§4.6）。 */
function failureOutcome(failure: RootResolveFailure): BrowseRouteOutcome {
  const status = failure.code === 'not_found' ? 404 : failure.code === 'denied' ? 403 : 400;
  return { status, body: { error: failure.message } };
}

/** 缺省 reveal：复用既有 spawn(open|explorer|xdg-open) + unref()（不改项目文件）。 */
function defaultReveal(absPath: string, isDir: boolean): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  // macOS 下对文件用 `open -R` 在 Finder 中定位；目录直接打开
  const args = process.platform === 'darwin' && !isDir ? ['-R', absPath] : [absPath];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined); // 无桌面环境下打开失败不阻塞响应
  child.unref();
}

interface ScopeResolved {
  root: string;
}

/**
 * 作用域 → 工作根（唯一入口）。
 * 返回 outcome 表示作用域解析失败（404），返回 root 表示成功。
 */
async function resolveScope(
  service: SessionService,
  family: string,
  id: string,
): Promise<ScopeResolved | BrowseRouteOutcome> {
  if (family === 'sessions') {
    const session = service.getSession(id);
    if (!session) return { status: 404, body: { error: 'session not found' } };
    const project = service.getProject(session.project_id);
    if (!project) return { status: 404, body: { error: 'project not found' } };
    // F-37 唯一入口：worktree 绑定且目录存活 → worktree，否则项目根
    return { root: resolveWorkRoot(session, project.root_path) };
  }
  const project = service.getProject(id);
  if (!project) return { status: 404, body: { error: 'project not found' } };
  return { root: project.root_path };
}

function isOutcome(v: ScopeResolved | BrowseRouteOutcome): v is BrowseRouteOutcome {
  return 'status' in v;
}

// ── 路由入口 ───────────────────────────────────────────────────────────────

/**
 * 处理 `/{tree,file,changes,diff,reveal}` 五个动作。
 * @returns `null` = 未匹配（http.ts 继续后续分发）；否则 `{ status, body }`
 */
export async function handleBrowseRoute(input: BrowseRouteInput): Promise<BrowseRouteOutcome | null> {
  const { method, parts, url, req, service } = input;
  if (parts[0] !== 'api') return null;
  const family = parts[1];
  if (family !== 'sessions' && family !== 'projects') return null;
  if (parts[3] !== 'browse' || parts.length !== 5) return null;

  const action = parts[4] ?? '';
  const scope = await resolveScope(service, family, parts[2] ?? '');
  if (isOutcome(scope)) return scope;

  const { root } = scope;
  const rootName = path.basename(root);

  switch (action) {
    // GET …/browse/tree?path=<rel>
    case 'tree': {
      if (method !== 'GET') return null;
      const rel = url.searchParams.get('path') ?? '';
      const listing = await listDir(root, rel);
      if (!listing.ok) return failureOutcome(listing);
      return {
        status: 200,
        body: {
          ok: true,
          path: listing.path,
          root_name: rootName,
          entries: listing.entries,
          total: listing.total,
          truncated: listing.truncated,
        },
      };
    }

    // GET …/browse/file?path=<rel>
    case 'file': {
      if (method !== 'GET') return null;
      const rel = url.searchParams.get('path') ?? '';
      const preview = await readFileForPreview(root, rel);
      if (!preview.ok) return failureOutcome(preview);
      return { status: 200, body: preview };
    }

    // GET …/browse/changes
    case 'changes': {
      if (method !== 'GET') return null;
      const result = await listWorkspaceChanges(root);
      // 非 git / 超时同样是 200 业务态（前端走错误态或空态卡片，不弹全局 toast）
      return { status: 200, body: { ...result, root_name: rootName } };
    }

    // GET …/browse/diff?path=<rel>
    case 'diff': {
      if (method !== 'GET') return null;
      const raw = url.searchParams.get('path') ?? '';
      const norm = normalizeRelPath(raw);
      // 只做**语法**校验：已删除文件必须仍可看 diff，不能用 resolveInRoot 的存在性检查拦截
      if (!norm.ok) return { status: 400, body: { error: norm.message } };
      if (norm.rel === '') return { status: 400, body: { error: '缺少 path 参数' } };
      const diff = await readFileDiff(root, norm.rel);
      return { status: 200, body: diff };
    }

    // POST …/browse/reveal  body { path?: string }（省略 = 根）
    case 'reveal': {
      if (method !== 'POST') return null;
      const body = await readBody(req);
      const rel = body.path === undefined || body.path === null ? '' : String(body.path);
      const resolved = await resolveInRoot(root, rel);
      if (!resolved.ok) return failureOutcome(resolved);

      let isDir = true;
      try {
        const stat = await fsp.stat(resolved.abs);
        isDir = stat.isDirectory();
      } catch (e) {
        return failureOutcome(mapFsError(e));
      }
      const reveal = input.browseDeps?.reveal ?? defaultReveal;
      reveal(resolved.abs, isDir);
      return { status: 200, body: { ok: true } };
    }

    default:
      return null;
  }
}
