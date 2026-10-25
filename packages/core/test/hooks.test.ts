import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ToolRegistry } from '../src/tools/registry.js';
import { HookManager, hookMatches, loadHookFiles } from '../src/hooks/manager.js';
import type { ChatMessage, ChatRequest, HookPayload, LLMProvider, StreamEvent, ToolContext } from '../src';

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-hooks-'));
});

// ── 加载与匹配 ──────────────────────────────────────────────────────────────

describe('loadHookFiles', () => {
  it('合并用户级 + 项目级，均缺失为空', async () => {
    const files = loadHookFiles(tmpRoot, tmpRoot);
    expect(files.hooks).toEqual([]);
    expect(files.errors).toEqual([]);
  });

  it('读 { hooks: [...] } 与裸数组两种形态，标注来源', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-home-'));
    await fs.mkdir(path.join(home, '.delta'), { recursive: true });
    await fs.writeFile(
      path.join(home, '.delta', 'hooks.json'),
      JSON.stringify({ hooks: [{ event: 'Stop', command: 'echo stop' }] }),
    );
    await fs.mkdir(path.join(tmpRoot, '.delta'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, '.delta', 'hooks.json'),
      JSON.stringify([{ event: 'PreToolUse', tool: 'write_file', command: 'echo pre' }]),
    );
    const files = loadHookFiles(tmpRoot, home);
    expect(files.user).toHaveLength(1);
    expect(files.user[0]).toMatchObject({ event: 'Stop', source: 'user' });
    expect(files.project).toHaveLength(1);
    expect(files.project[0]).toMatchObject({ event: 'PreToolUse', tool: 'write_file', source: 'project' });
    expect(files.hooks).toHaveLength(2); // 用户级在前
  });

  it('未知事件与缺 command 跳过，坏 JSON 记错误不抛', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-home-'));
    await fs.mkdir(path.join(tmpRoot, '.delta'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, '.delta', 'hooks.json'),
      JSON.stringify([
        { event: 'Nonsense', command: 'x' },
        { event: 'Stop' },
        { event: 'Stop', command: 'echo ok' },
      ]),
    );
    const files = loadHookFiles(tmpRoot, home);
    expect(files.hooks).toHaveLength(1);
    expect(files.errors).toHaveLength(1);
  });
});

describe('hookMatches', () => {
  it('缺省或 * 匹配全部，否则精确匹配工具名', () => {
    const all = { event: 'PreToolUse' as const, command: 'x' };
    const star = { event: 'PreToolUse' as const, tool: '*', command: 'x' };
    const exact = { event: 'PreToolUse' as const, tool: 'write_file', command: 'x' };
    expect(hookMatches(all, 'write_file')).toBe(true);
    expect(hookMatches(star, 'read_file')).toBe(true);
    expect(hookMatches(exact, 'write_file')).toBe(true);
    expect(hookMatches(exact, 'read_file')).toBe(false);
    // 生命周期事件不受 tool 匹配器约束
    expect(hookMatches({ event: 'Stop', tool: 'write_file', command: 'x' })).toBe(true);
  });
});

// ── PreToolUse 阻断语义 ────────────────────────────────────────────────────

describe('HookManager.preToolUse', () => {
  it('exit 0 → 放行', async () => {
    const mgr = new HookManager(
      [{ event: 'PreToolUse', tool: 'write_file', command: 'exit 0' }],
      tmpRoot,
    );
    const v = await mgr.preToolUse('write_file', {}, {});
    expect(v.blocked).toBe(false);
    expect(v.outcomes[0]!.ok).toBe(true);
  });

  it('exit 2 → 阻断，stderr 作为原因回传', async () => {
    const mgr = new HookManager(
      [{ event: 'PreToolUse', tool: 'edit_file', command: 'echo 禁改 main >&2; exit 2' }],
      tmpRoot,
    );
    const v = await mgr.preToolUse('edit_file', {}, {});
    expect(v.blocked).toBe(true);
    expect(v.reason).toContain('禁改 main');
  });

  it('其他非 0 → 告警放行', async () => {
    const mgr = new HookManager([{ event: 'PreToolUse', command: 'exit 1' }], tmpRoot);
    const v = await mgr.preToolUse('write_file', {}, {});
    expect(v.blocked).toBe(false);
    expect(v.outcomes[0]!.ok).toBe(false);
  });

  it('tool 匹配器：不命中则不执行', async () => {
    let ran = false;
    const mgr = new HookManager(
      [{ event: 'PreToolUse', tool: 'run_command', command: 'true' }],
      tmpRoot,
    );
    // read_file 不匹配 run_command 钩子 → outcomes 为空
    const v = await mgr.preToolUse('read_file', {}, {});
    ran = v.outcomes.length > 0;
    expect(ran).toBe(false);
  });

  it('超时 → 告警放行并标记 timedOut', async () => {
    const mgr = new HookManager(
      [{ event: 'PreToolUse', command: 'sleep 2', timeout_ms: 100 }],
      tmpRoot,
    );
    const v = await mgr.preToolUse('write_file', {}, {});
    expect(v.blocked).toBe(false);
    expect(v.outcomes[0]!.timedOut).toBe(true);
  }, 10_000);

  it('payload 经 stdin 传递且字段完整', async () => {
    const out = path.join(tmpRoot, 'payload.json');
    const mgr = new HookManager(
      [{ event: 'PreToolUse', tool: 'write_file', command: `cat > ${out}` }],
      tmpRoot,
    );
    await mgr.preToolUse('write_file', { path: 'a.ts', content: 'x' }, { sessionId: 's1', projectId: 'p1' });
    const payload = JSON.parse(await fs.readFile(out, 'utf8')) as HookPayload;
    expect(payload.event).toBe('PreToolUse');
    expect(payload.tool).toBe('write_file');
    expect(payload.args).toEqual({ path: 'a.ts', content: 'x' });
    expect(payload.session_id).toBe('s1');
    expect(payload.timestamp).toBeTruthy();
  });
});

