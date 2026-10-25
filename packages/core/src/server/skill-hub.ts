/**
 * Skill Hub：技能市场目录合并 / 已安装检测 / 远程源 / URL 导入（后端核心逻辑）
 *
 * 目录来源：
 *   - 内置 seed catalog（skill-hub-catalog.ts，随包发布，始终可用）
 *   - 远程 registry（<configHome>/.y-zero/skill-hub.json 配置的 sources，
 *     每次列表请求实时 fetch，10s 超时，单个源失败不阻塞其他源）
 *
 * 去重口径：同名条目只保留第一个出现的（builtin 优先，其后按 sources 配置顺序），
 * 重复条目丢弃并记入 errors 提示。
 *
 * 已安装检测：扫描 user/project/builtin 三层 skills 目录（复用 listLayerSkills），
 * 按 name 匹配 → entry.installedIn；本地 SKILL.md 无版本字段，不做版本对比，
 * UI 口径为「覆盖重装」而非「更新」。
 *
 * 安装落盘一律走 config-store.writeSkill（自带名称校验与路径逃逸防护）。
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { parseFrontmatter } from '../skills/loader.js';
import { listLayerSkills, skillLayerDirs, validateConfigName, type SkillLayers } from './config-store.js';
import { SEED_SKILLS, findBuiltinHubEntry, type HubEntry } from './skill-hub-catalog.js';

export type { HubEntry };

/** 远程源配置（skill-hub.json 的 sources 数组元素） */
export interface HubSourceConfig {
  name: string;
  url: string;
}

/** 远程源拉取状态（GET /api/skill-hub 响应中的 sources 字段） */
export interface HubSourceStatus {
  name: string;
  url: string;
  status: 'ok' | 'error';
  error?: string;
  count: number;
}

/** 目录条目视图：entry + 来源 + 已安装层 */
export interface HubItem extends HubEntry {
  /** 来源：'builtin' 或远程源名 */
  source: string;
  installedIn: { user?: boolean; project?: boolean; builtin?: boolean };
}

export interface HubSnapshot {
  items: HubItem[];
  sources: HubSourceStatus[];
  errors: string[];
}

/** 远程 registry 拉取超时（ms） */
const FETCH_TIMEOUT_MS = 10_000;

// ── sources 配置文件（<configHome>/.y-zero/skill-hub.json）──────────────────

function hubSourcesFile(configHome: string): string {
  return path.join(configHome, '.y-zero', 'skill-hub.json');
}

/**
 * 校验 sources 数组形状：每项需非空 name + 合法 http(s) URL。
 * 返回规范化后的列表；非法抛错（消息含具体条目，供 PUT 端点 400 回显）。
 */
export function validateHubSources(raw: unknown): HubSourceConfig[] {
  if (!Array.isArray(raw)) throw new Error('sources 必须是数组');
  const out: HubSourceConfig[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== 'object' || item === null) throw new Error(`sources[${i}] 必须是对象`);
    const { name, url } = item as Record<string, unknown>;
    if (typeof name !== 'string' || name.trim() === '') throw new Error(`sources[${i}].name 不能为空`);
    if (typeof url !== 'string' || !isValidHttpUrl(url.trim())) {
      throw new Error(`sources[${i}].url 必须是合法的 http(s) URL`);
    }
    const key = name.trim();
    if (seen.has(key)) throw new Error(`sources[${i}].name 重复：${key}`);
    seen.add(key);
    out.push({ name: key, url: url.trim() });
  }
  return out;
}

function isValidHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 读取 sources 配置；文件不存在 / JSON 损坏返回空列表 + error 提示（不阻塞目录浏览） */
export async function readHubSources(configHome: string): Promise<{ sources: HubSourceConfig[]; error?: string }> {
  let raw: string;
  try {
    raw = await fsp.readFile(hubSourcesFile(configHome), 'utf8');
  } catch {
    return { sources: [] };
  }
  try {
    const parsed = JSON.parse(raw) as { sources?: unknown };
    return { sources: validateHubSources(parsed.sources ?? []) };
  } catch (e) {
    return { sources: [], error: `skill-hub.json 解析失败：${(e as Error).message}` };
  }
}

