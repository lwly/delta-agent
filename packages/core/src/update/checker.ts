/**
 * F-50 自动更新 —— 检查器（AC-50-1 / AC-50-2 / AC-50-4）。
 *
 *  - 渠道判定：`node:sea` 的 isSea()（SEA 形态 true，npm 形态 false）；
 *  - 更新源：GitHub Release / Gitee Release / 自定义 JSON，拉取失败**静默 + F-41 留档**（AC-50-4）；
 *  - 启动检查：fire-and-forget + 周节流（lastCheckAt 回写，intervalMs 可配），绝不阻塞/影响主流程；
 *  - 降级拒绝：latest 不严格大于 current 一律视为无更新（AC-50-5，见 version.ts）。
 */
import type { RunLogSink } from '../logging/logger.js';
import { APP_NAME } from '../paths.js';
import { loadUpdateConfig, updateUpdateState } from './config.js';
import { isNewerVersion, parseVersion } from './version.js';
import type { UpdateAsset, UpdateCheckResult, UpdateSource } from './types.js';

/** 更新渠道：SEA 单文件二进制 / npm 全局安装 */
export type UpdateChannel = 'sea' | 'npm';

/**
 * 渠道判定：node:sea 的 isSea()（SEA 形态 true，npm 形态 false）。
 * 动态 import：node:sea 在部分测试/旧运行时环境不可解析，失败按 npm 处理（保守降级，绝不误替换二进制）。
 */
export async function detectChannel(): Promise<UpdateChannel> {
  try {
    const { isSea } = await import('node:sea');
    return isSea() ? 'sea' : 'npm';
  } catch {
    return 'npm';
  }
}

const FETCH_TIMEOUT_MS = 8_000;

/** 更新源 fetch 注入口（测试伪造用） */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CheckForUpdateOptions {
  currentVersion: string;
  source?: UpdateSource;
  /** 缺省 globalThis.fetch */
  fetcher?: FetchLike;
  /** F-41 留档（缺省静默不留档） */
  log?: RunLogSink;
}

/** 按源类型解析 release API / JSON 端点地址。 */
export function resolveSourceUrl(source: UpdateSource): string {
  if (source.type === 'json') {
    if (!source.url) throw new Error('自定义 JSON 更新源缺少 url');
    return source.url;
  }
  const repo = source.repo;
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error(`更新源 repo 必须是 owner/repo 形式，收到 ${JSON.stringify(repo)}`);
  }
  if (source.type === 'github') return `https://api.github.com/repos/${repo}/releases/latest`;
  return `https://gitee.com/api/v5/repos/${repo}/releases/latest`;
}

/** Release 落地页（用户浏览器打开的地址）。 */
function resolveReleaseUrl(source: UpdateSource, raw: Record<string, unknown>): string {
  if (typeof raw.html_url === 'string' && raw.html_url !== '') return raw.html_url;
  if (source.type === 'json' && source.url) return source.url;
  if ((source.type === 'github' || source.type === 'gitee') && source.repo) {
    return `https://${source.type === 'github' ? 'github.com' : 'gitee.com'}/${source.repo}/releases`;
  }
  return '';
}

function normalizeAssets(raw: Record<string, unknown>): UpdateAsset[] {
  const assets = raw.assets;
  if (!Array.isArray(assets)) return [];
  const out: UpdateAsset[] = [];
  for (const a of assets) {
    if (a === null || typeof a !== 'object') continue;
    const rec = a as Record<string, unknown>;
    if (typeof rec.name === 'string' && typeof rec.browser_download_url === 'string') {
      out.push({ name: rec.name, downloadUrl: rec.browser_download_url });
    }
  }
  return out;
}

/**
 * 拉取远端最新版本并按「严格更新」口径判定。
 * 失败（网络 / 4xx/5xx / 结构不符 / 版本不可比较）抛错，由调用方决定静默策略；
 * 本函数自身不写状态、不弹 UI。
 */