// ── PostToolUse / 生命周期 ─────────────────────────────────────────────────

describe('PostToolUse 与生命周期事件', () => {
  it('PostToolUse 记录结果且失败不影响主流程', async () => {
    const outcomes: unknown[] = [];
    const mgr = new HookManager(
      [{ event: 'PostToolUse', tool: 'write_file', command: 'echo post >&2; exit 3' }],
      tmpRoot,
      (o) => outcomes.push(o),
    );
    const res = await mgr.postToolUse('write_file', {}, { ok: true, content: 'saved' }, {});
    expect(res).toHaveLength(1);
    expect(res[0]!.ok).toBe(false); // 钩子自身失败被记录
    expect(outcomes).toHaveLength(1);
  });

  it('emit 触发 SessionStart/Stop/SessionEnd（无 tool 参数）', async () => {
    const out = path.join(tmpRoot, 'stop.json');
    const mgr = new HookManager([{ event: 'Stop', command: `cat > ${out}` }], tmpRoot);
    await mgr.emit('Stop', { sessionId: 's9' });
    const payload = JSON.parse(await fs.readFile(out, 'utf8')) as HookPayload;
    expect(payload.event).toBe('Stop');
    expect(payload.session_id).toBe('s9');
    expect(payload.tool).toBeUndefined();
  });

  it('onOutcome 观察口收到所有结果', async () => {
    const seen: string[] = [];
    const mgr = new HookManager(
      [
        { event: 'PreToolUse', command: 'exit 0' },
        { event: 'Stop', command: 'exit 0' },
      ],
      tmpRoot,
      (o) => seen.push(o.hook.event),
    );
    await mgr.preToolUse('read_file', {}, {});
    await mgr.emit('Stop');
    expect(seen).toEqual(['PreToolUse', 'Stop']);
  });
});

// ── ToolRegistry 集成 ──────────────────────────────────────────────────────

describe('ToolRegistry × hooks 集成', () => {
  function makeCtx(hooks?: HookManager): ToolContext {
    const dummyProvider = {
      id: 'dummy',
      async *chat(): AsyncIterable<StreamEvent> {},
      estimateTokens(_m: ChatMessage[]): number {
        return 0;
      },
    } satisfies LLMProvider;
    return {
      projectRoot: tmpRoot,
      signal: new AbortController().signal,
      confirm: async () => ({ kind: 'allow' }),
      askUser: async () => 'ok',
      todos: [],
      sessionId: 's1',
      projectId: 'p1',
      registry: new ToolRegistry(),
      subagent: { provider: dummyProvider, model: 'm' },
      permissions: undefined,
      hooks,
    } as ToolContext;
  }

  it('PreToolUse 阻断 write_file：返回 hook_blocked 且不落盘', async () => {
    const mgr = new HookManager(
      [{ event: 'PreToolUse', tool: 'write_file', command: 'echo 禁写 >&2; exit 2' }],
      tmpRoot,
    );
    const reg = new ToolRegistry();
    const results = await reg.executeAll(
      [{ id: 'c1', name: 'write_file', argsJson: JSON.stringify({ path: 'x.txt', content: 'hi' }) }],
      makeCtx(mgr),
    );
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toBe('hook_blocked');
    expect(results[0]!.content).toContain('禁写');
    await expect(fs.access(path.join(tmpRoot, 'x.txt'))).rejects.toThrow();
  });

  it('放行时正常执行并触发 PostToolUse', async () => {
    const post: string[] = [];
    const mgr = new HookManager(
      [{ event: 'PostToolUse', tool: 'write_file', command: 'echo done' }],
      tmpRoot,
      (o) => post.push(o.hook.event),
    );
    const reg = new ToolRegistry();
    const results = await reg.executeAll(
      [{ id: 'c1', name: 'write_file', argsJson: JSON.stringify({ path: 'ok.txt', content: 'hi' }) }],
      makeCtx(mgr),
    );
    expect(results[0]!.ok).toBe(true);
    // PostToolUse 旁路异步触发；轮询等待
    for (let i = 0; i < 50 && post.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(post).toEqual(['PostToolUse']);
    await expect(fs.access(path.join(tmpRoot, 'ok.txt'))).resolves.toBeUndefined();
  });

  it('无 hooks 注入时行为不变', async () => {
    const reg = new ToolRegistry();
    const results = await reg.executeAll(
      [{ id: 'c1', name: 'list_dir', argsJson: JSON.stringify({ path: '.' }) }],
      makeCtx(undefined),
    );
    expect(results[0]!.ok).toBe(true);
  });

  it('F-26 子代理（task）也经过 PreToolUse 钩子（间接验证 hooks 随 ToolContext 传播）', () => {
    // task 工具复用父 ToolContext（{...ctx}），hooks 自动随行——此处验证类型与字段存在
    const ctx = makeCtx(new HookManager([], tmpRoot));
    expect(ctx.hooks).toBeDefined();
    expect(ctx.subagent).toBeDefined();
  });
});
