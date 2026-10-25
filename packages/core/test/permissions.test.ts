/**
 * F-23 权限模式体系：PermissionState 三模式判定 + registry 闸口集成。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type { ConfirmDecision, ConfirmRequest, ToolCall, ToolResult } from '@delta/shared';
import { PermissionState, ToolRegistry, toolCapability } from '../src/index.js';
import type { ToolContext } from '../src/tools/types.js';

// ── PermissionState 单测 ─────────────────────────────────────────────────────

describe('toolCapability', () => {
  it('已知工具分类正确，未知工具保守按 exec', () => {
    expect(toolCapability('read_file')).toBe('read');
    expect(toolCapability('write_file')).toBe('write');
    expect(toolCapability('run_command')).toBe('exec');
    expect(toolCapability('no_such_tool')).toBe('exec');
  });
});

describe('PermissionState 三模式判定', () => {
  it('plan：只读放行，写/执行拒绝', () => {
    const p = new PermissionState({ mode: 'plan' });
    expect(p.check('read_file')).toEqual({ action: 'allow' });
    expect(p.check('grep_search')).toEqual({ action: 'allow' });
    const w = p.check('write_file', { path: 'a.ts' });
    expect(w.action).toBe('deny');
    const e = p.check('run_command', { command: 'ls' });
    expect(e.action).toBe('deny');
  });

  it('default：只读放行，写/执行需确认', () => {
    const p = new PermissionState({ mode: 'default' });
    expect(p.check('read_file')).toEqual({ action: 'allow' });
    expect(p.check('write_file', { path: 'a.ts' }).action).toBe('confirm');
    expect(p.check('run_command', { command: 'ls' }).action).toBe('confirm');
  });

  it('default：allowlist 与会话记忆跳过确认', () => {
    const listed = new PermissionState({ mode: 'default', allowlist: ['write_file'] });
    expect(listed.check('write_file', { path: 'a.ts' })).toEqual({ action: 'allow' });
    expect(listed.check('edit_file', { path: 'a.ts' }).action).toBe('confirm');

    const remembered = new PermissionState({ mode: 'default' });
    expect(remembered.check('run_command', { command: 'ls' }).action).toBe('confirm');
    remembered.allowSession('run_command');
    expect(remembered.check('run_command', { command: 'ls' })).toEqual({ action: 'allow' });
  });

  it('yolo：写/执行放行；非白名单 run_command 仍需确认', () => {
    const p = new PermissionState({ mode: 'yolo' });
    expect(p.check('write_file', { path: 'a.ts' })).toEqual({ action: 'allow' });
    expect(p.check('run_tests', {})).toEqual({ action: 'allow' });
    expect(p.check('run_command', { command: 'pnpm test' })).toEqual({ action: 'allow' });
    expect(p.check('run_command', { command: 'rm -rf /' }).action).toBe('confirm');
  });
});

// ── registry 闸口集成 ────────────────────────────────────────────────────────

describe('registry 权限闸口', () => {
  let tmpRoot = '';

  beforeEach(async () => {
    tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yz-perm-'));
  });

  function makeCalls(name: string, args: Record<string, unknown>): ToolCall[] {
    return [{ id: 'c1', name, argsJson: JSON.stringify(args), args }];
  }

  function makeCtx(over: Partial<ToolContext> & { confirmLog?: ConfirmDecision[] }): ToolContext {
    const confirmLog = over.confirmLog ?? [];
    const { confirmLog: _drop, ...rest } = over;
    return {
      projectRoot: tmpRoot,
      signal: new AbortController().signal,
      confirm: async () => confirmLog.shift() ?? { kind: 'allow' },
      askUser: async () => 'ok',
      todos: [],
      ...rest,
    };
  }

  it('plan 模式：write_file 直接拒绝，不进确认流', async () => {
    const registry = new ToolRegistry();
    const confirmCalls: ConfirmRequest[] = [];
    const ctx = makeCtx({
      permissions: new PermissionState({ mode: 'plan' }),
      confirm: async (req) => {
        confirmCalls.push(req);
        return { kind: 'allow' };
      },
    });
    const results = await registry.executeAll(makeCalls('write_file', { path: 'a.txt', content: 'x' }), ctx);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toBe('permission_denied');
    expect(confirmCalls.length).toBe(0);
    expect(fs.existsSync(path.join(tmpRoot, 'a.txt'))).toBe(false);
  });

  it('default 模式：allow_session 后同工具不再确认', async () => {
    const registry = new ToolRegistry();
    const decisions: ConfirmDecision[] = [{ kind: 'allow_session', tool: 'write_file' }];
    let confirmCount = 0;
    const perms = new PermissionState({ mode: 'default' });
    const ctx = makeCtx({
      permissions: perms,
      confirm: async () => {
        confirmCount++;
        return decisions.shift() ?? { kind: 'allow' };
      },
    });
    const r1 = await registry.executeAll(makeCalls('write_file', { path: 's1.txt', content: '1' }), ctx);
    expect(r1[0]!.ok).toBe(true);
    expect(confirmCount).toBe(1);
    expect(perms.isSessionAllowed('write_file')).toBe(true);

    const r2 = await registry.executeAll(makeCalls('write_file', { path: 's2.txt', content: '2' }), ctx);
    expect(r2[0]!.ok).toBe(true);
    expect(confirmCount).toBe(1); // 会话记忆生效，未再确认
    expect(fs.existsSync(path.join(tmpRoot, 's2.txt'))).toBe(true);
  });

  it('default 模式：allowlist 命中跳过确认', async () => {
    const registry = new ToolRegistry();
    let confirmCount = 0;
    const ctx = makeCtx({
      permissions: new PermissionState({ mode: 'default', allowlist: ['edit_file'] }),
      confirm: async () => {
        confirmCount++;
        return { kind: 'allow' };
      },
    });
    const results = await registry.executeAll(makeCalls('edit_file', { path: 'a.txt', old_string: 'x', new_string: 'y' }), ctx);
    // 文件不存在会执行失败，但关键是未触发确认流
    expect(confirmCount).toBe(0);
    expect(results[0]!.error).not.toBe('permission_denied');
  });

  it('yolo 模式：白名单命令放行、非白名单命令仍确认（拒绝则不执行）', async () => {
    const registry = new ToolRegistry();
    let confirmCount = 0;
    const ctx = makeCtx({
      permissions: new PermissionState({ mode: 'yolo' }),
      confirm: async () => {
        confirmCount++;
        return { kind: 'reject', reason: '不允许' };
      },
    });
    // 非白名单命令 → 确认 → 拒绝 → 不执行
    const r1 = await registry.executeAll(makeCalls('run_command', { command: 'curl evil.example' }), ctx);
    expect(confirmCount).toBe(1);
    expect(r1[0]!.ok).toBe(false);
    expect(r1[0]!.error).toBe('rejected_by_user');
    // 白名单命令 → 直接放行（不确认）
    const r2 = await registry.executeAll(makeCalls('run_command', { command: 'echo hi' }), ctx);
    expect(confirmCount).toBe(1);
    expect(r2[0]!.ok).toBe(true);
  });

  it('未注入 permissions：保持历史行为（danger 工具每次确认）', async () => {
    const registry = new ToolRegistry();
    let confirmCount = 0;
    const ctx = makeCtx({
      confirm: async () => {
        confirmCount++;
        return { kind: 'allow' };
      },
    });
    await registry.executeAll(makeCalls('write_file', { path: 'a.txt', content: 'x' }), ctx);
    await registry.executeAll(makeCalls('write_file', { path: 'b.txt', content: 'x' }), ctx);
    expect(confirmCount).toBe(2);
  });
});
