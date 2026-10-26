/**
 * F-39 T14：首批内置专家包（5 个）全部可解析 + 结构契约
 */
import { describe, expect, it } from 'vitest';
import { ExpertStore, defaultBuiltinExpertsDir, defaultBuiltinSkillsDir } from '../src/index.js';
import { discoverSkills } from '../src/skills/loader.js';

const store = new ExpertStore({ builtinDir: defaultBuiltinExpertsDir() });

describe('内置专家包（T14）', () => {
  it('5 个包全部解析成功且 layer=builtin', async () => {
    const { experts, errors } = await store.list();
    expect(errors).toEqual([]);
    expect(experts.map((e) => e.name).sort()).toEqual([
      'code-architect',
      'code-reviewer',
      'product-manager',
      'software-dev-team',
      'test-engineer',
    ]);
    expect(experts.every((e) => e.layer === 'builtin')).toBe(true);
  });

  it('code-reviewer 纯只读（限制 4/16）；code-architect 白名单 5 项', async () => {
    const reviewer = await store.get('code-reviewer');
    expect(reviewer!.tools).toEqual(['read_file', 'list_dir', 'glob_search', 'grep_search']);
    expect(reviewer!.tools!.length).toBe(4);
    const architect = await store.get('code-architect');
    expect(architect!.tools!.length).toBe(5);
    expect(architect!.tools).toContain('task');
  });

  it('test-engineer 含写/执行工具；product-manager 预置技能均存在', async () => {
    const tester = await store.get('test-engineer');
    expect(tester!.tools).toEqual(
      expect.arrayContaining(['write_file', 'edit_file', 'run_command', 'run_tests']),
    );
    const pm = await store.get('product-manager');
    expect(pm!.skills).toEqual(['commit-review', 'project-summarize']);
    const { skills } = await discoverSkills({ builtinDir: defaultBuiltinSkillsDir() });
    for (const s of pm!.skills) {
      expect(skills.map((x) => x.name)).toContain(s);
    }
  });

  it('software-dev-team：4 成员、lead 带团队前缀、成员 ≤6', async () => {
    const team = await store.get('software-dev-team');
    expect(team!.expertType).toBe('team');
    expect(team!.members).toHaveLength(4);
    expect(team!.members[0]!.role).toBe('lead');
    expect(team!.agent.id).toBe('software-dev-team-lead');
    for (const m of team!.members) {
      expect(m.id.startsWith('software-dev-team-')).toBe(true);
    }
    // 主理人白名单无写工具（AC-4 前提）
    expect(team!.tools).not.toContain('write_file');
    expect(team!.tools).toContain('task');
    // 成员各自声明工具；开发/测试成员可写（D4），产品只读
    const dev = team!.members.find((m) => m.id.endsWith('-dev'))!;
    const pm = team!.members.find((m) => m.id.endsWith('-pm'))!;
    expect(dev.tools).toContain('write_file');
    expect(pm.tools).not.toContain('write_file');
  });
});
