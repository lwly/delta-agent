/**
 * F-39 专家包解析（纯函数、零 IO）
 *
 * 输入由 ExpertStore 读好后传入，因此 100% 可单测。
 * 校验链顺序固定（design §6.1），任一失败即整包失败；成员级 md 失败只剔该成员。
 */
import * as path from 'node:path';
import { parseFrontmatter } from '../skills/loader.js';
import { estimateTextTokens } from '../context/tokens.js';
import {
  AGENT_ID_PATTERN,
  EXPERT_BODY_MAX_CHARS,
  EXPERT_NAME_PATTERN,
  MAX_TEAM_MEMBERS,
  type ExpertAgent,
  type ExpertLayer,
  type ExpertMember,
  type ExpertPackage,
  type ExpertRecord,
  type LocalizedText,
} from './types.js';

/** expert.json 体积上限（超出即整包失败） */
export const EXPERT_JSON_MAX_BYTES = 64 * 1024;
/** 单个 agent md 体积上限 */
export const AGENT_MD_MAX_BYTES = 200 * 1024;

export interface ParseInput {
  /** 包目录绝对路径（仅用于路径拼接与留档，不读盘） */
  dir: string;
  layer: ExpertLayer;
  /** 目录名（覆盖键） */
  name: string;
  /** expert.json 原文 */
  expertJson: string;
  /** agents 目录下的文件名 → 原文（仅包含 expert.json 声明过的 md） */
  agentFiles: Map<string, { raw: string; absPath: string }>;
  /** 头像绝对路径（已由 store 做体积/扩展名校验）；null = 无 */
  avatarPath: string | null;
}

/**
 * 包名校验：合法返回 null，非法返回原因（PRD §6.4.2）。
 * `^[a-z][a-z0-9-]{1,39}$`
 */
export function validateExpertName(name: string): string | null {
  if (!name) return '包名不能为空';
  if (!EXPERT_NAME_PATTERN.test(name)) {
    return `包名 ${name} 非法：需匹配 ${EXPERT_NAME_PATTERN.source}（小写字母开头，2–40 位小写字母/数字/连字符）`;
  }
  return null;
}

/**
 * 保留标记转义（幂等）：避免专家正文伪造 prompt 段结构或覆盖身份层。
 * 只处理行首标题形态的 `# L1`，普通正文里的 `L1` 不受影响。
 */
export function escapeReservedMarkers(text: string): string {
  return text
    .replace(/<static>/gi, '＜static＞')
    .replace(/<\/static>/gi, '＜/static＞')
    .replace(/<dynamic>/gi, '＜dynamic＞')
    .replace(/<\/dynamic>/gi, '＜/dynamic＞')
    .replace(/^(\s*)#{1,6}\s*L([1-7])\b/gm, '$1＃ L$2');
}

/** 包内相对路径解析：拒绝绝对路径与 `..` 越界（符号链接由 store 在 IO 侧拦截） */
export function resolveInPackage(dir: string, rel: string): string {
  if (!rel) throw new Error('路径不能为空');
  if (path.isAbsolute(rel)) throw new Error(`不允许绝对路径：${rel}`);
  const base = path.resolve(dir);
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`路径越界（包外）：${rel}`);
  }
  return abs;
}

/**
 * 解析一个专家包。失败抛 Error（消息即 errors 文案）；
 * 成员级失败通过 `warnings` 回传并剔除该成员。
 */
