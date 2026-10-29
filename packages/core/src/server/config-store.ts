/**
 * Skills / MCP 配置文件存取（设置中心 Skills / MCP 面板的后端）。
 *
 * Skills：三层目录（builtin 只读 / 用户级 <home>/.delta/skills / 项目级 <root>/.delta/skills），
 *         每个 Skill 为「目录/SKILL.md（frontmatter + 主体）」，写端只开放用户级与项目级。
 * MCP：  ~/.delta/mcp.json（全局）与 <root>/.delta/mcp.json（项目级，同名覆盖），
 *         形如 { "mcpServers": { "<name>": { command, args?, env?, timeoutMs? } } }。
 *
 * 安全边界：名称白名单校验 + 写入目标必须落在对应层根目录内（防路径逃逸）；
 * 内置层一律拒绝写删。
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { defaultBuiltinSkillsDir, readSkillDir, type SkillLayer, type SkillMeta } from '../skills/loader.js';
import { FILES, projectConfigDir, userConfigDir } from '../paths.js';
import { encryptMcpHeaders } from '../mcp/client.js';

/** 合法 Skill / MCP server 名称：字母数字开头，允许 - _ ，2–64 字符 */
export function validateConfigName(name: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/.test(name)) {
    return '名称仅允许字母数字与 - _，以字母数字开头，长度 2–64';
  }
  return null;
}

/** 安全拼接：确保 result 落在 base 内（两端 resolve 后比较前缀），否则抛错 */
function safeJoin(base: string, ...segs: string[]): string {
  const result = path.resolve(base, ...segs);
  const normalizedBase = path.resolve(base);
  if (result !== normalizedBase && !result.startsWith(normalizedBase + path.sep)) {
    throw new Error(`路径越界：${segs.join('/')}`);
  }
  return result;
}

export interface SkillLayers {
  /** 用户主目录（~）；缺省不启用用户层 */
  homeDir?: string;
  /** 项目根；缺省不启用项目层 */
  projectRoot?: string;
}

function skillBaseDir(scope: 'user' | 'project', layers: SkillLayers): string {
  if (scope === 'user') {
    if (!layers.homeDir) throw new Error('用户层未启用');
    return safeJoin(userConfigDir(layers.homeDir), FILES.skillsDir);
  }
  if (!layers.projectRoot) throw new Error('项目级 Skill 需要有效的项目');
  return safeJoin(projectConfigDir(layers.projectRoot), FILES.skillsDir);
}

/** 序列化 SKILL.md：frontmatter（description/triggers/tools_allowlist）+ 主体 */
export function serializeSkillMd(input: {
  description: string;
  triggers: string[];
  toolsAllowlist: string[];
  body: string;
}): string {
  const lines = ['---', `description: ${input.description || '（待补充）'}`];
  if (input.triggers.length > 0) {
    lines.push('triggers:');
    for (const t of input.triggers) lines.push(`  - ${t}`);
  }
  if (input.toolsAllowlist.length > 0) {
    lines.push('tools_allowlist:');
    for (const t of input.toolsAllowlist) lines.push(`  - ${t}`);
  }
  lines.push('---', '', input.body.trim(), '');
  return lines.join('\n');
}

/** 写入（新建或覆盖）一个用户级/项目级 Skill：返回落盘路径 */
export async function writeSkill(
  name: string,
  scope: 'user' | 'project',
  input: { description: string; triggers: string[]; toolsAllowlist: string[]; body: string },
  layers: SkillLayers,
): Promise<string> {
  const invalid = validateConfigName(name);
  if (invalid) throw new Error(invalid);
  const base = skillBaseDir(scope, layers);
  const dir = safeJoin(base, name);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  await fsp.writeFile(file, serializeSkillMd(input), 'utf8');
  return file;
}

/** 删除一个用户级/项目级 Skill 目录（内置层不可删） */
export async function deleteSkill(
  name: string,
  scope: 'user' | 'project',
  layers: SkillLayers,
): Promise<void> {
  const invalid = validateConfigName(name);
  if (invalid) throw new Error(invalid);
  const base = skillBaseDir(scope, layers);
  const dir = safeJoin(base, name);
  try {
    await fsp.access(dir);
  } catch {
    throw new Error(`${scope} 层不存在 Skill：${name}`);
  }
  await fsp.rm(dir, { recursive: true, force: true });
}

// ── Skills 分层列举（设置面板用：逐层原始发现，供展示同名覆盖关系）─────────

/** 三层根目录（builtin 用包内置目录；user/project 未启用时为 null） */
export function skillLayerDirs(layers: SkillLayers): { builtin: string; user: string | null; project: string | null } {
  return {
    builtin: defaultBuiltinSkillsDir(),
    user: layers.homeDir ? path.join(userConfigDir(layers.homeDir), FILES.skillsDir) : null,
    project: layers.projectRoot ? path.join(projectConfigDir(layers.projectRoot), FILES.skillsDir) : null,
  };
}

/** 单层目录扫描：目录不存在返回空；单个包解析失败记入 errors 不阻塞其他包 */
export async function listLayerSkills(dir: string, layer: SkillLayer): Promise<{ skills: SkillMeta[]; errors: string[] }> {
  const errors: string[] = [];
  let entries: string[];
  try {
    entries = await fsp
      .readdir(dir, { withFileTypes: true })
      .then((list) => list.filter((e) => e.isDirectory()).map((e) => e.name));
  } catch {
    return { skills: [], errors };
  }
  const skills: SkillMeta[] = [];
  for (const name of entries) {
    try {
      skills.push(await readSkillDir(path.join(dir, name), layer, name));
    } catch (e) {
      errors.push(`${layer}/${name}: ${(e as Error).message}`);
    }
  }
  return { skills, errors };
}

