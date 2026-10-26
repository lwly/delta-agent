/**
 * F-39 T07：白名单执行接线（AC-1 / AC-2 / L4 同源）
 */
import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ToolRegistry } from '../src/tools/registry.js';
import { PermissionState } from '../src/tools/permissions.js';
import { resolveToolAllow, restrictRegistry, BUILTIN_TOOL_COUNT } from '../src/experts/policy.js';
import { buildAssembleContext } from '../src/experts/assemble-context.js';
import { parseExpertPackage, type ParseInput } from '../src/experts/parser.js';
import type { ToolResult } from '@delta/shared';

const READ_ONLY = ['read_file', 'list_dir', 'glob_search', 'grep_search', 'web_fetch', 'todo_write', 'ask_user', 'task'];

function recordWithTools(tools: string[] | null) {
  const input: ParseInput = {
    dir: '/tmp/ro',
    layer: 'builtin',
    name: 'ro',
    expertJson: JSON.stringify({
      name: 'ro',
      version: '1.0.0',
      description: '',
      author: { name: 't' },
      expertType: 'agent',
      agentName: 'ro-agent',
      agents: ['agents/ro-agent.md'],
      displayName: { en: 'RO', zh: '只读审查官' },
      profession: { en: 'R', zh: '审查' },
      ...(tools ? { tools } : {}),
    }),
    agentFiles: new Map([['ro-agent.md', { raw: '---\nname: ro-agent\ndescription: x\ndisplayName_zh: ro\nprofession_zh: 审查\n---\n\n只读正文', absPath: '/x' }]]),
    avatarPath: null,
  };
  return parseExpertPackage(input);
}

describe('AC-1 / AC-2：角色边界与权限模式正交', () => {
  const makeBase = () => {
    const base = new ToolRegistry();
    return base;
  };

  const executeWrite = async (registry: ToolRegistry, mode: 'default' | 'yolo', root: string): Promise<ToolResult> => {
    const allow = resolveToolAllow(READ_ONLY, registry.definitions().map((d) => d.name));
    const reg = restrictRegistry(registry, allow.allow);
    const results = await reg.executeAll(
      [{ id: 'c1', name: 'write_file', args: { path: 'evil.txt', content: 'x' } }],
      {
        projectRoot: root,
        signal: new AbortController().signal,
        confirm: async () => ({ kind: 'allow' }),
        askUser: async () => 'ok',
        todos: [],
        permissions: new PermissionState({ mode }),
      } as never,
    );
    return results[0]!;
  };

  it('AC-1：只读专家 + default → tool_not_allowed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-expert-e2e-'));
    try {
      const r = await executeWrite(makeBase(), 'default', root);
      expect(r.ok).toBe(false);
      expect(r.error).toBe('tool_not_allowed');
      await expect(fs.access(path.join(root, 'evil.txt'))).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('AC-2：只读专家 + yolo → 仍被拒', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-expert-e2e-'));
    try {
      const r = await executeWrite(makeBase(), 'yolo', root);
      expect(r.ok).toBe(false);
      expect(r.error).toBe('tool_not_allowed');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('L4 与执行同源', () => {
  it('绑定只读专家 → L4 工具清单无 write_file；专家段已注入', () => {
    const registry = new ToolRegistry();
    const allow = resolveToolAllow(READ_ONLY, registry.definitions().map((d) => d.name));
    const runRegistry = restrictRegistry(registry, allow.allow);
    const ctx = buildAssembleContext({
      projectName: 'demo',
      projectInstructions: '',
      tools: runRegistry.definitions(),
      skillIndex: [],
      session: { cwd: '/tmp', now: new Date(), model: 'm', contextWindow: 1000 },
      expert: recordWithTools(READ_ONLY),
    });
    const names = ctx.tools.map((t) => t.name);
    expect(names).not.toContain('write_file');
    expect(names).toContain('task');
    expect(ctx.expert?.name).toBe('ro');
  });

  it('非专家会话：不收窄、不注入（零回归）', () => {
    const registry = new ToolRegistry();
    const allow = resolveToolAllow(null, registry.definitions().map((d) => d.name));
    const runRegistry = restrictRegistry(registry, allow.allow);
    expect(runRegistry).toBe(registry);
    const ctx = buildAssembleContext({
      projectName: 'demo',
      projectInstructions: '',
      tools: registry.definitions(),
      skillIndex: [],
      session: { cwd: '/tmp', now: new Date(), model: 'm', contextWindow: 1000 },
    });
    expect(ctx.tools.map((t) => t.name)).toContain('write_file');
    expect(ctx.expert).toBeUndefined();
  });

  it('BUILTIN_TOOL_COUNT 与内置注册表一致', () => {
    expect(new ToolRegistry().definitions().filter((d) => d.name !== 'task' || true).length).toBe(BUILTIN_TOOL_COUNT);
  });
});
