/**
 * F-39 T04：白名单交集 + 注册表收窄 + 预置技能
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_TOOL_COUNT,
  resolveToolAllow,
  restrictRegistry,
  seedExpertSkills,
  EXPERT_SKILLS_MAX_COUNT,
  EXPERT_SKILLS_MAX_TOKENS,
} from '../src/experts/policy.js';
import { TOOL_CAPABILITY } from '../src/tools/permissions.js';
import { RestrictedRegistry, type RegistryLike } from '../src/engine/roles.js';
import type { ToolResult } from '@delta/shared';

describe('resolveToolAllow', () => {
  const available = ['read_file', 'write_file', 'run_command', 'task'];

  it('缺省 / 空数组 → 不收窄', () => {
    expect(resolveToolAllow(null, available).allow).toBeNull();
    expect(resolveToolAllow(undefined, available).allow).toBeNull();
    expect(resolveToolAllow([], available).allow).toBeNull();
  });

  it('子集 → 交集；未知名进 unknown', () => {
    const r = resolveToolAllow(['read_file', 'write_file', 'ghost'], available);
    expect([...r.allow!].sort()).toEqual(['read_file', 'write_file']);
    expect(r.unknown).toEqual(['ghost']);
    expect(r.restrictedCount).toBe(2);
    expect(r.totalCount).toBe(4);
  });

  it('声明全部不存在 → 回退不收窄（否则专家零工具）', () => {
    const r = resolveToolAllow(['ghost_a', 'ghost_b'], available);
    expect(r.allow).toBeNull();
    expect(r.unknown).toEqual(['ghost_a', 'ghost_b']);
  });
});

describe('restrictRegistry', () => {
  const base: RegistryLike = {
    definitions: () => [
      { name: 'read_file', description: '', parameters: {} },
      { name: 'write_file', description: '', parameters: {} },
    ],
    executeAll: vi.fn(async (calls) =>
      calls.map((c) => ({ callId: c.id, name: c.name, ok: true, content: 'ok' } satisfies ToolResult)),
    ),
  };

  it('allow=null 返回原对象（零开销）', () => {
    expect(restrictRegistry(base, null)).toBe(base);
  });

  it('收窄后 definitions 过滤；越权调用返回 tool_not_allowed 且不进 confirm', async () => {
    const reg = restrictRegistry(base, new Set(['read_file'])) as RestrictedRegistry;
    expect(reg.definitions().map((d) => d.name)).toEqual(['read_file']);
    const results = await reg.executeAll(
      [
        { id: 'c1', name: 'read_file', args: {} },
        { id: 'c2', name: 'write_file', args: {} },
      ],
      {} as never,
    );
    expect(results[0]!.ok).toBe(true);
    expect(results[1]!.error).toBe('tool_not_allowed');
    expect(base.executeAll).toHaveBeenCalledTimes(1); // 只有 read_file 透传
  });
});

describe('BUILTIN_TOOL_COUNT', () => {
  it('与 TOOL_CAPABILITY 键数一致且为 16（task 已计入）', () => {
    expect(BUILTIN_TOOL_COUNT).toBe(16);
    expect(Object.keys(TOOL_CAPABILITY)).toHaveLength(16);
    expect(TOOL_CAPABILITY['task']).toBe('read');
  });
});

describe('seedExpertSkills', () => {
  const makeRuntime = (names: string[]) => ({
    async load(name: string) {
      if (!names.includes(name)) return { ok: false, content: '' };
      return { ok: true, content: `# ${name}\n${'x'.repeat(50)}` };
    },
    unload: () => ({ ok: false, content: '' }),
  });

  it('超过数量上限 → 按顺序只装前 N 个 + warning', async () => {
    const r = await seedExpertSkills(makeRuntime(['a', 'b', 'c', 'd', 'e']), ['a', 'b', 'c', 'd', 'e']);
    expect(r.loaded).toEqual(['a', 'b', 'c']);
    expect(r.warnings.join('\n')).toMatch(/超过 3 个上限/);
    expect(EXPERT_SKILLS_MAX_COUNT).toBe(3);
  });

  it('不存在的技能 → 跳过 + warning，不抛错', async () => {
    const r = await seedExpertSkills(makeRuntime(['a']), ['a', 'missing']);
    expect(r.loaded).toEqual(['a']);
    expect(r.warnings.join('\n')).toMatch(/不存在/);
  });

  it('累计 token 超限 → 截断 + warning', async () => {
    const big = 'y'.repeat(6000); // ~1500 tokens × 3 ≈ 超限
    const runtime = {
      async load(name: string) {
        return { ok: true, content: `${name}:${big}` };
      },
      unload: () => ({ ok: false, content: '' }),
    };
    const r = await seedExpertSkills(runtime, ['a', 'b', 'c', 'd'], { maxTokens: 4096 });
    expect(r.loaded.length).toBeLessThan(4);
    expect(r.warnings.join('\n')).toMatch(/上限/);
    expect(EXPERT_SKILLS_MAX_TOKENS).toBe(4096);
  });
});
