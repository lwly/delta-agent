/**
 * delta 本地 Web 服务（technical-design §8/§10）
 * - 纯本地部署：仅监听回环地址；默认端口按形态错开——打包/托管 127.0.0.1:7902，本地开发后端（--dev）7900
 * - REST API：projects / sessions / messages / trash / search / abort / confirm / answer
 * - SSE：GET /api/sessions/:id/events 推送 HubEvent
 * - 静态托管：Vue 构建产物目录（webDistDir），SPA fallback 到 index.html
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChatMessage } from '@delta/shared';
import type { SessionHub } from './hub.js';
import type { SessionService } from '../session/service.js';
import { WebSocketServer } from 'ws';
import type { TerminalManager } from './terminal.js';
import type { CronExecutor } from '../cron/runner.js';
import type { Dispatcher } from '../router/dispatcher.js';
// F-41 运行日志（/api/logs 尾读 + /api/logs/stream 实时推送）
import { appendRoutes, assertRouteDecls, matchRoute, type RouteDef } from './routes.js';
import { appendBuiltinHttpRoutes } from './builtin-routes/register.js';
import type { RunLog } from '../logging/logger.js';
// F-38 文件浏览器 + 变更面板：只读路由（分发见下方 `parts[3] === 'browse'` 分支）
import type { BrowseDeps } from './browse-routes.js';
import { ExpertStore } from '../experts/store.js';
import {
  type DetectedAgent,
  upsertManualEntry,
  removeManualEntry,
  setExternalAgentModel,
  resolveAgentModels,
} from '../external/detect.js';

export interface ServeOptions {
  service: SessionService;
  hub: SessionHub;
  port?: number;
  host?: string;
  /** Vue 构建产物目录（存在则托管，SPA fallback index.html） */
  webDistDir?: string;
  /** 设置中心：Provider 管理（F-04a） */
  providers?: import('../llm/manager.js').ProviderManager;
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
  /**
   * F-41 运行日志（serve 运行时注入）。缺省不提供：
   * GET /api/logs 与 GET /api/logs/stream 返回 404（能力未装配口径，对齐 cronExecutor）。
   */
  runLog?: RunLog;
  /**
   * F-47 Web 内置终端管理器（serve 运行时注入；node-pty optionalDependencies）。
   * 缺省不提供：GET /api/terminal/status 返回 available:false（能力未装配口径），
   * POST /api/sessions/:id/terminal 返回 501，/ws/terminal 升级直接关闭。
   */
  terminal?: TerminalManager;
  /**
   * F-54 会话内后台任务管理器（serve 运行时注入，与 hub deps 共用同一实例）。
   * 缺省不提供：GET/DELETE /api/sessions/:id/background-tasks* 返回 501（能力未装配口径）。
   */
  backgroundTasks?: import('../session/background-tasks.js').BackgroundTaskManager;
  /** 架构收口 T7：统一预算账本（cron「立即运行」与 serve 内置调度的配额判定共用） */
  quota?: import('../quota/store.js').QuotaStore;
  /**
   * F-58 调度器（serve 运行时注入的单例 Dispatcher）。
   * 缺省不提供：6 个调度端点（/api/projects/:id/router|worker-tasks|inbox、
   * /api/worker-tasks/:id/decision|cancel）一律返回 501（能力未装配口径，对齐 background-tasks）。
   */
  dispatcher?: Dispatcher;
  /**
   * F-22 收口（D3 裁决）：GET /api/status 的 cron 调度器状态数据源（serve 运行时注入）。
   * 缺省不提供：/api/status 恒返回 running:false / mode:'off'（能力未装配口径）。
   * 端点命名为 /api/status 而非 /api/cron/status——后者会被 GET /api/cron/:id
   * 当成 id='status' 先匹配而恒 404（架构收口方案 T1 端点命名坑）。
   */
  cronStatus?: () => { running: boolean; mode: 'auto' | 'off' };
  /**
   * 插件路由。与内置表合并后一起做 auth 断言；同 method + pattern 重复则构造期抛错。
   * 处理函数在调用方闭合 service / hub，不从这里取宿主内部对象。
   */
  routes?: RouteDef[];
  /**
   * F-55 外部 Agent 探测入口（缺省 ensureExternalAdapters；测试注入隔离探测副作用——
   * 真探测会跑 `--version` 子进程并写 ~/.delta/external.json，单测不能触碰真实 HOME/PATH）。
   */
  externalDetect?: () => Promise<DetectedAgent[]>;
  externalRegister?: typeof upsertManualEntry;
  externalRemove?: typeof removeManualEntry;
  externalSetModel?: typeof setExternalAgentModel;
  externalModelsProbe?: typeof resolveAgentModels;
  /**
   * 本地 server 鉴权 token（桌面宿主用；CLI serve 缺省不鉴权保持现状）。
   * 配置后所有请求（/api 与静态资源）必须携带 `x-delta-auth` 请求头
   * 或 `?auth=` 查询参数，值恒等才放行，否则 401。
   * 恒定时间比较防时序侧信道。
   */
  authToken?: string;
  /** P6：loadPlugins 快照（GET /api/plugins；缺省返回空列表） */
  pluginsSnapshot?: import('../plugins/loader.js').LoadedPlugin[];
}

