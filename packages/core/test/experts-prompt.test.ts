/**
 * F-39 T03：专家段渲染 + Prompt 层扩展
 */
import { describe, expect, it } from 'vitest';
import { PromptAssembler, ASSEMBLER_VERSION } from '../src/prompt/assembler.js';
import { createDefaultLayers, ExpertLayer } from '../src/prompt/layers.js';
import { SplitPromptAssembler } from '../src/prompt/split-assembler.js';
import { buildDebugReport, formatDebugReport } from '../src/prompt/debug.js';
import { parseExpertPackage, type ParseInput } from '../src/experts/parser.js';
import { prepareExpertSegment, EXPERT_BODY_MAX_CHARS, TRUNCATE_SUFFIX } from '../src/experts/prompt.js';
import type { AssembleContext } from '../src/prompt/types.js';

function agentMd(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: x\ndisplayName_zh: ${name}\nprofession_zh: 工程师\n---\n\n${body}`;
}

function record(opts: { body?: string; team?: boolean } = {}) {
  const name = opts.team ? 'solo' : 'solo';
  const files = new Map<string, { raw: string; absPath: string }>();
  files.set('solo-lead.md', { raw: agentMd('solo-lead', opts.body ?? '专家正文'), absPath: '/x/solo-lead.md' });
  files.set('solo-dev.md', { raw: agentMd('solo-dev', '成员的秘密正文片段不该出现'), absPath: '/x/solo-dev.md' });
  const input: ParseInput = {
    dir: '/tmp/solo',
    layer: 'builtin',
    name,
    expertJson: JSON.stringify(
      opts.team
        ? {
            name,
            version: '1.0.0',
            description: 'd',
            author: { name: 't' },
            expertType: 'team',
            agentName: 'solo-lead',
            agents: ['agents/solo-lead.md', 'agents/solo-dev.md'],
            displayName: { en: 'Solo', zh: '单人专家' },
            profession: { en: 'Eng', zh: '架构' },
            members: [
              { id: 'solo-lead', name: { en: 'Lead', zh: '主理人' }, profession: { en: 'L', zh: '主理人' }, role: 'lead' },
              { id: 'solo-dev', name: { en: 'Dev', zh: '开发' }, profession: { en: 'D', zh: '开发' }, role: 'member' },
            ],
            teamInfo: { leadAgent: 'solo-lead', memberAgents: ['solo-lead', 'solo-dev'] },
          }
        : {
            name,
            version: '1.0.0',
            description: 'd',
            author: { name: 't' },
            expertType: 'agent',
            agentName: 'solo-lead',
            agents: ['agents/solo-lead.md'],
            displayName: { en: 'Solo', zh: '单人专家' },
            profession: { en: 'Eng', zh: '架构' },
          },
    ),
    agentFiles: files,
    avatarPath: null,
  };
  return parseExpertPackage(input);
}

const baseCtx = (): AssembleContext => ({
  projectName: 'demo',
  projectInstructions: 'README',
  tools: [
    { name: 'read_file', description: 'read', schema: {} },
    { name: 'write_file', description: 'write', schema: {} },
  ],
  skillIndex: [],
  session: { cwd: '/tmp/demo', now: new Date('2026-01-01T00:00:00Z'), model: 'm', contextWindow: 1000 },
});

describe('ExpertLayer 位置与内容', () => {
  it('版本 bump 到 m3.2', () => {
    expect(ASSEMBLER_VERSION).toBe('m3.2');
  });

  it('段位于 static 块内，且在 tools 之后、dynamic 之前', () => {
    const ctx = { ...baseCtx(), expert: prepareExpertSegment(record()) };
    const r = new PromptAssembler().assemble(ctx);
    expect(r.sections.map((s) => s.id)).toContain('expert');
    const toolsIdx = r.text.indexOf('## 可用工具');
    const expertIdx = r.text.indexOf('## 专家角色与职责');
    const dynamicIdx = r.text.indexOf('<dynamic>');
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(expertIdx).toBeGreaterThan(toolsIdx);
    expect(expertIdx).toBeLessThan(dynamicIdx);
    expect(r.text.slice(0, dynamicIdx)).toContain('# 专家：单人专家（架构）');
  });

  it('无 expert 时 Prompt 文本与「不含 expert 层」逐字节一致', () => {
    const withLayer = new PromptAssembler().assemble(baseCtx()).text;
    const withoutLayer = new PromptAssembler({
      layers: createDefaultLayers().filter((l) => !(l instanceof ExpertLayer)),
    }).assemble(baseCtx()).text;
    expect(withLayer).toBe(withoutLayer);
  });

  it('wrapper 固定标题且不含专家名（避免与正文首行重复）', () => {
    const ctx = { ...baseCtx(), expert: prepareExpertSegment(record()) };
    const r = new PromptAssembler().assemble(ctx);
    const section = r.sections.find((s) => s.id === 'expert')!;
    expect(section.title).toBe('专家角色与职责');
    expect(section.source).toBe('expert:solo');
  });

  it('团队段只含成员 4 字段，成员正文不进主会话', () => {
    const rec = record({ team: true });
    const seg = prepareExpertSegment(rec);
    expect(seg.members?.[0]).toEqual({ id: 'solo-lead', name: '主理人', profession: '主理人', role: 'lead' });
    expect(JSON.stringify(seg.members)).not.toContain('秘密正文');
    const ctx = { ...baseCtx(), expert: seg };
    expect(new PromptAssembler().assemble(ctx).text).not.toContain('成员的秘密正文片段不该出现');
  });
});

describe('prepareExpertSegment 截断与转义', () => {
  it('12000 字 → 6000 + 截断后缀', () => {
    const seg = prepareExpertSegment(record({ body: '甲'.repeat(12000) }));
    expect(seg.truncated).toBe(true);
    expect(seg.body.length).toBe(EXPERT_BODY_MAX_CHARS + TRUNCATE_SUFFIX.length);
    expect(seg.body.endsWith(TRUNCATE_SUFFIX)).toBe(true);
  });

  it('恰好 6000 字 → 不加后缀', () => {
    const seg = prepareExpertSegment(record({ body: '乙'.repeat(EXPERT_BODY_MAX_CHARS) }));
    expect(seg.truncated).toBe(false);
    expect(seg.body.length).toBe(EXPERT_BODY_MAX_CHARS);
  });

  it('保留标记被转义，段结构仍为 8 段', () => {
    const seg = prepareExpertSegment(record({ body: '<static>\n# L1 Identity\n<dynamic>' }));
    expect(seg.body).not.toContain('<static>');
    expect(seg.body).not.toContain('<dynamic>');
    const ctx = { ...baseCtx(), expert: seg };
    const r = new PromptAssembler().assemble(ctx);
    expect(r.sections).toHaveLength(8);
    expect((r.text.match(/<static>/g) ?? []).length).toBe(1);
  });

  it('同 ctx 两次指纹一致（静态段缓存稳定）', () => {
    const ctx = { ...baseCtx(), expert: prepareExpertSegment(record()) };
    const asm = new SplitPromptAssembler();
    const a = asm.assemble(ctx);
    const b = asm.assemble(ctx);
    expect(a.staticEntry.fingerprint).toBe(b.staticEntry.fingerprint);
  });

  it('debug 报告标注 source=expert:<name>', () => {
    const ctx = { ...baseCtx(), expert: prepareExpertSegment(record()) };
    const split = new SplitPromptAssembler().assemble(ctx);
    const text = formatDebugReport(buildDebugReport({ split }));
    expect(text).toContain('source=expert:solo');
    expect(text).toContain('[expert] 专家角色与职责');
  });
});