export function parseExpertPackage(input: ParseInput, warnings: string[] = []): ExpertRecord {
  const { name, layer, dir } = input;

  // ① 包名
  const nameError = validateExpertName(name);
  if (nameError) throw new Error(nameError);

  // ① json 体积 + 语法
  if (Buffer.byteLength(input.expertJson, 'utf-8') > EXPERT_JSON_MAX_BYTES) {
    throw new Error(`expert.json 超过上限 ${EXPERT_JSON_MAX_BYTES / 1024}KB`);
  }
  let pkg: ExpertPackage;
  try {
    pkg = JSON.parse(input.expertJson) as ExpertPackage;
  } catch (e) {
    throw new Error(`expert.json 不是合法 JSON：${(e as Error).message}`);
  }
  if (!pkg || typeof pkg !== 'object') throw new Error('expert.json 顶层必须是对象');

  // ② expertType
  const expertType = pkg.expertType;
  if (expertType !== 'agent' && expertType !== 'team') {
    throw new Error(`expertType 非法：${String(expertType)}（只允许 agent / team）`);
  }

  // ③ agents[] 存在、路径合法、文件在读入集合内
  const agents = Array.isArray(pkg.agents) ? pkg.agents : [];
  if (agents.length === 0) throw new Error('缺少 agents 字段（至少声明 1 个 agent md）');
  const agentIds: string[] = [];
  for (const rel of agents) {
    if (typeof rel !== 'string') throw new Error('agents[] 只能包含字符串路径');
    resolveInPackage(dir, rel); // 绝对路径 / .. 越界 → 抛错
    if (!/^agents[/\\][^/\\]+\.md$/.test(rel)) {
      throw new Error(`agents[] 只允许 agents/<file>.md 形式：${rel}`);
    }
    const file = path.basename(rel);
    const entry = input.agentFiles.get(file);
    if (!entry) throw new Error(`agents[] 声明的文件不存在：${rel}`);
    if (Buffer.byteLength(entry.raw, 'utf-8') > AGENT_MD_MAX_BYTES) {
      throw new Error(`agent md 超过上限 ${AGENT_MD_MAX_BYTES / 1024}KB：${rel}`);
    }
    agentIds.push(file.replace(/\.md$/, ''));
  }

  // ⑤ 展示字段
  const displayName = requireLocalized(pkg.displayName, 'displayName');
  const profession = requireLocalized(pkg.profession, 'profession');
  const description = typeof pkg.description === 'string' ? pkg.description : '';

  // ④ agentName 必须命中 agents[]
  const agentName = typeof pkg.agentName === 'string' ? pkg.agentName : '';
  if (!agentName) throw new Error('缺少 agentName 字段');
  if (!agentIds.includes(agentName)) {
    throw new Error(`agentName ${agentName} 不在 agents[] 中（可选：${agentIds.join(', ')}）`);
  }

  // ⑩ 解析每个 agent md（主 agent 失败 = 整包失败；成员失败 = 剔除 + warning）
  const agentMap = new Map<string, ExpertAgent>();
  for (const id of agentIds) {
    const entry = input.agentFiles.get(`${id}.md`);
    if (!entry) continue; // 前面已校验存在
    try {
      agentMap.set(id, parseAgentMarkdown(entry.raw, id));
    } catch (e) {
      if (id === agentName) throw new Error(`主 agent ${id} 解析失败：${(e as Error).message}`);
      warnings.push(`${layer}/${name}: 成员 ${id} 解析失败（${(e as Error).message}），已忽略`);
    }
  }
  const mainAgent = agentMap.get(agentName);
  if (!mainAgent) throw new Error(`主 agent ${agentName} 解析失败`);

  // ⑥ 团队结构校验
  let members: ExpertMember[] = [];
  if (expertType === 'team') {
    const rawMembers = Array.isArray(pkg.members) ? pkg.members : [];
    if (rawMembers.length === 0) throw new Error('团队专家缺少 members 字段');
    if (rawMembers.length > MAX_TEAM_MEMBERS) {
      throw new Error(`团队成员数 ${rawMembers.length} 超过上限 ${MAX_TEAM_MEMBERS}`);
    }
    const leads = rawMembers.filter((m) => m.role === 'lead');
    if (leads.length !== 1) throw new Error(`团队必须恰好 1 个 role=lead 的成员（当前 ${leads.length} 个）`);

    const memberIds = rawMembers.map((m) => (typeof m.id === 'string' ? m.id : ''));
    for (const id of memberIds) {
      if (!AGENT_ID_PATTERN.test(id)) {
        throw new Error(`成员 id ${id} 非法：需匹配 ${AGENT_ID_PATTERN.source}`);
      }
      if (!agentIds.includes(id)) throw new Error(`members[].id ${id} 未在 agents[] 中声明`);
    }
    // teamInfo 与 members 双向一一对应
    if (!pkg.teamInfo || typeof pkg.teamInfo !== 'object') throw new Error('团队专家缺少 teamInfo');
    if (pkg.teamInfo.leadAgent !== agentName) {
      throw new Error(`teamInfo.leadAgent（${pkg.teamInfo.leadAgent}）必须等于 agentName（${agentName}）`);
    }
    const infoMembers = Array.isArray(pkg.teamInfo.memberAgents) ? pkg.teamInfo.memberAgents : [];
    if (!sameSet(infoMembers, memberIds)) {
      throw new Error('teamInfo.memberAgents 与 members[].id 不是一一对应');
    }

    members = [];
    for (const m of rawMembers) {
      const agent = agentMap.get(m.id);
      if (!agent) continue; // 成员 md 解析失败 → 前面已 warning
      members.push({
        ...agent,
        // members[] 是成员视图的权威来源（UI/委派展示）；md frontmatter 只作回退
        displayName: optionalLocalized(m.name) ?? agent.displayName,
        profession: optionalLocalized(m.profession) ?? agent.profession,
        role: m.role,
        avatarPath: m.avatar ? safeJoin(dir, m.avatar) : null,
      });
    }
    if (members.length === 0) throw new Error('团队成员全部解析失败');
    if (!members.some((m) => m.role === 'lead')) {
      throw new Error(`主理人 ${agentName} 的 md 解析失败，团队不可用`);
    }
  } else if (pkg.members !== undefined) {
    // 单人专家出现 members → 宽容忽略（design §2.7-a）
    warnings.push(`${layer}/${name}: 单人专家忽略 members 字段`);
  }

  // ⑧ 团队主理人文件名必须带团队前缀
  if (expertType === 'team' && !agentName.startsWith(`${name}-`)) {
    throw new Error(`团队主理人文件名必须带团队前缀 ${name}-（当前 ${agentName}）`);
  }

  // 头像（包级）：store 已校验，这里只做包内路径确认
  const avatarPath = input.avatarPath ? safeJoin(dir, path.relative(dir, input.avatarPath)) : null;

  return {
    name,
    version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
    description,
    author: { name: typeof pkg.author?.name === 'string' ? pkg.author.name : 'unknown', ...(pkg.author?.email ? { email: pkg.author.email } : {}) },
    expertType,
    displayName,
    profession,
    layer,
    dir,
    avatarPath,
    skills: stringList(pkg.skills),
    tools: Array.isArray(pkg.tools) ? stringList(pkg.tools) : null,
    keywords: stringList(pkg.keywords),
    categoryId: typeof pkg.categoryId === 'string' ? pkg.categoryId : null,
    dependencies: { mcpServers: stringList(pkg.dependencies?.mcpServers) },
    agent: mainAgent,
    members,
    promptStats: {
      chars: mainAgent.body.length,
      tokens: estimateTextTokens(mainAgent.body),
      truncated: mainAgent.body.length > EXPERT_BODY_MAX_CHARS,
    },
  };
}

