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
import type { ProviderManager } from '../llm/manager.js';
import { normalizeIncomingImages, ImageError } from '../media/images.js';
import { normalizeRange, usageReportToJson } from '../session/usage.js';

export interface ServeOptions {
  service: SessionService;
  hub: SessionHub;
  port?: number;
  host?: string;
  /** Vue 构建产物目录（存在则托管，SPA fallback index.html） */
  webDistDir?: string;
  /** 设置中心：Provider 管理（F-04a） */
  providers?: ProviderManager;
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
          mode: body.mode ? String(body.mode) : undefined,
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
        // F-18 会话回放：任务列表 + 单次任务时间线
        if (method === 'GET' && parts[3] === 'runs' && parts.length === 4) {
          return json(res, 200, service.getRuns(sessionId));
        }
        if (method === 'GET' && parts[3] === 'runs' && parts[4] !== undefined) {
          const timeline = service.getRunTimeline(sessionId, Number(parts[4]));
          return timeline ? json(res, 200, timeline) : err(res, 404, 'run not found');
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
          void hub.send(sessionId, input, images).catch(() => undefined); // 错误经 run_error 事件推送
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