/** authToken 恒定时间比较（防时序侧信道；长度差异直接拒绝） */
function tokenMatches(expected: string, got: string): boolean {
  if (expected.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

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


  // P4：内置声明式路由（cron / worker-tasks / sessions / system）
  const routeTable: RouteDef[] = [];
  appendBuiltinHttpRoutes(routeTable, {
    opts,
    service,
    hub,
    json,
    err,
    summarizeToolContent,
    expertStoreFor,
    browseDeps,
    resetExpertStores: () => expertStores.clear(),
  });

  if (opts.routes?.length) appendRoutes(routeTable, opts.routes);
  // 启动断言（判据 2）：漏声明 auth 的路由在 createWebServer 构造期直接抛错
  assertRouteDecls(routeTable, 'http.ts route table');

  const server = http.createServer(async (req, res) => {    const url = new URL(req.url ?? '/', `http://localhost`);
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method ?? 'GET';

    // 鉴权（桌面宿主注入 authToken 时启用；CLI serve 不传保持无鉴权现状）。
    // 只拦 /api/*：静态资源无敏感数据且不带凭据（BrowserWindow 资产请求无法附带 query/header），
    // 敏感面（会话/项目/配置数据）全部在 /api 下。
    if (opts.authToken !== undefined && parts[0] === 'api') {
      const got = req.headers['x-delta-auth'] ?? url.searchParams.get('auth') ?? '';
      if (typeof got !== 'string' || !tokenMatches(opts.authToken, got)) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
    }

    try {
      // ── 架构收口 T8：RouteTable 分发（cron / worker-tasks / sessions 三组试点）──
      // 命中声明式路由 → handler 直接写响应并返回；未命中 → 落入下方既有 if/else 链
      // （渐进迁移；/ws/terminal 的 upgrade 独立路径与本表无关，不受影响）。
      const matchedRoute = matchRoute(routeTable, method, parts);
      if (matchedRoute) {
        await matchedRoute.def.handler({
          req,
          res,
          url,
          params: matchedRoute.params,
          readBody: () => readBody(req),
        });
        return;
      }

      // ── 静态资源（Vue 构建产物，SPA fallback；F-53：优先回预压缩 .gz，AC-53-5）──
      if (opts.webDistDir && (method === 'GET' || method === 'HEAD') && !parts[0]?.startsWith('api')) {
        const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const file = path.resolve(opts.webDistDir, rel);
        if (file.startsWith(path.resolve(opts.webDistDir)) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          const type = MIME[path.extname(file)] ?? 'application/octet-stream';
          const acceptGzip = String(req.headers['accept-encoding'] ?? '').includes('gzip');
          const gzFile = `${file}.gz`;
          if (acceptGzip && fs.existsSync(gzFile) && fs.statSync(gzFile).isFile()) {
            res.writeHead(200, { 'content-type': type, 'content-encoding': 'gzip', vary: 'Accept-Encoding' });
            fs.createReadStream(gzFile).pipe(res);
            return;
          }
          res.writeHead(200, { 'content-type': type, vary: 'Accept-Encoding' });
          fs.createReadStream(file).pipe(res);
          return;
        }
        const index = path.join(opts.webDistDir, 'index.html');
        if (fs.existsSync(index)) {
          const indexGz = `${index}.gz`;
          if (String(req.headers['accept-encoding'] ?? '').includes('gzip') && fs.existsSync(indexGz)) {
            res.writeHead(200, { 'content-type': MIME['.html']!, 'content-encoding': 'gzip', vary: 'Accept-Encoding' });
            fs.createReadStream(indexGz).pipe(res);
            return;
          }
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

  // ── F-47 Web 内置终端：WebSocket 升级（/ws/terminal?tid=&auth=）────────────
  // 鉴权走 query 参数（浏览器 WS 无法附带自定义 header），复用恒定时间比较。
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws/terminal') {
      socket.destroy();
      return;
    }
    if (opts.authToken !== undefined) {
      const got = url.searchParams.get('auth') ?? '';
      if (typeof got !== 'string' || !tokenMatches(opts.authToken, got)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    const tid = url.searchParams.get('tid') ?? '';
    wss.handleUpgrade(req, socket, head, (ws) => {
      const mgr = opts.terminal;
      if (!mgr) {
        ws.close(1011, 'terminal capability not configured');
        return;
      }
      mgr.attach(tid, ws);
      ws.on('message', (raw) => mgr.handleClientMessage(tid, String(raw)));
      ws.on('close', () => mgr.detach(tid, ws));
    });
  });

  return server;
}
