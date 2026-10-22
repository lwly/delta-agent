/**
 * Skill 三层加载器（agent-modes-design.md §7.1/§7.2）
 *
 * 优先级（同名高层覆盖低层）：
 *   3（最高）项目级  .y-zero/skills/
 *   2        用户级  ~/.y-zero/skills/
 *   1（最低）内置    packages/core/skills/
 *
 * 包结构：SKILL.md（frontmatter + 主体指令）/ references/（按需读取）/ scripts/
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export type SkillLayer = 'builtin' | 'user' | 'project';

export interface SkillMeta {
  name: string;
  description: string;
  triggers: string[];
  /** 工具白名单子集（隔离：Skills 不能新增危险能力） */
  toolsAllowlist: string[];
  /** 来源层级（同名覆盖后保留最高层的 layer 标记） */
  layer: SkillLayer;
  /** SKILL.md 所在目录（绝对路径） */
  dir: string;
  /** SKILL.md 主体指令（frontmatter 之后的 Markdown） */
  body: string;
  /** references/ 目录下的文件名列表（大文档，按需读取） */
  references: string[];
}

export interface DiscoverOptions {
  /** 项目根目录（扫描 <root>/.y-zero/skills/）；缺省跳过项目层 */
  projectRoot?: string;
  /** 用户主目录（扫描 <home>/.y-zero/skills/）；缺省跳过用户层 */
  homeDir?: string;
  /** 内置 Skills 目录；缺省用包根 skills/ */
  builtinDir?: string;
}

/** 内置 Skills 默认目录：packages/core/skills/（src 与 dist 下均向上两级） */
export function defaultBuiltinSkillsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills');
}

/**
 * 三层发现 + 同名覆盖合并。
 * 单个 Skill 包解析失败不阻塞其他包（跳过并记入 errors）。
 */
export async function discoverSkills(
  opts: DiscoverOptions = {},
): Promise<{ skills: SkillMeta[]; errors: string[] }> {
  const layers: Array<{ layer: SkillLayer; dir?: string }> = [
    { layer: 'builtin', dir: opts.builtinDir ?? defaultBuiltinSkillsDir() },
    { layer: 'user', dir: opts.homeDir ? path.join(opts.homeDir, '.y-zero', 'skills') : undefined },
    { layer: 'project', dir: opts.projectRoot ? path.join(opts.projectRoot, '.y-zero', 'skills') : undefined },
  ];

  const errors: string[] = [];
  const byName = new Map<string, SkillMeta>();

  for (const { layer, dir } of layers) {
    if (!dir) continue;
    let entries: string[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true }).then((list) =>
        list.filter((e) => e.isDirectory()).map((e) => e.name),
      );
    } catch {
      continue; // 目录不存在 → 该层无 Skills
    }
    for (const name of entries) {
      const skillDir = path.join(dir, name);
      try {
        const skill = await readSkillDir(skillDir, layer, name);
        byName.set(name, skill); // 高层覆盖低层（遍历顺序 builtin→user→project）
      } catch (e) {
        errors.push(`${layer}/${name}: ${(e as Error).message}`);
      }
    }
  }

  return { skills: [...byName.values()], errors };
}

/** 读取单个 Skill 目录：解析 SKILL.md + 列出 references/ */
export async function readSkillDir(
  skillDir: string,
  layer: SkillLayer,
  dirName: string,
): Promise<SkillMeta> {
  const raw = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8');
  const { frontmatter, body } = parseFrontmatter(raw);

  const name = str(frontmatter.name) || dirName;
  const description = str(frontmatter.description) ?? '';
  const triggers = list(frontmatter.triggers);
  const toolsAllowlist = list(frontmatter.tools_allowlist);

  let references: string[] = [];
  try {
    const refs = await fs.readdir(path.join(skillDir, 'references'), { withFileTypes: true });
    references = refs.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    // 无 references/ 目录 → 空索引
  }

  return { name, description, triggers, toolsAllowlist, layer, dir: skillDir, body, references };
}

/**
 * 极简 frontmatter 解析（YAML 子集）：
 *   key: value ｜ key: [a, b] ｜ key: 换行 + "  - item" 块列表
 * 不依赖 yaml 库；遇到不支持语法按原样存字符串。
 */
export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, string | string[]>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { frontmatter: {}, body: raw.trim() };

  const frontmatter: Record<string, string | string[]> = {};
  const lines = match[1]!.split(/\r?\n/);
  let currentKey = '';
  for (const line of lines) {
    const blockItem = /^ {2}- (.*)$/.exec(line);
    if (blockItem && currentKey) {
      const arr = Array.isArray(frontmatter[currentKey]) ? (frontmatter[currentKey] as string[]) : [];
      if (!Array.isArray(frontmatter[currentKey])) frontmatter[currentKey] = arr;
      arr.push(unescapeScalar(blockItem[1]!));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    currentKey = kv[1]!;
    const value = kv[2]!.trim();
    if (value === '') {
      frontmatter[currentKey] = []; // 可能是块列表起点
    } else if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      frontmatter[currentKey] = inner === '' ? [] : inner.split(',').map((s) => unescapeScalar(s.trim()));
    } else {
      frontmatter[currentKey] = unescapeScalar(value);
    }
  }
  return { frontmatter, body: match[2]!.trim() };
}

function unescapeScalar(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

function str(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function list(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.length > 0) return [v];
  return [];
}
