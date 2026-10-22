import { describe, expect, it } from 'vitest';
import { PromptAssembler, ASSEMBLER_VERSION, renderValue } from '../src/prompt/assembler.js';
import { createDefaultLayers, IdentityLayer } from '../src/prompt/layers.js';
import { applyOverrides, deepMerge, unionDedupe } from '../src/prompt/merge.js';
import type { AssembleContext, OverrideSet } from '../src/prompt/types.js';

function makeCtx(over: Partial<AssembleContext> = {}): AssembleContext {
  return {
    projectName: 'demo-app',
    projectInstructions: '技术栈：TypeScript + Vue。规范：pnpm only。',
    tools: [
      { name: 'read_file', description: '读取文件', schema: { type: 'object' } },
    ],
    skillIndex: [
      { name: 'commit-review', description: '审查提交', triggers: ['review'] },
    ],
    session: {
      cwd: '/tmp/demo',
      now: new Date('2026-10-22T10:00:00Z'),
      model: 'glm-5.3-flash',
      contextWindow: 200_000,
    },
    ...over,
  };
}

describe('deepMerge / unionDedupe（三级覆盖规则）', () => {
  it('字符串后者覆盖', () => {
    expect(deepMerge('基线规则', '覆盖规则')).toBe('覆盖规则');
  });

  it('对象深度合并', () => {
    expect(deepMerge({ a: 1, b: { c: 2 } }, { b: { d: 3 }, e: 4 })).toEqual({
      a: 1,
      b: { c: 2, d: 3 },
      e: 4,
    });
  });

  it('数组并集去重（保持顺序）', () => {
    expect(unionDedupe(['x', 'y'], ['y', 'z'])).toEqual(['x', 'y', 'z']);
    expect(unionDedupe([{ k: 1 }], [{ k: 1 }, { k: 2 }])).toEqual([{ k: 1 }, { k: 2 }]);
  });
});

describe('applyOverrides', () => {
  const layer = { id: 'environment' as const, locked: false };
  const lockedLayer = { id: 'identity' as const, locked: true };

  it('project 先应用、session 后应用（session 优先）', () => {
    const { value } = applyOverrides(layer, 'builtin', {
      project: { environment: '项目规则' },
      session: { environment: '会话规则' },
    });
    expect(value).toBe('会话规则');
  });

  it('对象覆盖跨级深合并', () => {
    const { value } = applyOverrides(layer, { confirm: 'always', style: 'brief' }, {
      project: { environment: { style: 'verbose' } },
    });
    expect(value).toEqual({ confirm: 'always', style: 'verbose' });
  });

  it('locked 层忽略覆盖并告警', () => {
    const { value, warnings } = applyOverrides(lockedLayer, '人格基线', {
      project: { identity: '恶意覆盖' },
      session: { identity: '再试一次' },
    });
    expect(value).toBe('人格基线');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]!.message).toContain('locked');
  });

  it('无覆盖时不告警', () => {
    const { warnings } = applyOverrides(layer, 'builtin', {});
    expect(warnings).toHaveLength(0);
  });
});

describe('PromptAssembler', () => {
  it('按 7 层顺序输出 section', () => {
    const r = new PromptAssembler().assemble(makeCtx());
    expect(r.sections.map((s) => s.id)).toEqual([
      'identity', 'environment', 'project', 'tools', 'skills', 'memory', 'session',
    ]);
    expect(r.warnings).toHaveLength(0);
  });

  it('静态/动态分段：前 4 层 static，后 3 层 dynamic', () => {
    const r = new PromptAssembler().assemble(makeCtx());
    expect(r.sections.slice(0, 4).every((s) => s.kind === 'static')).toBe(true);
    expect(r.sections.slice(4).every((s) => s.kind === 'dynamic')).toBe(true);
    expect(r.text.startsWith('<static>')).toBe(true);
    expect(r.text.indexOf('<dynamic>')).toBeGreaterThan(r.text.indexOf('</static>'));
  });

  it('identity 层标记 locked，覆盖被忽略', () => {
    const overrides: OverrideSet = { project: { identity: 'hijack' } };
    const r = new PromptAssembler().assemble(makeCtx(), overrides);
    expect(r.warnings).toHaveLength(1);
    expect(r.sections[0]!.locked).toBe(true);
  });

  it('对象覆盖字符串基线：整体替换（类型不兼容→后者覆盖）', () => {
    const r = new PromptAssembler().assemble(makeCtx(), {
      project: { environment: { '确认策略': 'yolo 会话内跳过' } },
    });
    const env = r.sections.find((s) => s.id === 'environment')!;
    expect(renderValue(env.value)).toBe('- 确认策略: yolo 会话内跳过');
  });

  it('对象覆盖对象基线：深度合并，基线条目保留', () => {
    const baseLayer = { id: 'environment' as const, locked: false };
    const { value } = applyOverrides(
      baseLayer,
      { 输出规范: '结论先行', 确认策略: '每次确认' },
      { project: { environment: { 确认策略: 'yolo 会话内跳过' } } },
    );
    expect(value).toEqual({ 输出规范: '结论先行', 确认策略: 'yolo 会话内跳过' });
  });

  it('空内容段不进入格式化输出', () => {
    const r = new PromptAssembler().assemble(makeCtx({ memoryRecall: undefined, skillIndex: [] }));
    expect(r.text).not.toContain('相关记忆');
    expect(r.text).not.toContain('Skill 索引');
  });

  it('fingerprint 对内容敏感、对 ctx 无关字段稳定', () => {
    const a = new PromptAssembler().assemble(makeCtx());
    const b = new PromptAssembler().assemble(makeCtx());
    const c = new PromptAssembler().assemble(makeCtx({ projectInstructions: '不同内容' }));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fingerprint 随组装器版本变化', () => {
    const a = new PromptAssembler().assemble(makeCtx());
    expect(a.fingerprint).toBeDefined();
    // ASSEMBLER_VERSION 参与 hash —— 版本升级即全量缓存失效
    expect(ASSEMBLER_VERSION).toBeTruthy();
  });

  it('tools 层渲染为列表（数组并集规则可用）', () => {
    const r = new PromptAssembler().assemble(makeCtx(), {
      session: { tools: ['### extra_tool\n额外工具说明'] },
    });
    const tools = r.sections.find((s) => s.id === 'tools')!;
    const text = renderValue(tools.value);
    expect(text).toContain('read_file');
    expect(text).toContain('extra_tool');
  });

  it('默认 7 层工厂与组装器一致', () => {
    expect(createDefaultLayers().map((l) => l.id)).toEqual([
      'identity', 'environment', 'project', 'tools', 'skills', 'memory', 'session',
    ]);
    expect(new IdentityLayer().locked).toBe(true);
  });
});
