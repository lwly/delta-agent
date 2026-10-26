/**
 * F-39 T01：专家包解析（纯函数层）
 * 覆盖 10 步校验链、成员级降级、保留标记转义、id 字符集。
 */
import { describe, expect, it } from 'vitest';
import {
  escapeReservedMarkers,
  parseExpertPackage,
  validateExpertName,
  type ParseInput,
} from '../src/experts/parser.js';

function md(name: string, body: string, extra: Record<string, string> = {}): string {
  const lines = [`name: ${name}`, `description: ${name} agent`, `displayName_zh: ${name} 中文`, 'profession_zh: 工程师', ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`)];
  return `---\n${lines.join('\n')}\n---\n\n${body}`;
}

function json(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'solo',
    version: '1.0.0',
    description: 'd',
    author: { name: 'tester' },
    expertType: 'agent',
    agentName: 'solo-agent',
    agents: ['agents/solo-agent.md'],
    displayName: { en: 'Solo', zh: '单人专家' },
    profession: { en: 'Eng', zh: '工程师' },
    ...over,
  });
}

function input(over: Partial<ParseInput> = {}, pkg: Record<string, unknown> = {}, files: Record<string, string> = {}): ParseInput {
  const agentFiles = new Map<string, { raw: string; absPath: string }>();
  const all: Record<string, string> = {
    'solo-agent.md': md('solo-agent', '# 正文\n你是单人专家。'),
    ...files,
  };
  for (const [k, v] of Object.entries(all)) agentFiles.set(k, { raw: v, absPath: `/tmp/solo/agents/${k}` });
  return {
    dir: '/tmp/solo',
    layer: 'builtin',
    name: 'solo',
    expertJson: json(pkg),
    agentFiles,
    avatarPath: null,
    ...over,
  };
}

describe('validateExpertName', () => {
  it('拒绝大写 / 数字开头 / 单字符 / 下划线 / 41 字符', () => {
    expect(validateExpertName('A')).not.toBeNull();
    expect(validateExpertName('1x')).not.toBeNull();
    expect(validateExpertName('a')).not.toBeNull();
    expect(validateExpertName('a_b')).not.toBeNull();
    expect(validateExpertName(`a${'b'.repeat(40)}`)).not.toBeNull();
  });

  it('接受 code-architect', () => {
    expect(validateExpertName('code-architect')).toBeNull();
  });
});

describe('parseExpertPackage：单人专家', () => {
  it('解析成功，字段与 promptStats 正确', () => {
    const r = parseExpertPackage(input());
    expect(r.name).toBe('solo');
    expect(r.expertType).toBe('agent');
    expect(r.agent.id).toBe('solo-agent');
    expect(r.members).toEqual([]);
    expect(r.promptStats.chars).toBeGreaterThan(0);
    expect(r.tools).toBeNull();
  });

  it('缺少 agents[] → 抛错', () => {
    expect(() => parseExpertPackage(input({}, { agents: [] }))).toThrow(/缺少 agents/);
  });

  it('agentName 不在 agents[] → 抛错', () => {
    expect(() => parseExpertPackage(input({}, { agentName: 'nope' }))).toThrow(/不在 agents\[\] 中/);
  });

  it('agents[] 声明 ../ 越界 → 抛错', () => {
    expect(() => parseExpertPackage(input({}, { agents: ['../evil.md'] }))).toThrow(/越界|agents\//);
  });

  it('agents[] 绝对路径 → 抛错', () => {
    expect(() => parseExpertPackage(input({}, { agents: ['/etc/passwd'] }))).toThrow(/绝对路径/);
  });

  it('agents[] 声明但文件不存在 → 抛错', () => {
    expect(() => parseExpertPackage(input({}, { agents: ['agents/ghost.md'] }))).toThrow(/不存在/);
  });

  it('主 agent frontmatter.name ≠ 文件名 → 整包失败', () => {
    const bad = md('other-name', 'x');
    expect(() => parseExpertPackage(input({}, {}, { 'solo-agent.md': bad }))).toThrow(/必须等于文件名/);
  });

  it('未知字段忽略不报错', () => {
    const r = parseExpertPackage(input({}, { unknownField: 42, connectors: [] }));
    expect(r.name).toBe('solo');
  });

  it('专家包声明 tools → 原样保留；未声明 → null', () => {
    expect(parseExpertPackage(input({}, { tools: ['read_file', 'write_file'] })).tools).toEqual(['read_file', 'write_file']);
    expect(parseExpertPackage(input({}, { tools: undefined })).tools).toBeNull();
  });
});

describe('parseExpertPackage：团队', () => {
  const teamJson = {
    expertType: 'team',
    agentName: 'solo-lead',
    agents: ['agents/solo-lead.md', 'agents/solo-dev.md'],
    members: [
      { id: 'solo-lead', name: { en: 'Lead', zh: '主理人' }, profession: { en: 'Lead', zh: '主理人' }, role: 'lead' },
      { id: 'solo-dev', name: { en: 'Dev', zh: '开发' }, profession: { en: 'Dev', zh: '开发' }, role: 'member' },
    ],
    teamInfo: { leadAgent: 'solo-lead', memberAgents: ['solo-lead', 'solo-dev'] },
  };
  const teamFiles = {
    'solo-lead.md': md('solo-lead', '主理人正文'),
    'solo-dev.md': md('solo-dev', '成员正文'),
  };
  const teamInput = (pkg: Record<string, unknown> = {}, files: Record<string, string> = teamFiles) =>
    input({ name: 'solo', dir: '/tmp/solo' }, { name: 'solo', ...teamJson, ...pkg }, files);

  it('解析成功，成员含 role 与正文', () => {
    const r = parseExpertPackage(teamInput());
    expect(r.expertType).toBe('team');
    expect(r.members.map((m) => `${m.id}:${m.role}`)).toEqual(['solo-lead:lead', 'solo-dev:member']);
    expect(r.members[1]!.body).toContain('成员正文');
  });

  it('无 lead → 抛错', () => {
    const members = [
      { id: 'solo-lead', name: { en: 'L', zh: 'L' }, profession: { en: 'L', zh: 'L' }, role: 'member' },
      { id: 'solo-dev', name: { en: 'D', zh: 'D' }, profession: { en: 'D', zh: 'D' }, role: 'member' },
    ];
    expect(() => parseExpertPackage(teamInput({ members }))).toThrow(/恰好 1 个/);
  });

  it('双 lead → 抛错', () => {
    const members = [
      { id: 'solo-lead', name: { en: 'L', zh: 'L' }, profession: { en: 'L', zh: 'L' }, role: 'lead' },
      { id: 'solo-dev', name: { en: 'D', zh: 'D' }, profession: { en: 'D', zh: 'D' }, role: 'lead' },
    ];
    expect(() => parseExpertPackage(teamInput({ members }))).toThrow(/恰好 1 个/);
  });

  it('memberAgents 与 members 不一一对应 → 抛错', () => {
    expect(() => parseExpertPackage(teamInput({ teamInfo: { leadAgent: 'solo-lead', memberAgents: ['solo-lead'] } }))).toThrow(/一一对应/);
  });

  it('leadAgent ≠ agentName → 抛错', () => {
    expect(() =>
      parseExpertPackage(teamInput({ teamInfo: { leadAgent: 'solo-dev', memberAgents: ['solo-lead', 'solo-dev'] } })),
    ).toThrow(/必须等于 agentName/);
  });

  it('成员数超过 6 → 抛错', () => {
    const files: Record<string, string> = { 'solo-lead.md': md('solo-lead', 'x') };
    const members = [
      { id: 'solo-lead', name: { en: 'L', zh: 'L' }, profession: { en: 'L', zh: 'L' }, role: 'lead' },
    ] as Array<Record<string, unknown>>;
    const agents = ['agents/solo-lead.md'];
    for (let i = 0; i < 7; i++) {
      const id = `solo-m${i}`;
      agents.push(`agents/${id}.md`);
      files[`${id}.md`] = md(id, 'x');
      members.push({ id, name: { en: id, zh: id }, profession: { en: id, zh: id }, role: 'member' });
    }
    expect(() =>
      parseExpertPackage(
        teamInput(
          { agents, members, teamInfo: { leadAgent: 'solo-lead', memberAgents: members.map((m) => m['id']) } },
          files,
        ),
      ),
    ).toThrow(/超过上限 6/);
  });

  it('嵌套团队（md frontmatter 带 expertType）→ 主 agent 失败整包失败', () => {
    expect(() =>
      parseExpertPackage(
        teamInput({}, { ...teamFiles, 'solo-lead.md': md('solo-lead', 'x', { expertType: 'team' }) }),
      ),
    ).toThrow(/禁止嵌套团队|主 agent/);
  });

  it('普通成员 md 坏 → 只剔该成员 + warning', () => {
    const warnings: string[] = [];
    const r = parseExpertPackage(
      teamInput({}, { ...teamFiles, 'solo-dev.md': md('wrong-name', 'x') }),
      warnings,
    );
    expect(r.members.map((m) => m.id)).toEqual(['solo-lead']);
    expect(warnings.join('\n')).toMatch(/成员 solo-dev 解析失败/);
  });

  it('主理人文件名不带团队前缀 → 抛错', () => {
    expect(() =>
      parseExpertPackage(
        teamInput(
          { agents: ['agents/lead.md', 'agents/solo-dev.md'], agentName: 'lead', teamInfo: { leadAgent: 'lead', memberAgents: ['lead', 'solo-dev'] }, members: [
            { id: 'lead', name: { en: 'L', zh: 'L' }, profession: { en: 'L', zh: 'L' }, role: 'lead' },
            { id: 'solo-dev', name: { en: 'D', zh: 'D' }, profession: { en: 'D', zh: 'D' }, role: 'member' },
          ] },
          { 'lead.md': md('lead', 'x'), 'solo-dev.md': md('solo-dev', 'x') },
        ),
      ),
    ).toThrow(/团队前缀/);
  });

  it('成员 id 含 ] / 空格 / 全角括号 → 抛错；合法 id 通过', () => {
    const bad = teamInput({
      agents: ['agents/solo-lead.md', 'agents/solo dev.md'],
      members: [
        { id: 'solo-lead', name: { en: 'L', zh: 'L' }, profession: { en: 'L', zh: 'L' }, role: 'lead' },
        { id: 'solo dev', name: { en: 'D', zh: 'D' }, profession: { en: 'D', zh: 'D' }, role: 'member' },
      ],
      teamInfo: { leadAgent: 'solo-lead', memberAgents: ['solo-lead', 'solo dev'] },
    }, { ...teamFiles, 'solo dev.md': md('solo dev', 'x') });
    expect(() => parseExpertPackage(bad)).toThrow(/id .* 非法|非法/);

    expect(parseExpertPackage(teamInput()).members.map((m) => m.id)).toContain('solo-dev');
  });
});

describe('escapeReservedMarkers', () => {
  it('转义保留标记且幂等', () => {
    const raw = '<static>\n# L1 Identity\n<dynamic>\n# L6 Memory';
    const once = escapeReservedMarkers(raw);
    expect(once).not.toMatch(/<static>|<dynamic>/);
    expect(once).not.toMatch(/^# L1/m);
    expect(escapeReservedMarkers(once)).toBe(once);
  });
});
