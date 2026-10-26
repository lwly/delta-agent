import { describe, expect, it } from 'vitest';
import { buildDebugReport, formatDebugReport, promptSectionsLog } from '../src/prompt/debug.js';
import { PromptBuilder } from '../src/prompt/builder.js';
import { SplitPromptAssembler } from '../src/prompt/split-assembler.js';
import type { AssembleContext } from '../src/prompt/types.js';

function makeCtx(over: Partial<AssembleContext> = {}): AssembleContext {
  return {
    projectName: 'demo',
    projectInstructions: 'TypeScript 项目，使用 pnpm 构建。',
    tools: [{ name: 'read_file', description: '读文件', schema: { type: 'object' } }],
    skillIndex: [{ name: 'commit-review', description: '审查提交', triggers: ['审查提交'] }],
    session: {
      cwd: '/tmp/demo',
      now: new Date('2026-10-22T10:00:00Z'),
      model: 'glm-5.3-flash',
      contextWindow: 200_000,
    },
    ...over,
  };
}

describe('buildDebugReport / formatDebugReport', () => {
  it('报告包含缓存指纹、逐段明细、token 统计', () => {
    const asm = new SplitPromptAssembler();
    const split = asm.assemble(makeCtx());
    asm.assemble(makeCtx()); // 第二次 → 缓存命中
    const split2 = asm.assemble(makeCtx());
    const final = new PromptBuilder().build(split2);

    const r = buildDebugReport({ split: split2, final });
    expect(r.staticCache.fingerprint).toBe(split.staticEntry.fingerprint);
    expect(r.staticCache.hitCount).toBe(2); // 第 2、3 次组装命中缓存（累计计数）
    expect(r.sections).toHaveLength(8);
    expect(r.sections[0]).toMatchObject({ id: 'identity', kind: 'static', locked: true });
    expect(r.sections[7]).toMatchObject({ id: 'session', kind: 'dynamic' });
    expect(r.sections[4]).toMatchObject({ id: 'expert', kind: 'static' });
    expect(r.totalTokens).toBeGreaterThan(0);
    expect(r.warnings).toHaveLength(0);
  });

  it('locked 覆盖告警与裁剪明细进入报告', () => {
    const asm = new SplitPromptAssembler();
    const split = asm.assemble(makeCtx(), { session: { identity: 'hijack' } });
    const final = new PromptBuilder({ budget: { dynamicTokens: 1, memoryTokens: 0 } }).build(split);
    const r = buildDebugReport({ split, final });
    expect(r.warnings.some((w) => w.includes('locked'))).toBe(true);
    expect(r.trimLog.some((t) => t.action === 'dropped')).toBe(true);
  });

  it('formatDebugReport 输出人类可读文本', () => {
    const asm = new SplitPromptAssembler();
    const split = asm.assemble(makeCtx());
    const r = buildDebugReport({ split, final: new PromptBuilder().build(split) });
    const text = formatDebugReport(r);
    expect(text).toContain('Prompt 调试报告');
    expect(text).toContain('[identity] 身份与安全基线');
    expect(text).toContain('static');
    expect(text).toContain('tok');
  });

  it('promptSectionsLog：turn/静态hash/命中/裁剪', () => {
    const asm = new SplitPromptAssembler();
    const split = asm.assemble(makeCtx());
    const final = new PromptBuilder({ budget: { dynamicTokens: 1 } }).build(split);
    const entry = promptSectionsLog(3, split, final);
    expect(entry).toMatchObject({ turn: 3, staticCacheHit: false, dynamicTokens: split.dynamic.tokens });
    expect(entry.staticHash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.dropped).toContain('skills');
  });
});