export async function checkForUpdate(opts: CheckForUpdateOptions): Promise<UpdateCheckResult> {
  const source = opts.source ?? loadUpdateConfig().config.source;
  const fetcher = opts.fetcher ?? fetch;
  const log = opts.log;
  const url = resolveSourceUrl(source);
  try {
    const res = await fetcher(url, {
      headers: { accept: 'application/json', 'user-agent': `${APP_NAME}-update` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('响应不是 JSON 对象');
    }
    const raw = body as Record<string, unknown>;
    const tag = typeof raw.tag_name === 'string' ? raw.tag_name : typeof raw.version === 'string' ? raw.version : '';
    if (!tag || !parseVersion(tag)) {
      throw new Error(`响应缺少可解析的版本号（tag_name/version=${JSON.stringify(tag)}）`);
    }
    const latestVersion = tag.trim().replace(/^v/i, '');
    const assets = normalizeAssets(raw);
    const hasUpdate = isNewerVersion(latestVersion, opts.currentVersion);
    return {
      currentVersion: opts.currentVersion,
      latestVersion,
      hasUpdate,
      releaseUrl: resolveReleaseUrl(source, raw),
      notes: typeof raw.body === 'string' ? raw.body : '',
      assets,
    };
  } catch (e) {
    log?.append('warn', 'update', `更新检查失败（${source.type} ${url}）：${(e as Error).message}`);
    throw e;
  }
}

// ── 启动检查（fire-and-forget + 周节流，AC-50-1）────────────────────────────

export interface MaybeCheckOnStartupOptions {
  currentVersion: string;
  /** 缺省 os.homedir() */
  homeDir?: string;
  /** F-41 留档 */
  log?: RunLogSink;
  /** 缺省 globalThis.fetch */
  fetcher?: FetchLike;
  /** 缺省 Date.now() */
  now?: () => number;
}

/**
 * 启动时的一次性节流检查：enabled=false 或距 lastCheckAt 不足 intervalMs 直接跳过（零网络请求）。
 * 检查结果（含失败）都回写 lastCheckAt —— 一周最多打扰一次；发现新版本回写 lastSeenVersion 并
 * 通过 onNotice 回调提示（TUI 启动前 console.error 一行，桌面端可据此点亮角标）。
 * 永不 throw：任何失败静默（已留档），返回 skipped/failed 信息供测试断言。
 */
export async function maybeCheckOnStartup(
  opts: MaybeCheckOnStartupOptions,
): Promise<{ ran: boolean; hasUpdate?: boolean; latestVersion?: string }> {
  const now = opts.now ?? Date.now;
  const { config } = loadUpdateConfig(opts.homeDir);
  if (!config.enabled) return { ran: false };
  const last = config.lastCheckAt ? Date.parse(config.lastCheckAt) : NaN;
  if (!Number.isNaN(last) && now() - last < config.intervalMs) return { ran: false };

  try {
    const result = await checkForUpdate({
      currentVersion: opts.currentVersion,
      source: config.source,
      fetcher: opts.fetcher,
      log: opts.log,
    });
    updateUpdateState({
      lastCheckAt: new Date(now()).toISOString(),
      ...(result.hasUpdate ? { lastSeenVersion: result.latestVersion } : {}),
    }, { homeDir: opts.homeDir });
    if (result.hasUpdate) {
      opts.log?.append('info', 'update', `发现新版本 ${result.latestVersion}（当前 ${opts.currentVersion}）：${result.releaseUrl}`);
      return { ran: true, hasUpdate: true, latestVersion: result.latestVersion };
    }
    return { ran: true, hasUpdate: false };
  } catch (e) {
    // 失败也记 lastCheckAt：避免每次启动都打一次必败请求（间隔内静默，AC-50-4）
    try {
      updateUpdateState({ lastCheckAt: new Date(now()).toISOString() }, { homeDir: opts.homeDir });
    } catch {
      // 状态回写失败忽略（配置目录不可写）
    }
    return { ran: true };
  }
}
