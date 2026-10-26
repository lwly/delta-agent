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
import { ExpertStore, toExpertListItem } from '../experts/store.js';
export type { ExpertStore } from '../experts/store.js';
import { resolveToolAllow, BUILTIN_TOOL_COUNT } from '../experts/policy.js';
import { TOOL_CAPABILITY } from '../tools/permissions.js';
import type { SessionService } from '../session/service.js';

export interface ExpertsRouteDeps {
  service: SessionService;
  /** 按项目根取专家库（http.ts 闭包内缓存） */
  storeFor(projectRoot: string | undefined): ExpertStore;
  json(res: import('node:http').ServerResponse, status: number, body: unknown): void;
  err(res: import('node:http').ServerResponse, status: number, message: string): void;
}

/** 是否本模块负责的路由；是则写响应并返回 true */
export async function handleExpertsRoute(
  method: string,
  parts: string[],
  url: URL,
  res: import('node:http').ServerResponse,
  deps: ExpertsRouteDeps,
): Promise<boolean> {
  const { service, storeFor, json, err } = deps;

  // GET /api/experts?projectId=<id>
  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'experts' && parts.length === 2) {
    const projectId = url.searchParams.get('projectId');
    const projectRoot = projectId ? service.getProject(projectId)?.root_path : undefined;
    if (projectId && !projectRoot) {
      err(res, 404, 'project not found');
      return true;
    }
    const { experts, errors } = await storeFor(projectRoot).list();
    json(res, 200, {
      experts: experts.map((e) => toExpertListItem(e)),
      errors,
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
