/**
 * F-52 市场安装链路（清单合并 / 条目定位 / Skill 安装 / MCP 测试+写入）
 *
 * 数据流：内置清单（catalog.ts）+ ~/.delta/registry.json 订阅源实时拉取（10s 超时，
 * 单源失败不阻塞、离线回退仅内置）→ 合并快照（内置优先去重）→ 定位条目 → 安装。
 *
 * 安全边界：
 *  - Skill 安装落盘复用 config-store.writeSkill（名称校验 + safeJoin 防路径逃逸）；
 *  - 含 scripts/ 的条目安装前强制确认（scripts_required 分支，CLI/Web 各自实现确认 UI）；
 *  - MCP 安装先连通性测试（connect + listTools，15s 超时）通过才写 mcp.json，
 *    headers 经 encryptMcpHeaders 加密落盘（F-48 口径）；
 *  - 远程条目 description/body 属外部内容，预览路径统一 wrapUntrusted 包裹（F-44 口径）。
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { wrapUntrusted } from '../context/untrusted.js';
import { McpManager, encryptMcpHeaders, readMcpConfigFile, saveMcpConfig } from '../mcp/client.js';
import type { McpServerConfig } from '../mcp/client.js';
import { FILES, projectConfigDir, userConfigDir } from '../paths.js';
import { deleteSkill, listLayerSkills, skillLayerDirs, validateConfigName, writeSkill, type SkillLayers } from '../server/config-store.js';
import { builtinSkillEntries, builtinMcpEntries, findBuiltinMarketEntry, type MarketEntry, type MarketScript } from './catalog.js';
import { readMarketSources, type MarketSourceConfig, type MarketSourceKind } from './registry.js';

export type { MarketEntry, MarketScript };

/** 远程 registry 拉取超时（ms） */
const FETCH_TIMEOUT_MS = 10_000;

/** MCP 连通性测试超时（ms）：connect + listTools 的总预算 */
export const MCP_PROBE_TIMEOUT_MS = 15_000;

// ── 远程清单拉取与规范化 ────────────────────────────────────────────────────

