/**
 * Skill Hub 客户端（从远端 Skill Hub 搜索 / 安装 Skill）
 *
 * 协议（与 skillhub.cn 开放端点兼容；自建 hub / 镜像只需实现两个端点）：
 *   搜索：GET {base}/api/v1/search?q=<query>&limit=<n>  → { results: HubSkillInfo[] }
 *   下载：GET {base}/api/v1/download?slug=<slug>        → zip 包（SKILL.md 位于包根或单一顶层目录）
 *
 * hub 地址解析优先级（resolveSkillHubBase）：
 *   显式 flag > 环境变量 YZERO_SKILL_HUB_URL > ~/.y-zero/skill-hub.json 的 url 字段 > 官方默认
 *
 * 安装目标：user 层 `~/.y-zero/skills/<slug>/` 或项目层 `.y-zero/skills/<slug>/`，
 * 装完即被三层加载器（loader.ts）识别，无需重启。
 *
 * 安全约束：
 *   - zip 条目做 zip-slip 校验（拒绝绝对路径 / `..` 越界条目）；
 *   - 解压总量上限 MAX_EXTRACT_BYTES，防 zip 炸弹；
 *   - 安装完成后用 readSkillDir 校验 SKILL.md 可解析，避免装进坏包。
 */
import { promises as fs, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { unzipSync } from 'fflate';
import { readSkillDir, type SkillLayer, type SkillMeta } from './loader.js';

/** 官方 Skill Hub 默认地址 */
export const DEFAULT_SKILL_HUB_BASE = 'https://api.skillhub.cn';

/** 环境变量名：一次性覆盖 hub 地址（优先级高于配置文件） */
export const SKILL_HUB_ENV = 'YZERO_SKILL_HUB_URL';

/** 解压总量上限（64 MB）：超过即判定为 zip 炸弹，中止安装 */
export const MAX_EXTRACT_BYTES = 64 * 1024 * 1024;

/** 搜索结果条目（字段为 hub 返回的超集，均为可选宽容解析） */
export interface HubSkillInfo {
  slug: string;
  name: string;
  displayName?: string;
  description: string;
  /** 中文描述（skillhub.cn 提供，自建 hub 可能没有） */
  descriptionZh?: string;
  version?: string;
  downloads?: number;
  installs?: number;
  /** 来源标识（如 clawhub / enterprise），仅展示用 */
  source?: string;
}

// ── 配置读写（~/.y-zero/skill-hub.json）────────────────────────────────────

/** hub 配置文件路径（`skill hub set/get/reset` 与运行时解析共用，保证单点） */
export function userSkillHubConfigPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.y-zero', 'skill-hub.json');
}

/**
 * 读取配置文件中的 hub 地址；文件缺失 / 坏 JSON / 字段非法 → 返回 undefined（永不 throw）。
 * 运行时降级语义：配置写错不该让搜索/安装不可用。
 */
export function readSkillHubUrl(homeDir: string = os.homedir()): string | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(userSkillHubConfigPath(homeDir), 'utf-8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const url = (raw as Record<string, unknown>).url;
    return typeof url === 'string' && url.trim() !== '' ? url.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 写入 / 清除 hub 地址（`skill hub set/reset` 唯一写入口）。
 * 约束：只改 `url` 一个字段、其余字段原样保留（写前读）；tmp+rename 原子写。
 * `url=null` 表示清除（恢复官方默认）。既有文件坏 JSON 时拒绝写入并抛错（覆盖用户文件宁可失败）。
 */
export function writeSkillHubUrl(
  url: string | null,
  opts: { homeDir?: string } = {},
): { path: string } {
  if (url !== null) normalizeHubBase(url); // 先校验格式，非法不落盘
  const file = userSkillHubConfigPath(opts.homeDir);
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });

  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('不是 JSON 对象');
      }
      raw = parsed as Record<string, unknown>;
    } catch (e) {
      throw new Error(`Skill Hub 配置 ${file} 无法解析（${(e as Error).message}），请手工修复后再试`);
    }
  }
  if (url === null) delete raw.url;
  else raw.url = normalizeHubBase(url);

  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
  renameSync(tmp, file);
  return { path: file };
}

/** hub 地址来源（调试展示用） */
export type SkillHubSource = 'flag' | 'env' | 'config' | 'default';

/**
 * 解析生效的 hub base 地址。
 * 优先级：flag > 环境变量 YZERO_SKILL_HUB_URL > 配置文件 ~/.y-zero/skill-hub.json > 官方默认。
 * 非法 URL（非 http/https）一律抛错——地址错误应显式失败，而不是静默打到默认源。
 */
