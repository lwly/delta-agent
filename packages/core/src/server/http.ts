/**
 * yzero 本地 Web 服务（technical-design §8/§10）
 * - 纯本地部署：默认 127.0.0.1:7900，仅监听回环地址
 * - REST API：projects / sessions / messages / trash / search / abort / confirm / answer
 * - SSE：GET /api/sessions/:id/events 推送 HubEvent
 * - 静态托管：Vue 构建产物目录（webDistDir），SPA fallback 到 index.html
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfirmDecision } from '@y-zero/shared';
import type { SessionHub } from './hub.js';
import type { SessionService } from '../session/service.js';

export interface ServeOptions {
  service: SessionService;
  hub: SessionHub;
  port?: number;
  host?: string;
  /** Vue 构建产物目录（存在则托管，SPA fallback index.html） */
  webDistDir?: string;
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
        res.write(`data: ${JSON.stringify({ type: 'state', running: hub.isRunning(sessionId) })}\n\n`);
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

      // ── projects ──────────────────────────────────────────────────────────
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'projects' && parts.length === 2) {
        return json(res, 200, service.listProjects());
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

      // ── sessions ──────────────────────────────────────────────────────────
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'sessions') {
        const body = await readBody(req);
        const s = service.createSession(parts[2]!, {
          title: body.title ? String(body.title) : undefined,
          model: body.model ? String(body.model) : undefined,
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
        if (method === 'DELETE' && parts.length === 3) {
          try {
            service.removeSession(sessionId, { hard: url.searchParams.get('hard') === 'true' });
            return json(res, 200, { ok: true });
          } catch {
            return err(res, 404, 'session not found');
          }
        }
        // 发起一轮对话：后台运行，事件走 SSE
        if (method === 'POST' && parts[3] === 'messages') {
          const body = await readBody(req);
          const input = String(body.input ?? '');
          if (!input.trim()) return err(res, 400, 'input is required');
          if (hub.isRunning(sessionId)) return err(res, 409, 'session is running');
          void hub.send(sessionId, input).catch(() => undefined); // 错误经 run_error 事件推送
          return json(res, 202, { ok: true, running: true });
        }
        if (method === 'POST' && parts[3] === 'abort') {
          return json(res, 200, { ok: hub.abort(sessionId) });
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
