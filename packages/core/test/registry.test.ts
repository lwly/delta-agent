import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ConfirmDecision, ConfirmRequest, ToolCall } from '@y-zero/shared';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/types.js';

let tmpRoot = '';

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    projectRoot: tmpRoot,
    signal: new AbortController().signal,
    confirm: async () => ({ kind: 'allow' }),
    askUser: async (q) => q,
    todos: [],
    ...over,
  };
}

const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: `c_${name}_${Math.random().toString(36).slice(2, 6)}`,
  name,
  argsJson: JSON.stringify(args),
  args,
});

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-registry-'));
});

describe('ToolRegistry', () => {
  it('registers the 15 builtin tools', () => {
    const reg = new ToolRegistry();
    expect(reg.names().sort()).toEqual(
      [
        'ask_user', 'edit_file', 'glob_search', 'grep_search', 'list_dir',
        'read_file', 'run_command', 'run_tests', 'todo_write', 'web_fetch', 'write_file',
        'load_skill', 'unload_skill',
        'save_memory', 'recall_memory',
      ].sort(),
    );
  });

  it('returns unknown_tool for missing tools', async () => {
    const reg = new ToolRegistry();
    const results = await reg.executeAll([call('nope', {})], makeCtx());
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toBe('unknown_tool');
  });

  it('validates args against schema', async () => {
    const reg = new ToolRegistry();
    const results = await reg.executeAll([call('read_file', { offset: 1 })], makeCtx());
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toBe('invalid_args');
  });

  it('preserves result order for parallel calls', async () => {
    const reg = new ToolRegistry();
    await fs.writeFile(path.join(tmpRoot, 'x.ts'), 'const a = 1;');
    const results = await reg.executeAll(
      [call('list_dir', {}), call('read_file', { path: 'x.ts' }), call('glob_search', { pattern: '*.ts' })],
      makeCtx(),
    );
    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(results[1]!.content).toContain('const a = 1;');
  });

  it('runs read tools concurrently (wall time < serial sum)', async () => {
    const reg = new ToolRegistry();
    const slow = {
      name: 'slow_read',
      description: 'test tool that sleeps',
      schema: { type: 'object', properties: { ms: { type: 'number' } } } as Record<string, unknown>,
      danger: 'safe' as const,
      execute: async (args: Record<string, unknown>) => {
        await new Promise((r) => setTimeout(r, Number(args.ms ?? 50)));
        return { callId: '', name: 'slow_read', ok: true, content: 'done' };
      },
    };
    reg.register(slow);
    const t0 = Date.now();
    // 4 × 50ms sleeps: concurrent ≈ 50-150ms, serial would be ≥ 200ms
    await reg.executeAll(
      Array.from({ length: 4 }, () => call('slow_read', { ms: 50 })),
      makeCtx(),
    );
    expect(Date.now() - t0).toBeLessThan(190);
  });

  it('serializes same-file writes but different files run parallel', async () => {
    const reg = new ToolRegistry();
    const real = reg.get('write_file')!;
    const orig = real.execute.bind(real);
    let inFlight = 0;
    let maxInFlight = 0;
    real.execute = async (args, ctx) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 30));
        return await orig(args, ctx);
      } finally {
        inFlight--;
      }
    };

    // two writes to the SAME file must serialize
    await reg.executeAll(
      [call('write_file', { path: 'same.txt', content: '1' }), call('write_file', { path: 'same.txt', content: '2' })],
      makeCtx(),
    );
    expect(maxInFlight).toBe(1);

    // writes to different files may overlap
    maxInFlight = 0;
    await reg.executeAll(
      [call('write_file', { path: 'a.txt', content: '1' }), call('write_file', { path: 'b.txt', content: '2' })],
      makeCtx(),
    );
    expect(maxInFlight).toBe(2);
  });

  it('asks for confirmation on danger tools and honors rejection', async () => {
    const reg = new ToolRegistry();
    const seen: ConfirmRequest[] = [];
    const results = await reg.executeAll(
      [call('write_file', { path: 'a.txt', content: 'hi' })],
      makeCtx({
        confirm: async (req) => {
          seen.push(req);
          return { kind: 'reject', reason: '不要写这个文件' };
        },
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.tool).toBe('write_file');
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toBe('rejected_by_user');
    await expect(fs.access(path.join(tmpRoot, 'a.txt'))).rejects.toThrow();
  });

  it('applies edited args from the confirm decision', async () => {
    const reg = new ToolRegistry();
    const results = await reg.executeAll(
      [call('write_file', { path: 'a.txt', content: 'original' })],
      makeCtx({
        confirm: async () => ({ kind: 'edit', args: { path: 'b.txt', content: 'edited' } }),
      }),
    );
    expect(results[0]!.ok).toBe(true);
    const content = await fs.readFile(path.join(tmpRoot, 'b.txt'), 'utf8');
    expect(content).toBe('edited');
  });

  it('safe tools run without confirmation', async () => {
    const reg = new ToolRegistry();
    let confirmCalls = 0;
    const results = await reg.executeAll(
      [call('list_dir', {})],
      makeCtx({ confirm: async () => { confirmCalls++; return { kind: 'allow' }; } }),
    );
    expect(confirmCalls).toBe(0);
    expect(results[0]!.ok).toBe(true);
  });

  it('sandbox-blocks path escapes inside safe tools', async () => {
    const reg = new ToolRegistry();
    const results = await reg.executeAll([call('read_file', { path: '../secret' })], makeCtx());
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.content).toContain('sandbox');
  });

  it('edit_file requires unique old_string match', async () => {
    const reg = new ToolRegistry();
    await fs.writeFile(path.join(tmpRoot, 'dup.txt'), 'aaa bbb aaa');
    const results = await reg.executeAll(
      [call('edit_file', { path: 'dup.txt', old_string: 'aaa', new_string: 'c' })],
      makeCtx(),
    );
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.content).toContain('2 times');
  });

  it('todo_write maintains the shared todo list', async () => {
    const reg = new ToolRegistry();
    const todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'done' }> = [];
    const results = await reg.executeAll(
      [call('todo_write', { todos: [{ content: 'step1', status: 'done' }, { content: 'step2', status: 'in_progress' }] })],
      makeCtx({ todos }),
    );
    expect(results[0]!.ok).toBe(true);
    expect(todos).toHaveLength(2);
    expect(todos[0]!.status).toBe('done');
  });
});