export function resolveSkillHubBase(
  opts: { flag?: string; homeDir?: string } = {},
): { base: string; source: SkillHubSource } {
  if (opts.flag && opts.flag.trim() !== '') {
    return { base: normalizeHubBase(opts.flag), source: 'flag' };
  }
  const env = process.env[SKILL_HUB_ENV];
  if (env && env.trim() !== '') return { base: normalizeHubBase(env), source: 'env' };
  const configured = readSkillHubUrl(opts.homeDir);
  if (configured) return { base: normalizeHubBase(configured), source: 'config' };
  return { base: DEFAULT_SKILL_HUB_BASE, source: 'default' };
}

/** 校验并归一化 hub 地址：必须为 http(s) URL，去掉尾部 `/` */
function normalizeHubBase(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Skill Hub 地址不是合法 URL：${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Skill Hub 地址必须是 http(s) URL：${url}`);
  }
  return trimmed;
}

// ── 搜索 ────────────────────────────────────────────────────────────────────

export interface SearchHubSkillsOptions {
  /** 返回条数上限（默认 10） */
  limit?: number;
  /** 测试注入用 fetch 实现；缺省用全局 fetch */
  fetchImpl?: typeof fetch;
  /** 请求超时毫秒数（默认 15000） */
  timeoutMs?: number;
}

/** 搜索 hub 上的 Skill（GET {base}/api/v1/search?q=&limit=） */
export async function searchHubSkills(
  base: string,
  query: string,
  opts: SearchHubSkillsOptions = {},
): Promise<HubSkillInfo[]> {
  const limit = opts.limit ?? 10;
  const url = `${normalizeHubBase(base)}/api/v1/search?q=${encodeURIComponent(query)}&limit=${limit}`;
  const json = await fetchJson(url, opts.fetchImpl, opts.timeoutMs);

  const results = (json as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    throw new Error(`Skill Hub 搜索响应格式异常（缺少 results 数组）：${url}`);
  }
  return results.map(parseHubSkillInfo).filter((s): s is HubSkillInfo => s !== null);
}

/** 宽容解析单条搜索结果：slug 缺失的条目直接丢弃 */
function parseHubSkillInfo(raw: unknown): HubSkillInfo | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const slug = typeof r.slug === 'string' ? r.slug : '';
  if (slug === '') return null;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  return {
    slug,
    name: str(r.name) ?? slug,
    displayName: str(r.displayName),
    description: str(r.description) ?? '',
    descriptionZh: str(r.description_zh) ?? str(r.descriptionZh),
    version: str(r.version),
    downloads: num(r.downloads),
    installs: num(r.installs),
    source: str(r.source),
  };
}

// ── 安装 ────────────────────────────────────────────────────────────────────

export interface InstallHubSkillOptions {
  /** hub base 地址（必填，由调用方先 resolveSkillHubBase 解析） */
  base: string;
  /** 安装目标目录（user 层 `~/.y-zero/skills` 或项目层 `<root>/.y-zero/skills`） */
  targetDir: string;
  /** 同名目录已存在时是否覆盖（覆盖 = 删除旧目录后重装） */
  force?: boolean;
  /** 安装层的元数据标记（仅影响 SkillMeta.layer 展示） */
  layer?: SkillLayer;
  /** 测试注入用 fetch 实现；缺省用全局 fetch */
  fetchImpl?: typeof fetch;
  /** 请求超时毫秒数（默认 60000，下载比搜索慢） */
  timeoutMs?: number;
}

export interface InstallHubSkillResult {
  /** 安装目录（绝对路径） */
  dir: string;
  /** 目录名（slug 末段净化后的安全名） */
  dirName: string;
  /** 安装后解析出的 Skill 元数据（SKILL.md 校验通过） */
  skill: SkillMeta;
  /** 写入的文件相对路径列表 */
  files: string[];
}

/**
 * 从 hub 安装单个 Skill 到目标目录：
 * 下载 zip → 解压（zip-slip 防护 + 总量上限）→ 写盘 → readSkillDir 校验 SKILL.md。
 * 目录名取 slug 末段（命名空间 slug 如 `@org/name` 取 `name`）并净化为安全字符。
 */
export async function installHubSkill(
  slug: string,
  opts: InstallHubSkillOptions,
): Promise<InstallHubSkillResult> {
  const base = normalizeHubBase(opts.base);
  const cleanSlug = slug.trim();
  if (cleanSlug === '') throw new Error('slug 不能为空');

  // 1. 下载
  const url = `${base}/api/v1/download?slug=${encodeURIComponent(cleanSlug)}`;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) });
  if (!res.ok) {
    throw new Error(`下载失败（HTTP ${res.status}）：${url}`);
  }
  const zipBytes = new Uint8Array(await res.arrayBuffer());

  // 2. 解压（内存中）+ 安全校验
  const entries = extractZipEntries(zipBytes);

  // 3. 目标目录
  const dirName = safeDirName(cleanSlug);
  const target = path.join(opts.targetDir, dirName);
  if (existsSync(target)) {
    if (!opts.force) {
      throw new Error(`目标目录已存在：${target}（如需覆盖请加 --force）`);
    }
    await fs.rm(target, { recursive: true, force: true });
  }
  await fs.mkdir(target, { recursive: true });

  // 4. 写盘（zip-slip 双重校验：entry 名已过滤，这里再确保最终路径不出 target）
  const files: string[] = [];
  for (const [name, data] of entries) {
    const dest = path.resolve(target, name);
    if (dest !== target && !dest.startsWith(target + path.sep)) {
      throw new Error(`zip 条目越界（zip-slip），已中止：${name}`);
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, data);
    files.push(name);
  }

  // 5. SKILL.md 校验：解析失败视为坏包，整体报错（目录保留现场供排查）
  const layer: SkillLayer = opts.layer ?? 'user';
  const skill = await readSkillDir(target, layer, dirName);

  return { dir: target, dirName, skill, files };
}

/**
 * 解压 zip 字节为 `{相对路径 → 内容}` 有序 Map：
 *  - 过滤目录条目 / `__MACOSX` / `.DS_Store`；
 *  - 若所有条目都在同一顶层目录下（如 `myskill/SKILL.md`），剥掉该前缀（SkillHub zip 有两种布局）；
 *  - zip-slip：拒绝绝对路径与含 `..` 段的条目；
 *  - zip 炸弹：累计解压字节数超 MAX_EXTRACT_BYTES 即抛错。
 */
export function extractZipEntries(zipBytes: Uint8Array): Map<string, Uint8Array> {
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(zipBytes);
  } catch (e) {
    throw new Error(`zip 解压失败（文件损坏或不是合法 zip）：${(e as Error).message}`);
  }

  const names = Object.keys(unzipped).filter(
    (n) =>
      !n.endsWith('/') &&
      !n.startsWith('__MACOSX/') &&
      !n.includes('/__MACOSX/') &&
      path.posix.basename(n) !== '.DS_Store',
  );
  if (names.length === 0) throw new Error('zip 包内没有可用文件（缺少 SKILL.md）');

  // 单一顶层目录布局：全部条目共享同一首段 → 剥前缀
  const firstSegs = new Set(names.map((n) => n.split('/')[0]!));
  const stripPrefix = firstSegs.size === 1 && names.some((n) => n.includes('/'))
    ? `${[...firstSegs][0]!}/`
    : '';

  const out = new Map<string, Uint8Array>();
  let total = 0;
  for (const name of names) {
    if (path.posix.isAbsolute(name) || name.split('/').includes('..')) {
      throw new Error(`zip 条目路径非法（zip-slip），已中止：${name}`);
    }
    const rel = stripPrefix && name.startsWith(stripPrefix) ? name.slice(stripPrefix.length) : name;
    if (rel === '') continue;
    const data = unzipped[name]!;
    total += data.byteLength;
    if (total > MAX_EXTRACT_BYTES) {
      throw new Error(`zip 解压总量超过上限（${MAX_EXTRACT_BYTES} 字节），疑似 zip 炸弹，已中止`);
    }
    out.set(rel, data);
  }
  if (!out.has('SKILL.md')) {
    throw new Error('zip 包内缺少 SKILL.md，不是合法的 Skill 包');
  }
  return out;
}

/** slug → 安全目录名：取 `/` 末段，非法字符替换为 `-`，空结果回退 `skill` */
function safeDirName(slug: string): string {
  const last = slug.split('/').pop() ?? slug;
  const cleaned = last.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return cleaned !== '' ? cleaned : 'skill';
}

// ── HTTP 公用 ───────────────────────────────────────────────────────────────

/** GET JSON：非 2xx 抛错（含状态码与 URL），超时默认 15s */
async function fetchJson(
  url: string,
  fetchImpl?: typeof fetch,
  timeoutMs?: number,
): Promise<unknown> {
  const res = await (fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(timeoutMs ?? 15_000) });
  if (!res.ok) throw new Error(`请求失败（HTTP ${res.status}）：${url}`);
  return res.json() as Promise<unknown>;
}