/** 解析单个 agent md（frontmatter + 正文）；失败抛错 */
export function parseAgentMarkdown(raw: string, idHint: string): ExpertAgent {
  const { frontmatter, body } = parseFrontmatter(raw);
  const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  if (!name) throw new Error('frontmatter 缺少 name');
  if (name !== idHint) throw new Error(`frontmatter.name（${name}）必须等于文件名（${idHint}）`);
  if (!AGENT_ID_PATTERN.test(name)) {
    throw new Error(`id ${name} 非法：需匹配 ${AGENT_ID_PATTERN.source}（不允许 ] / 空格 / 全角标点）`);
  }
  if (frontmatter.expertType !== undefined) {
    throw new Error('agent md 不允许声明 expertType（禁止嵌套团队）');
  }
  const maxTurnsRaw = frontmatter.maxTurns;
  const maxTurns =
    typeof maxTurnsRaw === 'string' && maxTurnsRaw.trim() !== '' && Number.isFinite(Number(maxTurnsRaw))
      ? Number(maxTurnsRaw)
      : undefined;

  return {
    id: name,
    description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
    displayName: localizedFromFrontmatter(frontmatter, 'displayName') ?? { en: name, zh: name },
    profession: localizedFromFrontmatter(frontmatter, 'profession') ?? { en: '', zh: '' },
    body: body.trim(),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    skills: stringList(frontmatter.skills),
    tools: stringList(frontmatter.tools),
  };
}

function requireLocalized(value: unknown, field: string): LocalizedText {
  if (!value || typeof value !== 'object') throw new Error(`缺少 ${field} 字段（需 {en, zh}）`);
  const v = value as Record<string, unknown>;
  const en = typeof v['en'] === 'string' ? v['en'] : '';
  const zh = typeof v['zh'] === 'string' ? v['zh'] : '';
  if (!en && !zh) throw new Error(`${field} 必须至少包含 en 或 zh`);
  return { en: en || zh, zh: zh || en };
}

/**
 * frontmatter 双语字段：支持两种写法（极简 YAML 解析器不支持嵌套对象）
 *   displayName: 代码架构师            → en/zh 同值
 *   displayName_zh: 代码架构师         → 分语言
 *   displayName_en: Code Architect
 */
function localizedFromFrontmatter(
  frontmatter: Record<string, string | string[]>,
  key: string,
): LocalizedText | undefined {
  const zh = frontmatter[`${key}_zh`];
  const en = frontmatter[`${key}_en`];
  if (typeof zh === 'string' || typeof en === 'string') {
    const zhText = typeof zh === 'string' ? zh.trim() : '';
    const enText = typeof en === 'string' ? en.trim() : '';
    if (!zhText && !enText) return undefined;
    return { en: enText || zhText, zh: zhText || enText };
  }
  return optionalLocalized(frontmatter[key]);
}

/** frontmatter 里的 `displayName: 中文名`（字符串）也接受：视为 zh */
function optionalLocalized(value: unknown): LocalizedText | undefined {
  if (typeof value === 'string' && value.trim()) return { en: value.trim(), zh: value.trim() };
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    const en = typeof v['en'] === 'string' ? v['en'] : '';
    const zh = typeof v['zh'] === 'string' ? v['zh'] : '';
    if (!en && !zh) return undefined;
    return { en: en || zh, zh: zh || en };
  }
  return undefined;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

/** 包内路径 → 绝对路径（越界返回 null，不抛错：成员头像属可选装饰） */
function safeJoin(dir: string, rel: string): string | null {
  try {
    return resolveInPackage(dir, rel);
  } catch {
    return null;
  }
}
