/**
 * F-52 市场 registry 订阅源配置（~/.delta/registry.json）
 *
 * 形状：{ "sources": [{ "name": "...", "url": "https://...", "kind": "skills" | "mcp" }] }
 *
 * 旧配置兼容（读时迁移）：registry.json 不存在时回退读 skill-hub.json 的 sources
 * （视为 skills 源），保证既有 Web Skill Hub 用户无缝升级；一旦写入 registry.json
 * 即以它为准（skill-hub.json 不再读取）。
 *
 * 安全口径：坏 JSON / 非法条目读取降级为空列表 + error 提示（不阻塞目录浏览）；
 * 写入前做形状校验，tmp+rename 原子写。
 */
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FILES, userConfigDir } from '../paths.js';

export type MarketSourceKind = 'skills' | 'mcp';

/** 订阅源配置条目（registry.json 的 sources 数组元素） */
export interface MarketSourceConfig {
  name: string;
  url: string;
  kind: MarketSourceKind;
}

/** 读取结果：sources + 降级信息（供 UI/CLI 标注来源与错误） */
export interface MarketSourcesReadResult {
  sources: MarketSourceConfig[];
  /** 数据来自旧 skill-hub.json（registry.json 尚未创建） */
  legacy?: boolean;
  error?: string;
}

export function userRegistryConfigPath(homeDir: string = os.homedir()): string {
  return path.join(userConfigDir(homeDir), FILES.registry);
}

function legacyHubSourcesPath(homeDir: string): string {
  return path.join(userConfigDir(homeDir), FILES.skillHub);
}

function isValidHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 校验 sources 数组形状：每项需非空 name + 合法 http(s) URL + kind ∈ {skills, mcp}；非法抛错 */
export function validateMarketSources(raw: unknown): MarketSourceConfig[] {
  if (!Array.isArray(raw)) throw new Error('sources 必须是数组');
  const out: MarketSourceConfig[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== 'object' || item === null) throw new Error(`sources[${i}] 必须是对象`);
    const { name, url, kind } = item as Record<string, unknown>;
    if (typeof name !== 'string' || name.trim() === '') throw new Error(`sources[${i}].name 不能为空`);
    if (typeof url !== 'string' || !isValidHttpUrl(url.trim())) {
      throw new Error(`sources[${i}].url 必须是合法的 http(s) URL`);
    }
    if (kind !== 'skills' && kind !== 'mcp') {
      throw new Error(`sources[${i}].kind 必须是 skills 或 mcp`);
    }
    const key = name.trim();
    if (seen.has(key)) throw new Error(`sources[${i}].name 重复：${key}`);
    seen.add(key);
    out.push({ name: key, url: url.trim(), kind });
  }
  return out;
}

/**
 * 读取订阅源配置：registry.json 优先；不存在时回退旧 skill-hub.json 的 sources（kind=skills）。
 * 坏 JSON 降级为空列表 + error，不抛错（读取失败不该让市场不可用）。
 */
export async function readMarketSources(homeDir: string = os.homedir()): Promise<MarketSourcesReadResult> {
  const file = userRegistryConfigPath(homeDir);
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    // registry.json 不存在 → 旧 skill-hub.json 兼容回退
    try {
      const legacyRaw = await fsp.readFile(legacyHubSourcesPath(homeDir), 'utf8');
      const parsed = JSON.parse(legacyRaw) as { sources?: unknown };
      const legacyList = Array.isArray(parsed.sources) ? (parsed.sources as Record<string, unknown>[]) : [];
      const sources = validateMarketSources(legacyList.map((s) => ({ ...s, kind: 'skills' })));
      return { sources, legacy: true };
    } catch {
      return { sources: [] }; // 旧配置也不存在/损坏 → 视为无订阅源（正常状态）
    }
  }
  try {
    const parsed = JSON.parse(raw) as { sources?: unknown };
    return { sources: validateMarketSources(parsed.sources ?? []) };
  } catch (e) {
    return { sources: [], error: `registry.json 解析失败：${(e as Error).message}` };
  }
}

/** 整体写入订阅源配置（覆盖写 registry.json；写入前形状校验；tmp+rename 原子写） */
export async function writeMarketSources(homeDir: string, sources: MarketSourceConfig[]): Promise<string> {
  const file = userRegistryConfigPath(homeDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const validated = validateMarketSources(sources);
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, `${JSON.stringify({ sources: validated }, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
  return file;
}
