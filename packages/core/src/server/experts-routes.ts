/**
 * F-39 专家库 HTTP 端点（5 个，design §6.9 / T09）
 *
 *   GET  /api/experts?projectId=<id>            列表（列表 DTO，不含 body/头像内容）
 *   GET  /api/experts/:name                     详情（含提示词摘要与工具统计）
 *   GET  /api/experts/:name/avatar              头像 data URL（按需拉取，D13）
 *   GET  /api/sessions/:id/expert               会话绑定状态（含包删除降级判定）
 *   POST /api/projects/:id/sessions             （在 http.ts 内接 expert / expertType）
 *
 * 全部在静态托管分支之前分发（SPA fallback 不会吞掉 API）。
 */
import { promises as fsp } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ExpertStore, toExpertListItem } from '../experts/store.js';
import {
  isTrusted,
  readExpertsConfig,
  recordTrust,
  revokeTrust,
  setDisabled,
  toolsHashOf,
} from '../experts/trust.js';
import { exportExpertToBytes, installExpertFromBytes, scaffoldExpert } from '../experts/io.js';
export type { ExpertStore } from '../experts/store.js';
import { resolveToolAllow, BUILTIN_TOOL_COUNT } from '../experts/policy.js';
import { TOOL_CAPABILITY } from '../tools/permissions.js';
import type { SessionService } from '../session/service.js';

export interface ExpertsRouteDeps {
  service: SessionService;
  /** 按项目根取专家库（http.ts 闭包内缓存） */
  storeFor(projectRoot: string | undefined): ExpertStore;
  /** 结构变更（导入/删除/停用/信任）后清空闭包缓存，下次 list 重建 */
  resetStores(): void;
  /** 用户配置根（~/.delta；experts.json 读写位置） */
  configHome: string;
  /** 会话是否运行中（就地改绑门禁） */
  isRunning(sessionId: string): boolean;
  json(res: ServerResponse, status: number, body: unknown): void;
  err(res: ServerResponse, status: number, message: string): void;
}