async function fetchTextWithTimeout(url: string, fetchImpl?: typeof fetch, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  const res = await (fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

function toList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}

/** 规范化远程 Skill 条目；非法返回错误消息（单条不合法跳过，不炸整源） */
function normalizeRemoteSkill(raw: Record<string, unknown>, sourceName: string, index: number): { entry?: MarketEntry; error?: string } {
  const label = `${sourceName}[${index}]`;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return { error: `${label}：缺少 name` };
  const invalid = validateConfigName(name);
  if (invalid) return { error: `${label}：name「${name}」${invalid}` };
  const description = typeof raw.description === 'string' ? raw.description : '';
  const body = typeof raw.body === 'string' ? raw.body : '';
  if (!description && !body) return { error: `${label}：缺少 description 或 body` };
  let scripts: MarketScript[] | undefined;
  if (Array.isArray(raw.scripts)) {
    scripts = [];
    for (let i = 0; i < raw.scripts.length; i++) {
      const s = raw.scripts[i] as Record<string, unknown>;
      const sName = typeof s?.name === 'string' ? s.name.trim() : '';
      const sContent = typeof s?.content === 'string' ? s.content : '';
      const sInvalid = validateScriptName(sName);
      if (sInvalid) return { error: `${label}.scripts[${i}]：${sInvalid}` };
      scripts.push({ name: sName, content: sContent });
    }
    if (scripts.length === 0) scripts = undefined;
  }
  return {
    entry: {
      kind: 'skill',
      name,
      description,
      category: typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : '远程',
      version: typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : '0.0.0',
      author: typeof raw.author === 'string' && raw.author.trim() ? raw.author.trim() : sourceName,
      triggers: toList(raw.triggers),
      toolsAllowlist: toList(raw.toolsAllowlist ?? raw.tools_allowlist),
      body,
      ...(scripts ? { scripts } : {}),
    },
  };
}

/** 规范化远程 MCP 条目：draft 必须 command/url 二选一 */
function normalizeRemoteMcp(raw: Record<string, unknown>, sourceName: string, index: number): { entry?: MarketEntry; error?: string } {
  const label = `${sourceName}[${index}]`;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return { error: `${label}：缺少 name` };
  const invalid = validateConfigName(name);
  if (invalid) return { error: `${label}：name「${name}」${invalid}` };
  const draftRaw = (typeof raw.draft === 'object' && raw.draft !== null ? raw.draft : raw) as Record<string, unknown>;
  const draft: McpServerConfig = {};
  if (typeof draftRaw.command === 'string' && draftRaw.command.trim()) {
    draft.command = draftRaw.command.trim();
    if (Array.isArray(draftRaw.args)) draft.args = draftRaw.args.map(String);
    if (typeof draftRaw.env === 'object' && draftRaw.env !== null) {
      draft.env = Object.fromEntries(Object.entries(draftRaw.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    }
  } else if (typeof draftRaw.url === 'string' && isValidHttpUrl(draftRaw.url.trim())) {
    draft.url = draftRaw.url.trim();
    if (typeof draftRaw.headers === 'object' && draftRaw.headers !== null) {
      draft.headers = Object.fromEntries(Object.entries(draftRaw.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    }
  } else {
    return { error: `${label}：draft 缺少 command（stdio）或合法 url（http）` };
  }
  return {
    entry: {
      kind: 'mcp',
      name,
      description: typeof raw.description === 'string' ? raw.description : '',
      category: typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : '远程',
      version: typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : '0.0.0',
      author: typeof raw.author === 'string' && raw.author.trim() ? raw.author.trim() : sourceName,
      draft,
    },
  };
}

/** 拉取单个订阅源并规范化（源失败 → status:error + 空条目；离线降级由合并层保证） */
export async function fetchMarketSourceEntries(
  source: MarketSourceConfig,
  fetchImpl?: typeof fetch,
): Promise<{ status: 'ok' | 'error'; error?: string; entries: MarketEntry[]; entryErrors: string[] }> {
  let text: string;
  try {
    text = await fetchTextWithTimeout(source.url, fetchImpl);
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? `拉取超时（${FETCH_TIMEOUT_MS / 1000}s）` : (e as Error).message;
    return { status: 'error', error: msg, entries: [], entryErrors: [] };
  }
  try {
    const parsed = JSON.parse(text) as { skills?: unknown[]; mcpServers?: unknown[] };
    const entries: MarketEntry[] = [];
    const entryErrors: string[] = [];
    const skills = Array.isArray(parsed.skills) ? parsed.skills : [];
    for (let i = 0; i < skills.length; i++) {
      const raw = skills[i];
      if (raw === null || typeof raw !== 'object') { entryErrors.push(`${source.name}.skills[${i}] 必须是对象`); continue; }
      const r = normalizeRemoteSkill(raw as Record<string, unknown>, source.name, i);
      if (r.entry) entries.push(r.entry); else if (r.error) entryErrors.push(r.error);
    }
    const mcps = Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [];
    for (let i = 0; i < mcps.length; i++) {
      const raw = mcps[i];
      if (raw === null || typeof raw !== 'object') { entryErrors.push(`${source.name}.mcpServers[${i}] 必须是对象`); continue; }
      const r = normalizeRemoteMcp(raw as Record<string, unknown>, source.name, i);
      if (r.entry) entries.push(r.entry); else if (r.error) entryErrors.push(r.error);
    }
    return { status: 'ok', entries, entryErrors };
  } catch (e) {
    return { status: 'error', error: `registry JSON 解析失败：${(e as Error).message}`, entries: [], entryErrors: [] };
  }
}

function isValidHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 脚本文件名校验：允许字母数字与 . _ -（扩展名场景），拒绝路径分隔符 / 隐藏文件 / 越界 */
export function validateScriptName(name: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
    return '脚本名仅允许字母数字与 . _ -，以字母数字开头，长度 1–128';
  }
  if (name.split('/').length > 1 || name.split('\\').length > 1 || name.includes('..')) {
    return '脚本名不允许路径分隔符或 ..';
  }
  return null;
}

// ── 快照合并 + 已装检测 ─────────────────────────────────────────────────────

/** 快照条目视图：entry + 来源 + 已装层 */
export interface MarketItemView {
  entry: MarketEntry;
  source: string;
  installedIn: { user?: boolean; project?: boolean; builtin?: boolean; global?: boolean };
}

export interface MarketSourceStatus {
  name: string;
  url: string;
  kind: MarketSourceKind;
  status: 'ok' | 'error';
  error?: string;
  count: number;
}

export interface MarketSnapshot {
  items: MarketItemView[];
  sources: MarketSourceStatus[];
  /** 数据来自旧 skill-hub.json（提示用户 registry.json 尚未创建） */
  legacySources?: boolean;
  errors: string[];
}

export interface MarketOptions extends SkillLayers {
  /** 测试注入用 fetch 实现；缺省用全局 fetch */
  fetchImpl?: typeof fetch;
}

function mcpNameSet(homeDir: string | undefined, projectRoot: string | undefined): { global: Set<string>; project: Set<string> } {
  const read = (scope: 'global' | 'project') => {
    try {
      return new Set(Object.keys(readMcpConfigFile({ scope, projectRoot, homeDir })));
    } catch {
      return new Set<string>();
    }
  };
  return {
    global: homeDir ? read('global') : new Set<string>(),
    project: projectRoot ? read('project') : new Set<string>(),
  };
}

/**
 * 合并内置清单 + 各订阅源为市场快照（离线降级：源失败仅提示，内置清单始终可用）。
 * 同名去重：内置优先，其后按 sources 配置顺序取第一个。
 */
export async function listMarketSnapshot(opts: MarketOptions): Promise<MarketSnapshot> {
  const { sources, legacy, error: sourcesError } = await readMarketSources(opts.homeDir);
  const errors: string[] = sourcesError ? [sourcesError] : [];
  const items: MarketItemView[] = [];
  const seen = new Set<string>();
  const sourceStatuses: MarketSourceStatus[] = [];

  const push = (entry: MarketEntry, source: string) => {
    const key = `${entry.kind}:${entry.name}`;
    if (seen.has(key)) {
      errors.push(`市场条目「${entry.name}」（${entry.kind}，源 ${source}）与既有条目同名，已跳过`);
      return;
    }
    seen.add(key);
    items.push({ entry, source, installedIn: {} });
  };

  for (const entry of builtinSkillEntries()) push(entry, 'builtin');
  for (const entry of builtinMcpEntries()) push(entry, 'builtin');

  const fetched = await Promise.all(
    sources.map(async (source) => ({ source, r: await fetchMarketSourceEntries(source, opts.fetchImpl) })),
  );
  for (const { source, r } of fetched) {
    sourceStatuses.push({
      name: source.name,
      url: source.url,
      kind: source.kind,
      status: r.status,
      ...(r.error ? { error: r.error } : {}),
      count: r.entries.length,
    });
    errors.push(...r.entryErrors);
    for (const entry of r.entries) push(entry, source.name);
  }

  // 已装检测：Skills 扫三层；MCP 查两个作用域 mcp.json 的名字
  const dirs = skillLayerDirs(opts);
  const scan: Array<{ layer: 'builtin' | 'user' | 'project'; dir: string | null }> = [
    { layer: 'builtin', dir: dirs.builtin },
    { layer: 'user', dir: dirs.user },
    { layer: 'project', dir: dirs.project },
  ];
  const installed = new Map<string, MarketItemView['installedIn']>();
  for (const { layer, dir } of scan) {
    if (!dir) continue;
    const { skills, errors: layerErrors } = await listLayerSkills(dir, layer);
    errors.push(...layerErrors);
    for (const s of skills) {
      const prev = installed.get(`skill:${s.name}`) ?? {};
      installed.set(`skill:${s.name}`, { ...prev, [layer]: true });
    }
  }
  const mcpNames = mcpNameSet(opts.homeDir, opts.projectRoot);
  for (const n of mcpNames.global) installed.set(`mcp:${n}`, { ...(installed.get(`mcp:${n}`) ?? {}), global: true });
  for (const n of mcpNames.project) installed.set(`mcp:${n}`, { ...(installed.get(`mcp:${n}`) ?? {}), project: true });
  for (const item of items) item.installedIn = installed.get(`${item.entry.kind}:${item.entry.name}`) ?? {};

  return { items, sources: sourceStatuses, ...(legacy ? { legacySources: true } : {}), errors };
}

/** 按 kind + source + name 定位单条完整条目；builtin 直取，订阅源实时拉取 */
export async function findMarketEntry(
  opts: MarketOptions,
  kind: MarketEntry['kind'],
  source: string,
  name: string,
): Promise<MarketEntry | null> {
  if (source === 'builtin') return findBuiltinMarketEntry(kind, name);
  const { sources } = await readMarketSources(opts.homeDir);
  const target = sources.find((s) => s.name === source && (s.kind === kind || (s.kind === 'skills' && kind === 'skill')));
  if (!target) return null;
  const { entries } = await fetchMarketSourceEntries(target, opts.fetchImpl);
  return entries.find((e) => e.kind === kind && e.name === name) ?? null;
}

// ── F-44 untrusted 口径：远程条目预览包裹 ───────────────────────────────────

/** 预览载荷：远程条目 description/body 经 wrapUntrusted 包裹（内置条目原样 + 标记来源） */
export function wrapMarketPreview(entry: MarketEntry, source: string): { description: string; body?: string } {
  const src = `market:${source}/${entry.name}`;
  if (entry.kind === 'skill') {
    return {
      description: wrapUntrusted(entry.description, src),
      body: wrapUntrusted(entry.body, src),
    };
  }
  return { description: wrapUntrusted(entry.description, src) };
}

// ── Skill 安装（含 scripts 闸门）────────────────────────────────────────────

export interface InstallSkillResult {
  status: 'scripts_required' | 'installed';
  /** status=scripts_required 时返回待确认脚本清单 */
  scripts?: MarketScript[];
  /** status=installed 时返回落盘路径与写入的脚本名 */
  path?: string;
  scriptsWritten?: string[];
}

/**
 * 安装 Skill 条目到 user/project 层：
 *  - scripts 非空且未确认 → 返回 scripts_required（调用方展示后带 confirmScripts 重调）；
 *  - 覆盖语义：目标层同名已存在时必须 force（先删后装，三层覆盖自动生效无需重启）。
 */
export async function installMarketSkill(
  entry: MarketEntry & { kind: 'skill' },
  opts: {
    layers: SkillLayers;
    scope: 'user' | 'project';
    force?: boolean;
    confirmScripts?: boolean;
  },
): Promise<InstallSkillResult> {
  const scripts = entry.scripts ?? [];
  if (scripts.length > 0 && !opts.confirmScripts) {
    return { status: 'scripts_required', scripts };
  }
  // 脚本名先整体校验：任一非法即整包拒绝，不落半装状态
  for (const s of scripts) {
    const invalid = validateScriptName(s.name);
    if (invalid) throw new Error(`脚本「${s.name}」${invalid}`);
  }

  const baseDir = opts.scope === 'user'
    ? userSkillsDir(opts.layers)
    : projectSkillsDir(opts.layers);
  const target = path.join(baseDir, entry.name);
  const exists = await fsp.access(target).then(() => true, () => false);
  if (exists && !opts.force) {
    throw new Error(`目标层已存在同名 Skill：${entry.name}（覆盖安装请加 --force）`);
  }
  if (exists) await deleteSkill(entry.name, opts.scope, opts.layers);

  const file = await writeSkill(entry.name, opts.scope, {
    description: entry.description,
    triggers: entry.triggers,
    toolsAllowlist: entry.toolsAllowlist,
    body: entry.body,
  }, opts.layers);

  const scriptsWritten: string[] = [];
  for (const s of scripts) {
    const dir = path.join(target, 'scripts');
    const dest = path.resolve(dir, s.name);
    if (!dest.startsWith(path.resolve(dir) + path.sep)) {
      throw new Error(`脚本路径越界，已中止：${s.name}`);
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, s.content, 'utf8');
    scriptsWritten.push(s.name);
  }

  return { status: 'installed', path: file, scriptsWritten };
}

function userSkillsDir(layers: SkillLayers): string {
  if (!layers.homeDir) throw new Error('用户层未启用（缺少 homeDir）');
  return path.join(userConfigDir(layers.homeDir), FILES.skillsDir);
}

function projectSkillsDir(layers: SkillLayers): string {
  if (!layers.projectRoot) throw new Error('项目级安装需要有效的项目根目录');
  return path.join(projectConfigDir(layers.projectRoot), FILES.skillsDir);
}

// ── MCP 连通性测试 + 安装 ───────────────────────────────────────────────────

export interface McpProbeResult {
  ok: boolean;
  toolCount?: number;
  error?: string;
}

/**
 * MCP 连通性测试：一次性 McpManager 连接 + listTools，总预算 15s（可注入）。
 * 纯探测：测完即断开，不写入任何配置。
 */
export async function testMcpConnectivity(
  draft: McpServerConfig,
  opts: { timeoutMs?: number } = {},
): Promise<McpProbeResult> {
  const mgr = new McpManager();
  const timeoutMs = opts.timeoutMs ?? MCP_PROBE_TIMEOUT_MS;
  try {
    const connect = mgr.connect('__market_probe__', draft).then(() => mgr.listTools('__market_probe__'));
    const tools = await Promise.race([
      connect,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`连通性测试超时（${timeoutMs / 1000}s）`)), timeoutMs)),
    ]);
    return { ok: true, toolCount: tools.length };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    await mgr.disconnectAll();
  }
}

