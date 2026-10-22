import { describe, expect, it } from 'vitest';
import {
  SplitPromptAssembler,
  composeSystemPrompt,
  type StaticPromptEntry,
} from '../src/prompt/split-assembler.js';
import type { AssembleContext, OverrideSet, PromptLayer } from '../src/prompt/types.js';

function makeCtx(over: Partial<AssembleContext> = {}): AssembleContext {
  return {
    projectName: 'demo',
    projectInstructions: 'TypeScript 项目',
    tools: [{ name: 'read_file', description: '读文件', schema: { type: 'object' } }],
    skillIndex: [],
    session: {
      cwd: '/tmp/demo',
      now: new Date('2026-10-22T10:00:00Z'),
      model: 'glm-5.3-flash',
      contextWindow: 200_000,
    },
    ...over,
  };
}

describe('SplitPromptAssembler 静态缓存', () => {
  it('相同输入命中缓存（fingerprint 相同、hits 递增）', () => {
    const asm = new SplitPromptAssembler();
    const a = asm.assemble(makeCtx());
    const b = asm.assemble(makeCtx());
    expect(b.staticEntry.fingerprint).toBe(a.staticEntry.fingerprint);
    expect(a.staticEntry.hits).toBe(0);
    expect(b.staticEntry.hits).toBe(1);
    expect(b.staticEntry.text).toBe(a.staticEntry.text);
  });

  it('动态段变化（时间推进）不影响静态缓存命中', () => {
    const asm = new SplitPromptAssembler();
    const a = asm.assemble(makeCtx());
    const b = asm.assemble(makeCtx({ session: { cwd: '/tmp/demo', now: new Date('2026-10-22T11:00:00Z'), model: 'glm-5.3-flash', contextWindow: 200_000 } }));
    expect(b.staticEntry.fingerprint).toBe(a.staticEntry.fingerprint);
    expect(b.staticEntry.hits).toBe(1);
    // 动态段确实更新了
    expect(b.dynamic.text).not.toBe(a.dynamic.text);
  });

  it('工具变化 → tools 层值变化 → 缓存自动失效（§2.3 MCP 场景）', () => {
    const asm = new SplitPromptAssembler();
    const a = asm.assemble(makeCtx());
    const b = asm.assemble(makeCtx({
      tools: [
        { name: 'read_file', description: '读文件', schema: { type: 'object' } },
        { name: 'mcp_github_search', description: 'GitHub 搜索', schema: { type: 'object' } },
      ],
    }));
    expect(b.staticEntry.fingerprint).not.toBe(a.staticEntry.fingerprint);
    expect(b.staticEntry.hits).toBe(0);
    expect(b.staticEntry.text).toContain('mcp_github_search');
  });

  it('项目记忆变更 → project 层值变化 → 缓存自动失效', () => {
    const asm = new SplitPromptAssembler();
    const a = asm.assemble(makeCtx());
    const b = asm.assemble(makeCtx({ staticMemory: '构建命令：pnpm build' }));
    expect(b.staticEntry.fingerprint).not.toBe(a.staticEntry.fingerprint);
  });

  it('覆盖集变化 → 静态段 key 变化；identity 覆盖告警不改变 key', () => {
    const asm = new SplitPromptAssembler();
    const base = asm.assemble(makeCtx());
    const withOverride = asm.assemble(makeCtx(), {
      project: { environment: '项目级行为准则覆盖' },
    });
    expect(withOverride.staticEntry.fingerprint).not.toBe(base.staticEntry.fingerprint);
    expect(withOverride.staticEntry.text).toContain('项目级行为准则覆盖');

    // locked 层覆盖被忽略，不改变静态值 → 不失效缓存
    const hijack = asm.assemble(makeCtx(), { session: { identity: 'hijack' } });
    expect(hijack.staticEntry.fingerprint).toBe(base.staticEntry.fingerprint);
    expect(hijack.warnings).toHaveLength(1);
  });

  it('静态段含 4 层、动态段含 3 层', () => {
    const asm = new SplitPromptAssembler();
    const r = asm.assemble(makeCtx({ skillIndex: [{ name: 's', description: 'd', triggers: [] }] }));
    expect(r.sections.filter((s) => s.kind === 'static').map((s) => s.id)).toEqual(
      ['identity', 'environment', 'project', 'tools'],
    );
    expect(r.sections.filter((s) => s.kind === 'dynamic').map((s) => s.id)).toEqual(
      ['skills', 'memory', 'session'],
    );
    expect(r.staticEntry.text).toContain('身份与安全基线');
    expect(r.dynamic.text).toContain('Skill 索引');
  });

  it('LRU 容量限制：超限淘汰最旧条目', () => {
    const asm = new SplitPromptAssembler({ cacheSize: 2 });
    asm.assemble(makeCtx({ projectName: 'p1' }));
    asm.assemble(makeCtx({ projectName: 'p2' }));
    asm.assemble(makeCtx({ projectName: 'p3' }));
    expect(asm.cacheStats().size).toBe(2);
    // p1 被淘汰：再次组装 p1 为未命中
    const again = asm.assemble(makeCtx({ projectName: 'p1' }));
    expect(again.staticEntry.hits).toBe(0);
  });

  it('自定义层注入生效（测试隔离）', () => {
    const stub: PromptLayer = {
      id: 'memory',
      title: '记忆',
      locked: false,
      kind: 'dynamic',
      build: () => '召回记忆内容',
    };
    const asm = new SplitPromptAssembler({ layers: [stub] });
    const r = asm.assemble(makeCtx());
    expect(r.sections).toHaveLength(1);
    expect(r.dynamic.text).toBe('## 记忆\n\n召回记忆内容');
  });
});

describe('composeSystemPrompt（Provider 前缀缓存对齐）', () => {
  it('静态在前、动态在后，顺序恒定', () => {
    expect(composeSystemPrompt('STATIC', 'DYNAMIC')).toBe('STATIC\n\nDYNAMIC');
  });

  it('空动态段不产生多余分隔', () => {
    expect(composeSystemPrompt('STATIC', '')).toBe('STATIC');
    expect(composeSystemPrompt('', 'DYNAMIC')).toBe('DYNAMIC');
  });
});