// ── MCP 配置（mcp.json 读写）────────────────────────────────────────────────

export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  /** streamable HTTP 端点（F-48）：与 command 二选一 */
  url?: string;
  /** F-48 HTTP 鉴权头；写入时明文值统一加密为 enc:v1: 密文 */
  headers?: Record<string, string>;
}

export interface McpFileState {
  path: string;
  exists: boolean;
  parseError?: string;
  servers: Record<string, McpServerEntry>;
}

export interface McpConfigSnapshot {
  global: McpFileState;
  project: McpFileState | null;
  /** 合并视图（项目覆盖全局），值附带 __source 供界面标注来源 */
  merged: Record<string, McpServerEntry & { __source: 'global' | 'project' }>;
}

function mcpFilePath(scope: 'global' | 'project', layers: SkillLayers): string {
  if (scope === 'global') {
    if (!layers.homeDir) throw new Error('全局配置未启用');
    return safeJoin(userConfigDir(layers.homeDir), FILES.mcp);
  }
  if (!layers.projectRoot) throw new Error('项目级 MCP 配置需要有效的项目');
  return safeJoin(projectConfigDir(layers.projectRoot), FILES.mcp);
}

async function readMcpFile(file: string): Promise<McpFileState> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return { path: file, exists: false, servers: {} };
  }
  try {
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerEntry> };
    return { path: file, exists: true, servers: parsed.mcpServers ?? {} };
  } catch (e) {
    return { path: file, exists: true, parseError: (e as Error).message, servers: {} };
  }
}

/** 读取全局 + 项目两级 mcp.json 原始内容与合并视图（不抛错：解析失败进 parseError） */
export async function readMcpConfigs(layers: SkillLayers): Promise<McpConfigSnapshot> {
  const global = await readMcpFile(mcpFilePath('global', layers));
  const project = layers.projectRoot ? await readMcpFile(mcpFilePath('project', layers)) : null;
  const merged: McpConfigSnapshot['merged'] = {};
  for (const [name, cfg] of Object.entries(global.servers)) merged[name] = { ...cfg, __source: 'global' };
  if (project) {
    for (const [name, cfg] of Object.entries(project.servers)) {
      merged[name] = { ...cfg, __source: 'project' };
    }
  }
  return { global, project, merged };
}

/** 校验待写入的 mcpServers 形状：command（stdio）与 url（streamable HTTP）二选一；
 *  header 明文值写入前统一加密（F-48：明文不落盘）。 */
export function validateMcpServers(servers: unknown): Record<string, McpServerEntry> {
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    throw new Error('mcpServers 必须是对象');
  }
  const out: Record<string, McpServerEntry> = {};
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    const invalid = validateConfigName(name);
    if (invalid) throw new Error(`服务器「${name}」：${invalid}`);
    if (typeof raw !== 'object' || raw === null) throw new Error(`服务器「${name}」：配置必须是对象`);
    const cfg = raw as Record<string, unknown>;
    const hasCommand = typeof cfg.command === 'string' && cfg.command.trim() !== '';
    const hasUrl = typeof cfg.url === 'string' && cfg.url.trim() !== '';
    if (hasCommand === hasUrl) {
      throw new Error(`服务器「${name}」：command（stdio）与 url（streamable HTTP）必须二选一`);
    }
    const entry: McpServerEntry = hasCommand
      ? { command: (cfg.command as string).trim() }
      : { url: (cfg.url as string).trim() };
    if (hasCommand && Array.isArray(cfg.args)) {
      entry.args = cfg.args.map((a) => String(a));
    } else if (hasCommand && cfg.args !== undefined && !Array.isArray(cfg.args)) {
      throw new Error(`服务器「${name}」：args 必须是字符串数组`);
    }
    if (hasCommand && cfg.env !== undefined) {
      if (typeof cfg.env !== 'object' || cfg.env === null) throw new Error(`服务器「${name}」：env 必须是对象`);
      entry.env = Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, String(v)]));
    }
    if (cfg.headers !== undefined) {
      if (typeof cfg.headers !== 'object' || cfg.headers === null || Array.isArray(cfg.headers)) {
        throw new Error(`服务器「${name}」：headers 必须是对象`);
      }
      if (hasCommand) throw new Error(`服务器「${name}」：headers 仅 streamable HTTP（url）传输支持`);
      entry.headers = encryptMcpHeaders(
        Object.fromEntries(Object.entries(cfg.headers).map(([k, v]) => [k, String(v)])),
      );
    }
    if (cfg.timeoutMs !== undefined && cfg.timeoutMs !== null) {
      const n = Number(cfg.timeoutMs);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`服务器「${name}」：timeoutMs 必须是正数`);
      entry.timeoutMs = Math.round(n);
    }
    out[name] = entry;
  }
  return out;
}

/** 整体写入某作用域的 mcpServers（覆盖该文件；另一作用域不受影响） */
export async function writeMcpServers(
  scope: 'global' | 'project',
  servers: Record<string, McpServerEntry>,
  layers: SkillLayers,
): Promise<string> {
  const file = mcpFilePath(scope, layers);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, 'utf8');
  return file;
}
