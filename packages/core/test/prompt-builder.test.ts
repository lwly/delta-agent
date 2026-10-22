import { describe, expect, it } from 'vitest';
import { PromptBuilder, DEFAULT_PROMPT_BUDGET } from '../src/prompt/builder.js';
import { NullMemoryProvider, StaticMemoryProvider } from '../src/prompt/memory-provider.js';
import { SplitPromptAssembler } from '../src/prompt/split-assembler.js';
import type { AssembleContext, RecalledMemory } from '../src/prompt/types.js';

function makeCtx(over: Partial<AssembleContext> = {}): AssembleContext {
  return {
    projectName: 'demo',
    projectInstructions: '技术栈：TypeScript + Vue。规范：pnpm only。',
    tools: [{ name: 'read_file', description: '读文件', schema: { type: 'object' } }],
    skillIndex: [{ name: 'commit-review', description: '审查提交', triggers: ['review'] }],
    session: {
      cwd: '/tmp/demo',
      now: new Date('2026-10-22T10:00:00Z'),
      model: 'glm-5.3-flash',
      contextWindow: 200_000,
    },
    ...over,
  };
}

const mem = (id: string, content: string, score: number): RecalledMemory => ({
  id,
  content,
  score,
  source: 'l2',
});

describe('MemoryProvider stub', () => {
  it('NullMemoryProvider 恒返回空', async () => {
    const p = new NullMemoryProvider();
    expect(await p.recall({ query: '任意' })).toEqual([]);
  });

  it('StaticMemoryProvider 按 score 降序取 topK', async () => {
    const p = new StaticMemoryProvider([
      mem('a', '低分', 0.1),
      mem('b', '高分', 0.9),
      mem('c', '中分', 0.5),
    ]);
    const r = await p.recall({ query: 'q', topK: 2 });
    expect(r.map((m) => m.id)).toEqual(['b', 'c']);
  });
});

describe('PromptBuilder 去重', () => {
  it('记忆内容与静态项目指令重复 → 标记 deduped 并回传 id', () => {
    const asm = new SplitPromptAssembler();
    const split = asm.assemble(makeCtx());
    const builder = new PromptBuilder();
    const r = builder.build(split, {
      memoryEntries: [
        mem('m1', '技术栈：TypeScript + Vue。规范：pnpm only。', 0.8),
        mem('m2', '独有记忆内容，静态段没有这句话', 0.6),
      ],
    });
    expect(r.dedupedMemoryIds).toEqual(['m1']);
    expect(r.dynamicText).toContain('与项目指令重复');
    expect(r.dynamicText).toContain('独有记忆内容');
  });

  it('短内容（<12 字符）不判重', () => {
    const asm = new SplitPromptAssembler();
    const split = asm.assemble(makeCtx());
    const r = new PromptBuilder().build(split, {
      memoryEntries: [mem('m1', 'pnpm only', 0.5)],
    });
    expect(r.dedupedMemoryIds).toEqual([]);
  });

  it('dedupe 关闭时不标记', () => {
    const asm = new SplitPromptAssembler();
    const split = asm.assemble(makeCtx());
    const r = new PromptBuilder({ dedupe: false }).build(split, {
      memoryEntries: [mem('m1', '技术栈：TypeScript + Vue。规范：pnpm only。', 0.8)],
    });
    expect(r.dedupedMemoryIds).toEqual([]);
  });
});

describe('PromptBuilder 裁剪优先级', () => {
  it('动态段超预算：先裁 skills 索引，再裁低分记忆，session 与静态段保留', () => {
    const asm = new SplitPromptAssembler();
    const split = asm.assemble(makeCtx());
    const builder = new PromptBuilder({
      budget: { dynamicTokens: 10, memoryTokens: 80 },
    });
    const r = builder.build(split, {
      memoryEntries: [
        mem('low', '低分记忆条目内容很长一些方便超预算触发裁剪逻辑', 0.1),
        mem('high', '高分记忆条目内容也很长一些确保低分条目先被裁掉', 0.9),
      ],
    });
    const dropped = r.trimLog.filter((t) => t.action === 'dropped');
    expect(dropped.some((t) => t.section === 'skills')).toBe(true);
    expect(dropped.some((t) => t.section === 'memory-entry' && t.detail === 'low')).toBe(true);
    expect(dropped.some((t) => t.section === 'memory-entry' && t.detail === 'high')).toBe(false);
    // session 环境段保留（不可裁剪）
    expect(r.dynamicText).toContain('运行环境');
    // 静态段完整保留
    expect(r.staticText).toContain('身份与安全基线');
  });

  it('预算充足时全部保留', () => {
    const asm = new SplitPromptAssembler();
    const split = asm.assemble(makeCtx());
    const r = new PromptBuilder().build(split, {
      memoryEntries: [mem('m1', '普通记忆内容', 0.5)],
    });
    expect(r.trimLog.filter((t) => t.action === 'dropped')).toHaveLength(0);
    expect(r.dynamicText).toContain('Skill 索引');
    expect(r.dynamicText).toContain('相关记忆');
  });

  it('静态段超预算仅告警不裁剪', () => {
    const asm = new SplitPromptAssembler();
    const split = asm.assemble(makeCtx());
    const r = new PromptBuilder({ budget: { staticTokens: 1 } }).build(split);
    expect(r.trimLog.some((t) => t.action === 'over-budget')).toBe(true);
    expect(r.staticText).toContain('身份与安全基线');
    expect(r.staticText).toContain('可用工具');
  });

  it('记忆全裁后不输出记忆段', () => {
    const asm = new SplitPromptAssembler();
    const split = asm.assemble(makeCtx());
    const r = new PromptBuilder({ budget: { memoryTokens: 0 } }).build(split, {
      memoryEntries: [mem('m1', '一条会被完全裁掉的记忆内容', 0.5)],
    });
    expect(r.dynamicText).not.toContain('相关记忆');
  });

  it('默认预算与设计文档一致', () => {
    expect(DEFAULT_PROMPT_BUDGET).toMatchObject({
      staticTokens: 8_000,
      dynamicTokens: 2_000,
      memoryTokens: 1_500,
      skillLoadedTokens: 4_000,
      reserveTokens: 1_024,
    });
  });
});
