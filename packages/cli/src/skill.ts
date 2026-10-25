/**
 * `delta skill` 子命令组（Skill Hub 接入）：
 *  - search   从 Skill Hub 搜索技能（GET {hub}/api/v1/search）
 *  - install  安装到 user 层 `~/.delta/skills/`（默认）或项目层 `.delta/skills/`（--project）
 *  - list     本机已装 Skill（builtin / user / project 三层分组）
 *  - hub      查看 / 设置 / 重置 hub 地址（~/.delta/skill-hub.json）
 *
 * hub 地址解析优先级：--hub 参数 > 环境变量 DELTA_SKILL_HUB_URL > 配置文件 > 官方默认（api.skillhub.cn）。
 */
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_SKILL_HUB_BASE,
  SKILL_HUB_ENV,
  CONFIG_DIR,
  FILES,
  projectConfigDir,
  userConfigDir,
  discoverSkills,
  installHubSkill,
  resolveSkillHubBase,
  searchHubSkills,
  userSkillHubConfigPath,
  writeSkillHubUrl,
} from '@delta/core';

interface HubOpts {
  hub?: string;
}

/** 解析生效 hub 地址并附来源说明（失败直接进程级报错） */
function hubBase(opts: HubOpts): { base: string; source: string } {
  return resolveSkillHubBase({ flag: opts.hub });
}

/** 来源标识 → 中文展示（与 `skill hub get` 一致） */
function sourceLabel(source: string): string {
  switch (source) {
    case 'flag': return 'CLI 参数';
    case 'env': return `环境变量 ${SKILL_HUB_ENV}`;
    case 'config': return '配置文件';
    default: return '默认（未配置）';
  }
}

/** 截断描述用于列表展示（单行、限宽） */
function oneLine(s: string, max = 80): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** search：搜索 hub 上的技能 */
export async function skillSearchCommand(query: string[], opts: HubOpts): Promise<void> {
  const q = query.join(' ').trim();
  if (q === '') {
    console.error('✘ 请提供搜索词，例如：delta skill search git');
    process.exitCode = 1;
    return;
  }
  const { base, source } = hubBase(opts);
  try {
    const results = await searchHubSkills(base, q, { limit: 15 });
    console.log(`Skill Hub：${base}（来源：${sourceLabel(source)}）　搜索「${q}」命中 ${results.length} 条\n`);
    if (results.length === 0) {
      console.log('（无结果）换个关键词试试，或 `delta skill hub set <url>` 换源');
      return;
    }
    for (const s of results) {
      const dl = typeof s.downloads === 'number' ? `　⬇ ${s.downloads}` : '';
      const ver = s.version ? `@${s.version}` : '';
      console.log(`  ${s.slug}  ${s.displayName ?? s.name}${ver}${dl}`);
      const desc = s.descriptionZh ?? s.description;
      if (desc) console.log(`    ${oneLine(desc, 90)}`);
    }
    console.log('\n安装：delta skill install <slug>');
  } catch (e) {
    console.error(`✘ 搜索失败：${(e as Error).message}`);
    process.exitCode = 1;
  }
}

/** install：安装技能到 user / project 层 */
export async function skillInstallCommand(
  slug: string,
  opts: HubOpts & { project?: boolean; force?: boolean },
): Promise<void> {
  const { base, source } = hubBase(opts);
  const projectRoot = process.cwd();
  const targetDir = opts.project
    ? path.join(projectConfigDir(projectRoot), FILES.skillsDir)
    : path.join(userConfigDir(), FILES.skillsDir);
  try {
    const r = await installHubSkill(slug, {
      base,
      targetDir,
      force: opts.force,
      layer: opts.project ? 'project' : 'user',
    });
    console.log(`✔ 已安装 ${r.skill.name}（${r.files.length} 个文件）`);
    console.log(`  目录：${r.dir}`);
    console.log(`  Hub ：${base}（来源：${sourceLabel(source)}）`);
    console.log('  即刻生效：三层加载器会自动发现，无需重启');
  } catch (e) {
    console.error(`✘ 安装失败：${(e as Error).message}`);
    process.exitCode = 1;
  }
}

/** list：本机已装技能（三层分组） */
export async function skillListCommand(): Promise<void> {
  const { skills, errors } = await discoverSkills({
    projectRoot: process.cwd(),
    homeDir: os.homedir(),
  });
  const layers = ['builtin', 'user', 'project'] as const;
  const labels: Record<(typeof layers)[number], string> = {
    builtin: '内置（packages/core/skills）',
    user: `用户级（${path.join(userConfigDir(), FILES.skillsDir)}）`,
    project: `项目级（${path.join(projectConfigDir(process.cwd()), FILES.skillsDir)}）`,
  };
  for (const layer of layers) {
    const group = skills.filter((s) => s.layer === layer);
    console.log(`\n${labels[layer]}：${group.length} 个`);
    for (const s of group) console.log(`  ${s.name.padEnd(20)} ${oneLine(s.description, 70)}`);
  }
  for (const err of errors) console.error(`⚠ ${err}`);
}

/** hub get：查看生效 hub 地址与来源 */
export function skillHubGetCommand(): void {
  const { base, source } = resolveSkillHubBase({});
  console.log(`当前 Skill Hub：${base}`);
  console.log(`来源：${source === 'default' ? '默认（未配置）' : source}`);
  console.log(`配置文件：${userSkillHubConfigPath()}（url 字段）`);
  console.log(`环境变量：${SKILL_HUB_ENV}（优先级高于配置文件）`);
  console.log(`官方默认：${DEFAULT_SKILL_HUB_BASE}`);
}

/** hub set：持久化 hub 地址（只改 url 字段，其余保留） */
export function skillHubSetCommand(url: string): void {
  try {
    const r = writeSkillHubUrl(url);
    console.log(`✔ Skill Hub 已设置为 ${url}`);
    console.log(`  写入：${r.path}`);
  } catch (e) {
    console.error(`✘ ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

/** hub reset：清除配置，恢复官方默认 */
export function skillHubResetCommand(): void {
  try {
    const r = writeSkillHubUrl(null);
    console.log(`✔ 已恢复官方默认 ${DEFAULT_SKILL_HUB_BASE}`);
    console.log(`  清除：${r.path} 的 url 字段（其余字段保留）`);
  } catch (e) {
    console.error(`✘ ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