/** 整体写入 sources 配置（覆盖该文件）；写入前做形状校验 */
export async function writeHubSources(configHome: string, sources: HubSourceConfig[]): Promise<string> {
  const file = hubSourcesFile(configHome);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify({ sources }, null, 2)}\n`, 'utf8');
  return file;
}

// ── 远程 registry 拉取与规范化 ──────────────────────────────────────────────

/** fetch + 10s AbortController 超时，返回文本内容 */
async function fetchTextWithTimeout(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 远程 registry 原始条目形状（category/version 允许缺省） */
interface RawHubEntry {
  name?: unknown;
  description?: unknown;
  category?: unknown;
  version?: unknown;
  author?: unknown;
  triggers?: unknown;
  toolsAllowlist?: unknown;
  tools_allowlist?: unknown;
  body?: unknown;
}

/** 规范化单条远程条目；非法（缺 name/description/body 或名称不过校验）返回错误消息 */
function normalizeRemoteEntry(raw: RawHubEntry, sourceName: string, index: number): { entry?: HubEntry; error?: string } {
  const label = `${sourceName}[${index}]`;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return { error: `${label}：缺少 name` };
  const invalid = validateConfigName(name);
  if (invalid) return { error: `${label}：name「${name}」${invalid}` };
  const description = typeof raw.description === 'string' ? raw.description : '';
  const body = typeof raw.body === 'string' ? raw.body : '';
  if (!description && !body) return { error: `${label}：缺少 description 或 body` };
  const toList = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
  return {
    entry: {
      name,
      description,
      category: typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : '远程',
      version: typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : '0.0.0',
      author: typeof raw.author === 'string' && raw.author.trim() ? raw.author.trim() : sourceName,
      triggers: toList(raw.triggers),
      toolsAllowlist: toList(raw.toolsAllowlist ?? raw.tools_allowlist),
      body,
    },
  };
}

/** 拉取单个远程 registry 并规范化条目（单个条目非法跳过并记错误，不炸整源） */
async function fetchRemoteRegistry(
  source: HubSourceConfig,
): Promise<{ status: 'ok' | 'error'; error?: string; entries: HubEntry[]; entryErrors: string[] }> {
  let text: string;
  try {
    text = await fetchTextWithTimeout(source.url);
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? `拉取超时（${FETCH_TIMEOUT_MS / 1000}s）` : (e as Error).message;
    return { status: 'error', error: msg, entries: [], entryErrors: [] };
  }
  try {
    const parsed = JSON.parse(text) as { skills?: RawHubEntry[] };
    const list = Array.isArray(parsed.skills) ? parsed.skills : [];
    const entries: HubEntry[] = [];
    const entryErrors: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const r = normalizeRemoteEntry(list[i]!, source.name, i);
      if (r.entry) entries.push(r.entry);
      else if (r.error) entryErrors.push(r.error);
    }
    return { status: 'ok', entries, entryErrors };
  } catch (e) {
    return { status: 'error', error: `registry JSON 解析失败：${(e as Error).message}`, entries: [], entryErrors: [] };
  }
}

// ── 目录合并 + 已安装检测 ───────────────────────────────────────────────────

/** 扫描三层 skills 目录，name → installedIn */
async function detectInstalled(layers: SkillLayers): Promise<{
  installed: Map<string, HubItem['installedIn']>;
  errors: string[];
}> {
  const dirs = skillLayerDirs(layers);
  const installed = new Map<string, HubItem['installedIn']>();
  const errors: string[] = [];
  const scan: Array<{ layer: 'builtin' | 'user' | 'project'; dir: string | null }> = [
    { layer: 'builtin', dir: dirs.builtin },
    { layer: 'user', dir: dirs.user },
    { layer: 'project', dir: dirs.project },
  ];
  for (const { layer, dir } of scan) {
    if (!dir) continue;
    const { skills, errors: layerErrors } = await listLayerSkills(dir, layer);
    errors.push(...layerErrors);
    for (const s of skills) {
      const prev = installed.get(s.name) ?? {};
      installed.set(s.name, { ...prev, [layer]: true });
    }
  }
  return { installed, errors };
}

/**
 * 合并内置目录 + 各远程源为 Hub 快照。
 * 同名去重：builtin 优先，其后按 sources 配置顺序取第一个，重复丢弃并记 errors。
 */
export async function listHubSnapshot(layers: SkillLayers, configHome: string): Promise<HubSnapshot> {
  const { sources, error: sourcesError } = await readHubSources(configHome);
  const errors: string[] = sourcesError ? [sourcesError] : [];

  // 组装条目流：builtin 在前，远程按配置顺序在后（列表语义：先出现者保留）
  const items: HubItem[] = [];
  const seen = new Set<string>();
  const sourceStatuses: HubSourceStatus[] = [];

  for (const entry of SEED_SKILLS) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    items.push({ ...entry, source: 'builtin', installedIn: {} });
  }

  // 逐源并发拉取（失败互不阻塞）
  const fetched = await Promise.all(
    sources.map(async (source) => {
      const r = await fetchRemoteRegistry(source);
      return { source, r };
    }),
  );
  for (const { source, r } of fetched) {
    sourceStatuses.push({
      name: source.name,
      url: source.url,
      status: r.status,
      ...(r.error ? { error: r.error } : {}),
      count: r.entries.length,
    });
    errors.push(...r.entryErrors);
    for (const entry of r.entries) {
      if (seen.has(entry.name)) {
        errors.push(`远程条目「${entry.name}」（源 ${source.name}）与既有条目同名，已跳过`);
        continue;
      }
      seen.add(entry.name);
      items.push({ ...entry, source: source.name, installedIn: {} });
    }
  }

  // 已安装检测
  const { installed, errors: installErrors } = await detectInstalled(layers);
  errors.push(...installErrors);
  for (const item of items) item.installedIn = installed.get(item.name) ?? {};

  return { items, sources: sourceStatuses, errors };
}

/** 按 source + name 从目录取单条完整 entry（含 body）：builtin 走 seed，远程实时拉取 */
export async function findHubEntry(configHome: string, source: string, name: string): Promise<HubEntry | null> {
  if (source === 'builtin') return findBuiltinHubEntry(name) ?? null;
  const { sources } = await readHubSources(configHome);
  const target = sources.find((s) => s.name === source);
  if (!target) return null;
  const { entries } = await fetchRemoteRegistry(target);
  return entries.find((e) => e.name === name) ?? null;
}

// ── URL 导入（SKILL.md raw 原文 → 结构化字段）────────────────────────────────

/** 解析出的 SKILL.md 导入载荷（不含 name —— name 由调用方决定） */
export interface ImportedSkill {
  description: string;
  triggers: string[];
  toolsAllowlist: string[];
  body: string;
}

/** 从 URL 拉取 SKILL.md 原文并解析 frontmatter（description / triggers / tools_allowlist + body） */
export async function importSkillFromUrl(url: string): Promise<ImportedSkill> {
  const raw = await fetchTextWithTimeout(url);
  const { frontmatter, body } = parseFrontmatter(raw);
  const str = (v: string | string[] | undefined): string => (typeof v === 'string' ? v : '');
  const list = (v: string | string[] | undefined): string[] => {
    if (Array.isArray(v)) return v.filter(Boolean);
    if (typeof v === 'string' && v.trim()) return [v.trim()];
    return [];
  };
  const description = str(frontmatter.description);
  if (!description && !body.trim()) {
    throw new Error('导入内容既无 description 也无正文，无法安装');
  }
  return {
    description,
    triggers: list(frontmatter.triggers),
    toolsAllowlist: list(frontmatter.tools_allowlist),
    body,
  };
}

/** 从 URL 推导默认 Skill 名称（取路径最后一段，去扩展名；非法时返回 null 由调用方要求显式命名） */
export function deriveNameFromUrl(url: string): string | null {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    const base = last.replace(/\.md$/i, '');
    return base && validateConfigName(base) === null ? base : null;
  } catch {
    return null;
  }
}
