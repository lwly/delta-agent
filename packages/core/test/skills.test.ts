import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { discoverSkills, parseFrontmatter, defaultBuiltinSkillsDir } from '../src/skills/loader.js';
import { tokenize, scoreSkill, matchSkills, suggestSkill, MATCH_THRESHOLD } from '../src/skills/matcher.js';
import { SkillBuffer, renderSkillContent } from '../src/skills/buffer.js';
import { loadSkillTool, unloadSkillTool } from '../src/tools/builtin/skill.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolContext, SkillRuntime } from '../src/tools/types.js';
import type { SkillMeta } from '../src/skills/loader.js';
import type { ToolCall } from '@y-zero/shared';

let tmp = '';
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-skills-'));
});

async function writeSkill(
  root: string,
  name: string,
  frontmatter: string,
  body = '主体指令',
): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\n${frontmatter}\n---\n${body}\n`,
    'utf-8',
  );
  return dir;
}

const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: `c_${Math.random().toString(36).slice(2, 6)}`,
  name,
  argsJson: JSON.stringify(args),
  args,
});

function meta(over: Partial<SkillMeta> = {}): SkillMeta {
  return {
    name: 'commit-review',
    description: '审查当前未提交变更并生成规范 commit message',
    triggers: ['审查提交', 'review commit'],
    toolsAllowlist: ['read_file', 'run_command'],
    layer: 'builtin',
    dir: '/tmp/x/commit-review',
    body: '# Commit 审查流程\n1. 查看 diff',
    references: ['checklist.md', 'style.md'],
    ...over,
  };
}

describe('parseFrontmatter（YAML 子集）', () => {
  it('解析标量 / 内联数组 / 块列表', () => {
    const { frontmatter, body } = parseFrontmatter(
      '---\nname: commit-review\ndescription: "审查提交"\ntriggers:\n  - 审查提交\n  - review commit\ntools_allowlist: [read_file, run_command]\n---\n正文内容',
    );
    expect(frontmatter.name).toBe('commit-review');
    expect(frontmatter.description).toBe('审查提交');
    expect(frontmatter.triggers).toEqual(['审查提交', 'review commit']);
    expect(frontmatter.tools_allowlist).toEqual(['read_file', 'run_command']);
    expect(body).toBe('正文内容');
  });

  it('无 frontmatter 时全文作为 body', () => {
    const { frontmatter, body } = parseFrontmatter('直接正文');
    expect(frontmatter).toEqual({});
    expect(body).toBe('直接正文');
  });
});

describe('discoverSkills 三层覆盖', () => {
  it('同名 Skill：项目级 > 用户级 > 内置；来源层级标注正确', async () => {
    const builtin = await writeSkill(
      path.join(tmp, 'builtin'), 'commit-review', 'name: commit-review\ndescription: 内置版',
      '内置主体',
    );
    const user = await writeSkill(
      path.join(tmp, 'home', '.y-zero', 'skills'), 'commit-review', 'name: commit-review\ndescription: 用户版',
      '用户主体',
    );
    const project = await writeSkill(
      path.join(tmp, 'proj', '.y-zero', 'skills'), 'commit-review', 'name: commit-review\ndescription: 项目版',
      '项目主体',
    );
    const onlyUser = await writeSkill(
      path.join(tmp, 'home', '.y-zero', 'skills'), 'user-only', 'name: user-only\ndescription: 仅用户层',
    );

    const { skills, errors } = await discoverSkills({
      builtinDir: path.dirname(builtin),
      homeDir: path.join(tmp, 'home'),
      projectRoot: path.join(tmp, 'proj'),
    });

    expect(errors).toEqual([]);
    const cr = skills.find((s) => s.name === 'commit-review')!;
    expect(cr.layer).toBe('project');
    expect(cr.description).toBe('项目版');
    expect(cr.body).toBe('项目主体');
    expect(skills.find((s) => s.name === 'user-only')!.layer).toBe('user');
    // 覆盖后不重复出现
    expect(skills.filter((s) => s.name === 'commit-review')).toHaveLength(1);
  });

  it('references/ 目录被索引；缺失目录静默跳过', async () => {
    const dir = await writeSkill(path.join(tmp, 'builtin'), 'test-fix', 'name: test-fix\ndescription: 跑测试修错');
    await fs.mkdir(path.join(dir, 'references'), { recursive: true });
    await fs.writeFile(path.join(dir, 'references', 'patterns.md'), 'patterns');

    const { skills } = await discoverSkills({
      builtinDir: path.join(tmp, 'builtin'),
      homeDir: path.join(tmp, 'no-home'),
      projectRoot: path.join(tmp, 'no-proj'),
    });
    expect(skills).toHaveLength(1);
    expect(skills[0]!.references).toEqual(['patterns.md']);
  });

  it('损坏包跳过并记入 errors，不影响其他包', async () => {
    await writeSkill(path.join(tmp, 'builtin'), 'good', 'name: good\ndescription: ok');
    const badDir = path.join(tmp, 'builtin', 'bad');
    await fs.mkdir(badDir, { recursive: true });

    const { skills, errors } = await discoverSkills({ builtinDir: path.join(tmp, 'builtin') });
    expect(skills.map((s) => s.name)).toEqual(['good']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('bad');
  });

  it('默认内置目录指向 packages/core/skills/', () => {
    expect(defaultBuiltinSkillsDir()).toMatch(/packages[\\/]core[\\/]skills[\\/]?$/);
  });
});

describe('分词与匹配评分', () => {
  it('中文 n-gram 分词（窗口 2/3/4）+ 英文按词', () => {
    const tokens = tokenize('数据库性能优化 review');
    expect(tokens).toContain('数据库'); // 3-gram
    expect(tokens).toContain('性能'); // 2-gram
    expect(tokens).toContain('优化'); // 2-gram
    expect(tokens).toContain('性能优化'); // 4-gram
    expect(tokens).toContain('数据库性'); // 4-gram
    expect(tokens).toContain('review');
    // 窗口上限 4：不产生 5+ 字切片
    expect(tokens).not.toContain('数据库性能');
  });

  it('triggers 精确命中 +10000，超过阈值', () => {
    const r = scoreSkill(meta(), '审查提交');
    expect(r.breakdown.exact).toBe(10_000);
    expect(r.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });

  it('名称/描述部分命中：低于阈值 → 不主动建议', () => {
    const r = scoreSkill(meta(), '帮我做代码质量检查');
    expect(r.breakdown.exact).toBe(0);
    expect(r.score).toBeLessThan(MATCH_THRESHOLD);
    expect(suggestSkill([meta()], '帮我做代码质量检查')).toBeUndefined();
  });

  it('名称包含查询词：命中加成', () => {
    const r = scoreSkill(meta(), 'commit 审查');
    expect(r.breakdown.name).toBeGreaterThan(0);
    expect(r.breakdown.triggers).toBeGreaterThan(0);
  });

  it('matchSkills 降序排名', () => {
    const a = meta({ name: 'aaa', description: '数据库性能优化专用技能', triggers: [] });
    const b = meta({ name: '数据库性能优化', description: '别的描述', triggers: [] });
    const ranked = matchSkills([a, b], '数据库性能优化');
    expect(ranked[0]!.skill.name).toBe('数据库性能优化'); // 名称命中 ×12 权重更高
    expect(ranked[0]!.score).toBeGreaterThanOrEqual(ranked[1]!.score);
  });

  it('suggestSkill：Top-1 达阈值才返回', () => {
    const s = meta();
    expect(suggestSkill([s], 'review commit')!.skill.name).toBe('commit-review');
    expect(suggestSkill([s], '写个诗')).toBeUndefined();
  });
});

describe('SkillBuffer 跨轮次缓冲区', () => {
  it('load → 内容含主体 + references 索引 + 工具白名单；幂等', () => {
    const buf = new SkillBuffer();
    const m = meta();
    const first = buf.load(m);
    const again = buf.load(m);
    expect(again).toBe(first);
    expect(first.content).toContain('Commit 审查流程');
    expect(first.content).toContain('checklist.md');
    expect(first.content).toContain('read_file');
    expect(first.tokens).toBeGreaterThan(0);
    expect(buf.tokens()).toBe(first.tokens);
  });

  it('unload 释放；clear 清空', () => {
    const buf = new SkillBuffer();
    buf.load(meta());
    expect(buf.unload('commit-review')).toBe(true);
    expect(buf.unload('commit-review')).toBe(false);
    buf.load(meta());
    buf.clear();
    expect(buf.list()).toHaveLength(0);
  });

  it('renderSkillContent：无 references 时不渲染该节', () => {
    const content = renderSkillContent(meta({ references: [], toolsAllowlist: [] }));
    expect(content).not.toContain('参考资料');
    expect(content).not.toContain('允许的工具');
  });
});

describe('load_skill / unload_skill 工具', () => {
  function makeCtxWithRuntime(runtime?: SkillRuntime): ToolContext {
    return {
      projectRoot: tmp,
      signal: new AbortController().signal,
      confirm: async () => ({ kind: 'allow' }),
      askUser: async (q) => q,
      todos: [],
      skills: runtime,
    };
  }

  it('未启用 skills runtime → skills_unavailable', async () => {
    const r = await loadSkillTool.execute({ name: 'x' }, makeCtxWithRuntime());
    expect(r.ok).toBe(false);
    expect(r.error).toBe('skills_unavailable');
  });

  it('load 成功进缓冲区；unload 未加载报 skill_not_loaded', async () => {
    const buf = new SkillBuffer();
    const m = meta();
    const runtime: SkillRuntime = {
      load: async (name) =>
        name === m.name ? { ok: true, content: (buf.load(m), buf.get(name)!.content) } : { ok: false, content: `未找到 Skill：${name}` },
      unload: (name) =>
        buf.unload(name) ? { ok: true, content: `已卸载 ${name}` } : { ok: false, content: `未加载 Skill：${name}` },
    };
    const ctx = makeCtxWithRuntime(runtime);

    const loaded = await loadSkillTool.execute({ name: 'commit-review' }, ctx);
    expect(loaded.ok).toBe(true);
    expect(loaded.content).toContain('Commit 审查流程');

    const missing = await loadSkillTool.execute({ name: 'nope' }, ctx);
    expect(missing.ok).toBe(false);
    expect(missing.error).toBe('skill_not_found');

    const unloaded = await unloadSkillTool.execute({ name: 'commit-review' }, ctx);
    expect(unloaded.ok).toBe(true);
    expect(buf.names()).toHaveLength(0);

    const again = await unloadSkillTool.execute({ name: 'commit-review' }, ctx);
    expect(again.ok).toBe(false);
    expect(again.error).toBe('skill_not_loaded');
  });

  it('registry 注册 16 个内置工具（15 + task）', () => {
    const reg = new ToolRegistry();
    expect(reg.names()).toContain('load_skill');
    expect(reg.names()).toContain('unload_skill');
    expect(reg.names()).toHaveLength(16);
  });

  it('registry 执行路径：schema 校验 + 分发', async () => {
    const reg = new ToolRegistry();
    const results = await reg.executeAll([call('load_skill', {})], makeCtxWithRuntime());
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toBe('invalid_args');
  });
});