/** 是否本模块负责的路由；是则写响应并返回 true */
export async function handleExpertsRoute(
  req: IncomingMessage,
  method: string,
  parts: string[],
  url: URL,
  res: ServerResponse,
  deps: ExpertsRouteDeps,
): Promise<boolean> {
  const { service, storeFor, resetStores, configHome, json, err } = deps;

  // GET /api/experts?projectId=<id>
  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'experts' && parts.length === 2) {
    const projectId = url.searchParams.get('projectId');
    const projectRoot = projectId ? service.getProject(projectId)?.root_path : undefined;
    if (projectId && !projectRoot) {
      err(res, 404, 'project not found');
      return true;
    }
    const cfg = await readExpertsConfig(configHome);
    const { experts, errors } = await storeFor(projectRoot).list();
    json(res, 200, {
      experts: experts.map((e) => ({ ...toExpertListItem(e), trusted: isTrusted(cfg, e) })),
      errors,
      disabled: cfg.disabled,
    });
    return true;
  }

  // GET /api/experts/:name
  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'experts' && parts[2] && parts.length === 3) {
    const record = await storeFor(undefined).get(parts[2]!);
    if (!record) {
      err(res, 404, 'expert not found');
      return true;
    }
    const allow = resolveToolAllow(
      record.tools,
      Object.keys(TOOL_CAPABILITY),
    );
    json(res, 200, {
      name: record.name,
      version: record.version,
      description: record.description,
      author: record.author,
      expertType: record.expertType,
      displayName: record.displayName,
      profession: record.profession,
      layer: record.layer,
      skills: record.skills,
      tools: record.tools,
      tool_stats: {
        restricted: allow.restrictedCount,
        total: BUILTIN_TOOL_COUNT,
        unrestricted: record.tools === null,
      },
      tools_hash: toolsHashOf(record),
      keywords: record.keywords,
      categoryId: record.categoryId,
      dependencies: record.dependencies,
      members: record.members.map((m) => ({
        id: m.id,
        name: m.displayName,
        profession: m.profession,
        role: m.role,
        avatar: m.avatarPath !== null,
        skills: m.skills,
      })),
      prompt_preview: record.agent.body.slice(0, 400),
      prompt_stats: record.promptStats,
      hasAvatar: record.avatarPath !== null,
    });
    return true;
  }

  // GET /api/experts/:name/avatar
  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'experts' && parts[3] === 'avatar' && parts.length === 4) {
    const record = await storeFor(undefined).get(parts[2]!);
    if (!record) {
      err(res, 404, 'expert not found');
      return true;
    }
    if (!record.avatarPath) {
      json(res, 200, { data_url: null });
      return true;
    }
    try {
      const buf = await fsp.readFile(record.avatarPath);
      const ext = record.avatarPath.slice(record.avatarPath.lastIndexOf('.') + 1).toLowerCase();
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      json(res, 200, { data_url: `data:${mime};base64,${buf.toString('base64')}` });
    } catch {
      json(res, 200, { data_url: null });
    }
    return true;
  }

  // ── P1（T15/T16）：信任 / 停用 / 删除 / 导入 / 导出 / 创建 ─────────────

  // POST /api/experts/:name/trust —— 记录信任（服务端重算 hash 复核，不信任前端传值）
  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'experts' && parts[3] === 'trust' && parts.length === 4) {
    const record = await storeFor(undefined).get(parts[2]!);
    if (!record) {
      err(res, 404, 'expert not found');
      return true;
    }
    if (record.layer === 'builtin') {
      err(res, 400, '内置专家无需信任确认');
      return true;
    }
    const body = await new Promise<string>((resolve) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => resolve(raw));
    });
    let bodyHash = '';
    try {
      bodyHash = String((JSON.parse(body || '{}') as { tools_hash?: string }).tools_hash ?? '');
    } catch {
      err(res, 400, '请求体不是合法 JSON');
      return true;
    }
    if (bodyHash !== toolsHashOf(record)) {
      err(res, 400, `tools_hash 不匹配（期望 ${toolsHashOf(record)}，收到 ${bodyHash}）：包内容可能已变化，请刷新后重试`);
      return true;
    }
    await recordTrust(configHome, record);
    resetStores();
    json(res, 200, { ok: true, name: record.name, tools_hash: toolsHashOf(record) });
    return true;
  }

  // DELETE /api/experts/:name/trust —— 撤销信任（下次召唤重新确认）
  if (method === 'DELETE' && parts[0] === 'api' && parts[1] === 'experts' && parts[3] === 'trust' && parts.length === 4) {
    await revokeTrust(configHome, parts[2]!);
    resetStores();
    json(res, 200, { ok: true });
    return true;
  }

  // PATCH /api/experts/:name/disabled —— 停用 / 恢复（停用后不出现在召唤面板）
  if (method === 'PATCH' && parts[0] === 'api' && parts[1] === 'experts' && parts[3] === 'disabled' && parts.length === 4) {
    const record = await storeFor(undefined).get(parts[2]!);
    if (!record) {
      err(res, 404, 'expert not found');
      return true;
    }
    if (record.layer === 'builtin') {
      err(res, 400, '内置专家不可停用');
      return true;
    }
    const body = await new Promise<string>((resolve) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => resolve(raw));
    });
    let disabled = false;
    try {
      disabled = Boolean((JSON.parse(body || '{}') as { disabled?: boolean }).disabled);
    } catch {
      err(res, 400, '请求体不是合法 JSON');
      return true;
    }
    await setDisabled(configHome, record.name, disabled);
    resetStores();
    json(res, 200, { ok: true, name: record.name, disabled });
    return true;
  }

  // DELETE /api/experts/:name?layer=user|project —— 删除包（内置层拒绝）
  if (method === 'DELETE' && parts[0] === 'api' && parts[1] === 'experts' && parts[2] && parts.length === 3) {
    const record = await storeFor(undefined).get(parts[2]!);
    if (!record) {
      err(res, 404, 'expert not found');
      return true;
    }
    if (record.layer === 'builtin') {
      err(res, 400, '内置专家不可删除');
      return true;
    }
    await fsp.rm(record.dir, { recursive: true, force: true });
    resetStores();
    json(res, 200, { ok: true, name: record.name });
    return true;
  }

  // POST /api/experts/import —— {layer, force?, b64}（zip 字节 base64）
  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'experts' && parts[2] === 'import' && parts.length === 3) {
    const body = await new Promise<string>((resolve) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => resolve(raw));
    });
    let parsed: { layer?: string; force?: boolean; b64?: string } = {};
    try {
      parsed = JSON.parse(body || '{}') as typeof parsed;
    } catch {
      err(res, 400, '请求体不是合法 JSON');
      return true;
    }
    const layer = parsed.layer === 'project' ? 'project' : 'user';
    if (!parsed.b64) {
      err(res, 400, '缺少 b64（zip 的 base64 内容）');
      return true;
    }
    try {
      const bytes = Uint8Array.from(Buffer.from(parsed.b64, 'base64'));
      const result = await installExpertFromBytes(bytes, {
        layer,
        force: Boolean(parsed.force),
        homeDir: configHome,
      });
      resetStores();
      json(res, 200, { ok: true, ...result });
    } catch (e) {
      err(res, 400, (e as Error).message);
    }
    return true;
  }

  // POST /api/experts/create —— 创建骨架
  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'experts' && parts[2] === 'create' && parts.length === 3) {
    const body = await new Promise<string>((resolve) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => resolve(raw));
    });
    let form: { name?: string; displayName?: string; profession?: string; description?: string; expertType?: string; layer?: string } = {};
    try {
      form = JSON.parse(body || '{}') as typeof form;
    } catch {
      err(res, 400, '请求体不是合法 JSON');
      return true;
    }
    if (!form.name || !form.displayName || !form.profession) {
      err(res, 400, 'name / displayName / profession 必填');
      return true;
    }
    const expertType = form.expertType === 'team' ? 'team' : 'agent';
    const layer = form.layer === 'project' ? 'project' : 'user';
    try {
      const r = await scaffoldExpert({
        name: form.name,
        displayName: form.displayName,
        profession: form.profession,
        description: form.description,
        expertType,
        layer,
        homeDir: configHome,
      });
      resetStores();
      json(res, 200, { ok: true, name: form.name, dir: r.dir });
    } catch (e) {
      err(res, 400, (e as Error).message);
    }
    return true;
  }

  // GET /api/experts/:name/export —— zip 下载（Content-Disposition）
  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'experts' && parts[3] === 'export' && parts.length === 4) {
    try {
      const r = await exportExpertToBytes(parts[2]!, { homeDir: configHome });
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${r.fileName}"`,
      });
      res.end(Buffer.from(r.bytes));
    } catch (e) {
      err(res, 400, (e as Error).message);
    }
    return true;
  }

  // PATCH /api/sessions/:id/expert —— 空会话就地改绑/解绑（F-39-16①）
  // 门禁：会话存在 + 未运行 + 无任何消息；否则 409（P0 语义 = 新建会话，这里只服务空会话）
  if (method === 'PATCH' && parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'expert' && parts.length === 4) {
    const session = service.getSession(parts[2]!);
    if (!session) {
      err(res, 404, 'session not found');
      return true;
    }
    if (deps.isRunning(parts[2]!)) {
      err(res, 409, '会话运行中，停止后可切换专家');
      return true;
    }
    if (service.getHistory(parts[2]!).length > 0) {
      err(res, 409, '会话已有消息，专家绑定在会话创建时确定（请新建对话）');
      return true;
    }
    const body = await new Promise<string>((resolve) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => resolve(raw));
    });
    let expert: string | null = null;
    try {
      expert = (JSON.parse(body || '{}') as { expert?: string | null }).expert ?? null;
    } catch {
      err(res, 400, '请求体不是合法 JSON');
      return true;
    }
    if (expert) {
      const record = await storeFor(service.getProject(session.project_id)?.root_path).get(expert);
      if (!record) {
        err(res, 400, `expert not found: ${expert}`);
        return true;
      }
      service.setSessionExpert(session.id, { expert: record.name, expertType: record.expertType });
    } else {
      service.setSessionExpert(session.id, { expert: null, expertType: null });
    }
    json(res, 200, { ok: true, expert, expertType: expert ? (await storeFor(service.getProject(session.project_id)?.root_path).get(expert))?.expertType ?? null : null });
    return true;
  }

  // GET /api/sessions/:id/expert —— 绑定状态 + 降级判定（唯一权威来源，D14）
  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'expert' && parts.length === 4) {
    const session = service.getSession(parts[2]!);
    if (!session) {
      err(res, 404, 'session not found');
      return true;
    }
    if (!session.expert) {
      json(res, 200, { bound: null, missing: false, mode_forced: false });
      return true;
    }
    const store = storeFor(service.getProject(session.project_id)?.root_path);
    const record = await store.get(session.expert);
    if (!record) {
      json(res, 200, {
        bound: { name: session.expert, expertType: session.expert_type },
        missing: true,
        mode_forced: session.expert_type === 'team',
      });
      return true;
    }
    json(res, 200, {
      bound: {
        name: record.name,
        displayName: record.displayName,
        profession: record.profession,
        expertType: record.expertType,
        layer: record.layer,
        hasAvatar: record.avatarPath !== null,
      },
      missing: false,
      mode_forced: session.expert_type === 'team',
    });
    return true;
  }

  return false;
}

/** 供 http.ts 创建会话前校验 expert 存在（未知 → 400） */
export async function resolveExpertForCreate(
  storeFor: (root: string | undefined) => ExpertStore,
  projectRoot: string | undefined,
  expert: string | undefined,
): Promise<{ ok: true; expertType: 'agent' | 'team' | null } | { ok: false; message: string }> {
  if (!expert) return { ok: true, expertType: null };
  const record = await storeFor(projectRoot).get(expert);
  if (!record) return { ok: false, message: `expert not found: ${expert}` };
  return { ok: true, expertType: record.expertType };
}

/** 列出全部可选专家名（CLI `--expert not-exist` 报错用） */
export async function listExpertNames(store: ExpertStore): Promise<string[]> {
  return (await store.list()).experts.map((e) => e.name);
}
