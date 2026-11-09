import type { ConfirmDecision } from '@delta/shared';
import { exportSession, type ExportFormat } from '../../session/export.js';
import { normalizeIncomingImages, ImageError } from '../../media/images.js';
import type { RouteDef } from '../routes.js';
import type { BuiltinHttpRouteContext } from './types.js';

/** 单会话子资源与动作：回放 / 导出 / git / 后台任务 / 发送 / 中止 / 分叉 / 终端 / 确认卡。 */
export function appendSessionDetailBuiltinRoutes(routeTable: RouteDef[], ctx: BuiltinHttpRouteContext): void {
  const { opts, service, hub, json, err } = ctx;

  routeTable.push(
    {
      method: 'GET',
      pattern: 'api/sessions/:id/runs',
      auth: 'token',
      permission: 'read',
      description: 'F-18 会话回放：任务列表',
      handler: async ({ res, params }) => {
        return json(res, 200, service.getRuns(params.id!));
      },
    },
    {
      method: 'GET',
      pattern: 'api/sessions/:id/runs/:seq',
      auth: 'token',
      permission: 'read',
      description: 'F-18 会话回放：单次任务时间线',
      handler: async ({ res, params }) => {
        const timeline = service.getRunTimeline(params.id!, Number(params.seq));
        return timeline ? json(res, 200, timeline) : err(res, 404, 'run not found');
      },
    },
    {
      method: 'GET',
      pattern: 'api/sessions/:id/export',
      auth: 'token',
      permission: 'read',
      description: 'F-49 会话导出（html|md；流式写出，默认脱敏）',
      handler: async ({ res, url, params }) => {
        const sessionId = params.id!;
        const format = url.searchParams.get('format');
        if (format !== 'html' && format !== 'md') return err(res, 400, '非法导出格式：仅支持 html | md');
        if (!service.getSession(sessionId)) return err(res, 404, 'session not found');
        const mime = format === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8';
        res.writeHead(200, {
          'content-type': mime,
          'content-disposition': `attachment; filename="delta-export-${sessionId}.${format}"`,
        });
        try {
          await exportSession(service, sessionId, { format: format as ExportFormat }, (chunk) => res.write(chunk));
        } catch (e) {
          // 头已写出，无法改状态码：截断流并以错误注释收尾
          res.write(format === 'html' ? `<!-- export error: ${(e as Error).message} -->` : `\n\nexport error: ${(e as Error).message}\n`);
        }
        res.end();
      },
    },
    {
      method: 'GET',
      pattern: 'api/sessions/:id/git',
      auth: 'token',
      permission: 'read',
      description: 'F-37 底栏 git 状态（SessionGitState）',
      handler: async ({ res, params }) => {
        const sessionId = params.id!;
        if (!service.getSession(sessionId)) return err(res, 404, 'session not found');
        try {
          return json(res, 200, await hub.worktreeState(sessionId));
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
      },
    },
    {
      method: 'GET',
      pattern: 'api/sessions/:id/branches',
      auth: 'token',
      permission: 'read',
      description: 'F-37 本地分支列表（非 repo / git 失败 → 400）',
      handler: async ({ res, params }) => {
        const sessionId = params.id!;
        if (!service.getSession(sessionId)) return err(res, 404, 'session not found');
        const r = await hub.listBranches(sessionId);
        return r.ok ? json(res, 200, r) : err(res, 400, r.reason);
      },
    },
    {
      method: 'POST',
      pattern: 'api/sessions/:id/checkout',
      auth: 'token',
      permission: 'write',
      description: 'F-37 会话级分支切换（运行中 409；git 失败 200 {ok:false}）',
      handler: async ({ res, readBody, params }) => {
        const sessionId = params.id!;
        const body = await readBody();
        const branch = body.branch ? String(body.branch) : undefined;
        const newBranch = body.newBranch ? String(body.newBranch) : undefined;
        if (!branch && !newBranch) return err(res, 400, 'branch or newBranch is required');
        if (hub.isRunning(sessionId)) return err(res, 409, '会话运行中，请先停止或等待任务结束后再切换分支');
        return json(res, 200, await hub.checkoutBranch(sessionId, { branch, newBranch }));
      },
    },
    {
      method: 'POST',
      pattern: 'api/sessions/:id/worktree',
      auth: 'token',
      permission: 'write',
      description: 'F-37 worktree 开关（运行中 409；失败 200 {ok:false}）',
      handler: async ({ res, readBody, params }) => {
        const sessionId = params.id!;
        const body = await readBody();
        const enabled = body.enabled === true;
        const branch = body.branch ? String(body.branch) : undefined;
        const newBranch = body.newBranch ? String(body.newBranch) : undefined;
        if (hub.isRunning(sessionId)) return err(res, 409, '会话运行中，请先停止或等待任务结束后再切换工作区');
        return json(res, 200, await hub.setWorktree(sessionId, enabled, { branch, newBranch }));
      },
    },
    {
      method: 'GET',
      pattern: 'api/sessions/:id/background-tasks',
      auth: 'token',
      permission: 'read',
      description: 'F-54 会话内后台任务列表（能力未装配 501）',
      handler: async ({ res, params }) => {
        const sessionId = params.id!;
        if (!opts.backgroundTasks) return err(res, 501, '后台任务能力未装配');
        return json(res, 200, opts.backgroundTasks.list(sessionId));
      },
    },
    {
      method: 'DELETE',
      pattern: 'api/sessions/:id/background-tasks/:taskId',
      auth: 'token',
      permission: 'write',
      description: 'F-54 终止后台任务（不存在 / 已结束 404）',
      handler: async ({ res, params }) => {
        const sessionId = params.id!;
        if (!opts.backgroundTasks) return err(res, 501, '后台任务能力未装配');
        const killed = opts.backgroundTasks.kill(sessionId, decodeURIComponent(params.taskId!));
        return killed ? json(res, 200, { ok: true }) : err(res, 404, '任务不存在或已结束');
      },
    },
    {
      method: 'POST',
      pattern: 'api/sessions/:id/messages',
      auth: 'token',
      permission: 'write',
      description: '发起一轮对话（202 后台运行，事件走 SSE；运行中 409）',
      handler: async ({ res, readBody, params }) => {
        const sessionId = params.id!;
        const body = await readBody();
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
      },
    },
    {
      method: 'POST',
      pattern: 'api/sessions/:id/abort',
      auth: 'token',
      permission: 'write',
      description: '中止当前运行',
      handler: async ({ res, params }) => {
        return json(res, 200, { ok: hub.abort(params.id!) });
      },
    },
    {
      method: 'POST',
      pattern: 'api/sessions/:id/pause',
      auth: 'token',
      permission: 'write',
      description: 'PASI-9 暂停会话（中止本轮 + 状态落库 paused；发消息即恢复）',
      handler: async ({ res, params }) => {
        const ok = hub.pause(params.id!);
        return ok ? json(res, 200, { ok: true }) : err(res, 409, '会话未在执行中，无需暂停');
      },
    },
    {
      method: 'POST',
      pattern: 'api/sessions/:id/fork',
      auth: 'token',
      permission: 'write',
      description: 'F-46 会话分叉（copy-on-write 前缀复制；可选 run=true 自动重跑）',
      handler: async ({ res, readBody, params }) => {
        const sessionId = params.id!;
        const body = await readBody();
        const afterIndex = Number(body.after_index);
        if (!Number.isInteger(afterIndex) || afterIndex < 0) return err(res, 400, 'after_index 非法（非负整数）');
        if (hub.isRunning(sessionId)) return err(res, 409, '会话运行中，请先停止再分叉');
        let forked;
        try {
          forked = service.forkSession(sessionId, afterIndex);
        } catch (e) {
          return err(res, 400, (e as Error).message);
        }
        const sourceMessages = service.getHistory(sessionId);
        const content = body.content !== undefined ? String(body.content) : sourceMessages[afterIndex]?.content ?? '';
        if (body.run === false || !content.trim()) {
          return json(res, 200, { ok: true, session_id: forked.id, run: false });
        }
        // 自动重跑：与普通发送同链路；失败经 run_error 事件收尾，不阻塞响应
        void hub.send(forked.id, content).catch((e) => {
          console.error('[hub] fork rerun crashed before run_error publish:', (e as Error).message);
        });
        return json(res, 200, { ok: true, session_id: forked.id, run: true });
      },
    },
    {
      method: 'POST',
      pattern: 'api/sessions/:id/terminal',
      auth: 'token',
      permission: 'write',
      description: 'F-47 创建内嵌终端（pty cwd = 会话工作根；能力未装配 501）',
      handler: async ({ res, params }) => {
        if (!opts.terminal) return err(res, 501, '终端能力未装配（旧版 serve 或 node-pty 缺失）');
        const r = await opts.terminal.create(params.id!);
        return r.ok ? json(res, 200, { ok: true, terminal_id: r.terminalId, work_root: r.workRoot, shell: r.shell }) : json(res, 400, { ok: false, error: r.reason });
      },
    },
    {
      method: 'POST',
      pattern: 'api/sessions/:id/confirm',
      auth: 'token',
      permission: 'write',
      description: 'F-23 确认卡回填（allow/reject/edit）',
      handler: async ({ res, readBody }) => {
        const body = await readBody();
        const ok = hub.confirm(String(body.requestId ?? ''), body.decision as ConfirmDecision);
        return ok ? json(res, 200, { ok: true }) : err(res, 404, 'no pending confirm');
      },
    },
    {
      method: 'POST',
      pattern: 'api/sessions/:id/answer',
      auth: 'token',
      permission: 'write',
      description: '提问回填（ask_user 的 answer）',
      handler: async ({ res, readBody }) => {
        const body = await readBody();
        const ok = hub.answer(String(body.requestId ?? ''), String(body.answer ?? ''));
        return ok ? json(res, 200, { ok: true }) : err(res, 404, 'no pending ask');
      },
    },
    {
      method: 'POST',
      pattern: 'api/sessions/:id/plan',
      auth: 'token',
      permission: 'write',
      description: 'F-14 计划审批回填（approve/reject/edit）',
      handler: async ({ res, readBody }) => {
        const body = await readBody();
        const d = body.decision as { kind?: string; plan?: unknown; reason?: string };
        const decision =
          d?.kind === 'edit'
            ? { kind: 'edit' as const, plan: d.plan as never }
            : d?.kind === 'reject'
              ? { kind: 'reject' as const, reason: d.reason ? String(d.reason) : undefined }
              : { kind: 'approve' as const };
        const ok = hub.planDecision(String(body.requestId ?? ''), decision);
        return ok ? json(res, 200, { ok: true }) : err(res, 404, 'no pending plan approval');
      },
    },
  );
}