export interface InstallMcpResult {
  status: 'connect_failed' | 'installed';
  toolCount?: number;
  path?: string;
  error?: string;
}

/**
 * MCP 一键安装：连通性测试通过才写入 mcp.json（headers 加密落盘）。
 * 测试失败不落盘，返回 connect_failed +「下一步」指引。
 */
export async function installMarketMcp(
  entry: MarketEntry & { kind: 'mcp' },
  opts: { homeDir?: string; projectRoot?: string; scope: 'global' | 'project'; probe?: typeof testMcpConnectivity },
): Promise<InstallMcpResult> {
  const probe = opts.probe ?? testMcpConnectivity;
  const r = await probe(entry.draft);
  if (!r.ok) {
    return {
      status: 'connect_failed',
      error: `${r.error ?? '连接失败'}。下一步：检查命令/URL/网络后重试，或用 delta mcp add 手工配置`,
    };
  }
  const servers = readMcpConfigFile({ scope: opts.scope, projectRoot: opts.projectRoot, homeDir: opts.homeDir });
  servers[entry.name] = {
    ...entry.draft,
    headers: encryptMcpHeaders(entry.draft.headers),
  };
  const file = saveMcpConfig(servers, { scope: opts.scope, projectRoot: opts.projectRoot, homeDir: opts.homeDir });
  return { status: 'installed', toolCount: r.toolCount, path: file };
}

