/**
 * 架构收口 T8 —— 声明式路由表（3 组试点：cron / worker-tasks / sessions）。
 *
 * 目标（判据 2 的核心收益）：端点权限标注**可测、不散落**——每条路由必须显式声明
 * auth（未声明在 createWebServer 启动时直接抛错，见 assertRouteDecls）。
 *
 * 渐进迁移边界（红线）：
 *  - 本文件只提供类型 + 轻量匹配器 + 启动断言；**不做鉴权/权限执行**——执行仍走
 *    http.ts 既有的统一 authToken 中间件（行为零变化），auth/permission 字段本轮
 *    仅声明与文档化；
 *  - 未命中路由表的请求落入既有 if/else 链（未迁移端点不受影响）；
 *  - /ws/terminal 的独立 upgrade 路径与本表无关（不受影响）。
 *
 * 匹配语义：pattern 按 '/' 切段，':x' 通配单段；请求段数必须与 pattern 段数一致；
 * 同段数时静态段多的优先（静态优先于通配），再按声明顺序。
 */
import type * as http from 'node:http';

export type RouteMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';

/**
 * 鉴权标注（仅声明，执行走既有统一中间件）：
 *  - 'token'：需 authToken（桌面宿主注入时的统一 API 鉴权口径）；
 *  - 'none'：无鉴权（静态资源等）；
 *  - 'sse'：事件流端点（鉴权同 token，标注区分消费形态）。
 */
export type RouteAuth = 'token' | 'none' | 'sse';

export interface RouteParams {
  readonly [name: string]: string;
}

export interface RouteHandlerCtx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: RouteParams;
  /** 惰性读 body（GET 无 body 时调用方不应调用） */
  readBody: () => Promise<Record<string, unknown>>;
}

export interface RouteDef {
  method: RouteMethod;
  /** 路径 pattern，如 'api/cron/:id/run'（':x' 通配单段；段数与请求一致） */
  pattern: string;
  /** 鉴权标注——**必填**，缺省在启动断言时抛错（判据 2） */
  auth: RouteAuth;
  /** 权限档标注（'read' | 'write' | 'dispatch' | …；本轮仅声明不执行） */
  permission?: string;
  /** 一句话描述（对照表 / 文档用） */
  description?: string;
  handler: (ctx: RouteHandlerCtx) => Promise<void>;
}

interface CompiledPattern {
  segments: string[];
  staticCount: number;
}

const patternCache = new WeakMap<RouteDef, CompiledPattern>();

function compile(def: RouteDef): CompiledPattern {
  const cached = patternCache.get(def);
  if (cached) return cached;
  const segments = def.pattern.split('/').filter(Boolean);
  const compiled = {
    segments,
    staticCount: segments.filter((s) => !s.startsWith(':')).length,
  };
  patternCache.set(def, compiled);
  return compiled;
}

export interface RouteMatch {
  def: RouteDef;
  params: RouteParams;
}

/**
 * 轻量匹配器：method 一致 + 段数一致 + 逐段匹配（':x' 通配）。
 * 多个候选时静态段多者优先（静态优先于通配），再按声明顺序。
 */
export function matchRoute(defs: RouteDef[], method: string, parts: string[]): RouteMatch | null {
  let best: { def: RouteDef; params: RouteParams; score: number } | null = null;
  for (const def of defs) {
    const { segments, staticCount } = compile(def);
    if (def.method !== method || segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      if (seg.startsWith(':')) params[seg.slice(1)] = parts[i]!;
      else if (seg !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (!best || staticCount > best.score) best = { def, params, score: staticCount };
  }
  return best ? { def: best.def, params: best.params } : null;
}

/**
 * 把插件路由并进表。同 method + pattern 视为重复，启动期抛错。
 */
export function appendRoutes(table: RouteDef[], extra: readonly RouteDef[]): void {
  const seen = new Set(table.map((def) => routeKey(def)));
  for (const def of extra) {
    const key = routeKey(def);
    if (seen.has(key)) throw new Error(`route already registered: ${def.method} ${def.pattern}`);
    seen.add(key);
    table.push(def);
  }
}

function routeKey(def: RouteDef): string {
  return `${def.method} ${def.pattern.replace(/^\//, '')}`;
}

/**
 * 启动断言（判据 2）：任何路由未声明 auth → createWebServer() 构造时直接抛错。
 * 这保证「权限标注不散落」是编译/启动期可测约束，而非代码评审约定。
 */
export function assertRouteDecls(defs: RouteDef[], source = 'route table'): void {
  for (const def of defs) {
    if (!def.auth) {
      throw new Error(
        `${source}: 路由 ${def.method} ${def.pattern} 未声明 auth（必填：'token' | 'none' | 'sse'）——架构收口 T8 判据 2`,
      );
    }
    if (!def.pattern.startsWith('api/') && !def.pattern.startsWith('/api/')) {
      throw new Error(`${source}: 路由 ${def.method} ${def.pattern} 不在 /api 前缀下（路由表只管 API，静态资源走既有分支）`);
    }
    if (typeof def.handler !== 'function') {
      throw new Error(`${source}: 路由 ${def.method} ${def.pattern} 缺 handler`);
    }
  }
}