// ── 卸载 ────────────────────────────────────────────────────────────────────

/** 卸载：skill 删对应层目录（builtin 拒绝）；mcp 从对应作用域 mcp.json 移除 */
export async function removeMarketItem(
  kind: 'skill' | 'mcp',
  name: string,
  scope: 'user' | 'project' | 'global',
  opts: SkillLayers,
): Promise<{ path: string }> {
  const invalid = validateConfigName(name);
  if (invalid) throw new Error(invalid);
  if (kind === 'skill') {
    if (scope === 'global') throw new Error('Skill 卸载 scope 必须是 user 或 project');
    await deleteSkill(name, scope, opts);
    return { path: `${scope} 层 ${FILES.skillsDir}/${name}` };
  }
  const mcpScope = scope === 'user' ? 'global' : scope; // mcp.json 口径：全局作用域叫 global
  const homeDir = scope === 'project' ? undefined : opts.homeDir;
  const servers = readMcpConfigFile({ scope: mcpScope, projectRoot: opts.projectRoot, homeDir });
  if (!(name in servers)) throw new Error(`${mcpScope === 'global' ? '全局' : '项目级'} mcp.json 中不存在：${name}`);
  delete servers[name];
  return { path: saveMcpConfig(servers, { scope: mcpScope, projectRoot: opts.projectRoot, homeDir }) };
}
