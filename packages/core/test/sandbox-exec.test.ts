/**
 * T03 —— run_command / run_tests 沙箱接线单测（设计 §11 / §14「sandbox-exec 12 例」）。
 *
 * 覆盖面：
 *  - Z1 golden（AC-30-1）：`ctx.sandbox === undefined` 时 `run_command` 的 result.content
 *    与历史行为**逐字符一致**（含 `[exit code: N]` 尾巴），且 meta 为 undefined
 *  - AC-30-4：路径逃逸（'../..'）在**任何后端调用之前**被拒——spy 执行器零调用
 *  - 注入 SandboxExecutor：meta.sandbox 透传、hints 追加、denied → fail(diagnostic)
 *  - run_tests：ok 判定保持 `code === 0`（历史口径 D11/R9，timedOut 也算过）
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommandTool, runTestsTool } from '../src/tools/builtin/exec.js';
import type { SandboxExecutor, SandboxExecResult, RunOptions } from '../src/sandbox/index.js';
import type { SandboxMeta } from '../src/sandbox/types.js';
import type { ToolContext } from '../src/tools/types.js';
import type { ToolResult } from '@delta/shared';

// ── 测试基建 ────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    projectRoot: mkdtempSync(join(tmpdir(), 'delta-exec-')),
    signal: new AbortController().signal,
    confirm: async () => ({ kind: 'allow' }),
    askUser: async () => '',
    todos: [],
    ...overrides,
  };
}

/** 可编程 spy 执行器：记录调用并回放脚本结果。 */
function makeSpyExecutor(script: Partial<SandboxExecResult> = {}): {
  executor: SandboxExecutor;
  calls: Array<{ command: string; opts: RunOptions }>;
} {
  const calls: Array<{ command: string; opts: RunOptions }> = [];
  const executor: SandboxExecutor = {
    mode: 'local',
    resolveConfig: () => {
      throw new Error('not used');
    },
    probe: async () => {
      throw new Error('not used');
    },
    badge: () => ({ mode: 'local' }),
    async run(command: string, opts: RunOptions): Promise<SandboxExecResult> {
      calls.push({ command, opts });
      return {
        code: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        hints: [],
        ...script,
      };
    },
  };
  return { executor, calls };
}

// ── Z1 golden：缺省路径逐字符一致（AC-30-1）────────────────────────────────

describe('Z1 golden：ctx.sandbox 缺省 → 历史行为逐字节一致', () => {
  it('echo 成功：content = "yz-shell-ok\\n\\n[exit code: 0]"（echo 尾随换行 + 尾巴换行），meta 为 undefined', async () => {
    const r: ToolResult = await runCommandTool.execute({ command: 'echo yz-shell-ok' }, makeCtx());
    expect(r.ok).toBe(true);
    expect(r.content).toBe('yz-shell-ok\n\n[exit code: 0]');
    expect(r.meta).toBeUndefined();
  });

  it('失败命令：空输出时 content = "\\n[exit code: 1]"（空段被 filter(Boolean) 剔除，尾巴换行保留——历史口径），ok=false', async () => {
    const r = await runCommandTool.execute({ command: 'false' }, makeCtx());
    expect(r.ok).toBe(false);
    expect(r.content).toBe('\n[exit code: 1]');
    expect(r.meta).toBeUndefined();
  });

  it('stderr 保留在 stdout 之前、尾巴在最后（与历史 trimOutput 口径一致）', async () => {
    const r = await runCommandTool.execute(
      { command: 'echo out-line; echo err-line >&2' },
      makeCtx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toBe('out-line\n\nerr-line\n\n[exit code: 0]');
  });

  it('超时：尾巴为 "[command timed out]"（历史口径）', async () => {
    const r = await runCommandTool.execute(
      { command: 'sleep 5', timeout: 200 },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.content.endsWith('[command timed out]')).toBe(true);
  }, 10_000);
});

// ── AC-30-4：路径逃逸在任何后端调用之前被拒 ────────────────────────────────

describe('AC-30-4：路径逃逸在任何后端调用之前被拒', () => {
  // 注：逃逸由第一道闸 resolveInSandbox 以异常拒绝（历史行为），注册表层统一转为 ok:false。
  it("cwd='../../' 逃逸 → 抛 SandboxPathError 且 spy 执行器零调用", async () => {
    const { executor, calls } = makeSpyExecutor();
    const ctx = makeCtx({ sandbox: executor });
    await expect(
      runCommandTool.execute({ command: 'echo hi', cwd: '../../' }, ctx),
    ).rejects.toThrow(/path escapes/);
    expect(calls).toHaveLength(0);
  });

  it('cwd 绝对路径越界（/etc）→ 抛 SandboxPathError 且 spy 执行器零调用', async () => {
    const { executor, calls } = makeSpyExecutor();
    const ctx = makeCtx({ sandbox: executor });
    await expect(
      runCommandTool.execute({ command: 'echo hi', cwd: '/etc' }, ctx),
    ).rejects.toThrow(/path escapes/);
    expect(calls).toHaveLength(0);
  });
});

// ── 注入执行器：meta / hints / denied ──────────────────────────────────────

describe('注入 SandboxExecutor：meta 与诊断透传', () => {
  const META: SandboxMeta = {
    mode: 'seatbelt',
    network: 'none',
    exitCode: 0,
    ms: 12,
    pulled: false,
    profile: '/tmp/profile.sb',
  };

  it('成功：ok() 带 meta.sandbox，内容 = trimOutput + hints', async () => {
    const { executor } = makeSpyExecutor({
      code: 0,
      stdout: 'hi',
      hints: ['[sandbox] 网络提示'],
      sandbox: META,
    });
    const r = await runCommandTool.execute({ command: 'echo hi' }, makeCtx({ sandbox: executor }));
    expect(r.ok).toBe(true);
    expect(r.content).toBe('hi\n[exit code: 0]\n[sandbox] 网络提示');
    expect(r.meta?.sandbox).toEqual(META);
  });

  it('denied：fail(diagnostic)，ok=false，不走 trimOutput', async () => {
    const { executor } = makeSpyExecutor({
      code: null,
      denied: true,
      diagnostic: '[sandbox] Docker 不可用：…\n  下一步任选其一：',
      hints: [],
    });
    const r = await runCommandTool.execute({ command: 'echo hi' }, makeCtx({ sandbox: executor }));
    expect(r.ok).toBe(false);
    expect(r.content).toBe('[sandbox] Docker 不可用：…\n  下一步任选其一：');
    expect(r.content).not.toContain('[exit code:');
  });

  it('执行后端收到的是 resolveInSandbox 归一后的项目内绝对路径 cwd', async () => {
    const { executor, calls } = makeSpyExecutor({ stdout: 'ok' });
    const ctx = makeCtx({ sandbox: executor });
    await runCommandTool.execute({ command: 'echo hi', cwd: 'sub' }, ctx);
    // sub 不存在 → resolveInSandbox 允许（第一道闸只做越界判定），cwd 为项目内绝对路径。
    // macOS /var/folders → /private/var 软链：与 realpath 后的项目根比较。
    const { realpathSync } = await import('node:fs');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts.cwd.startsWith(realpathSync(ctx.projectRoot))).toBe(true);
    expect(calls[0]!.command).toBe('echo hi');
  });
});

// ── run_tests：历史 ok 口径锁定（R9/D11）───────────────────────────────────

describe('run_tests：ok 判定保持 code === 0（timedOut 也算过）', () => {
  it('package.json test script + 退出码 0（即使 timedOut）→ ok=true 且带 meta', async () => {
    const root = mkdtempSync(join(tmpdir(), 'delta-exec-pkg-'));
    const fs = await import('node:fs');
    fs.writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'echo suite' } }));
    const { executor } = makeSpyExecutor({
      code: 0,
      timedOut: true, // R9：历史口径只看 code
      stdout: 'suite-ok',
      sandbox: { mode: 'local', exitCode: 0, ms: 5, pulled: false },
    });
    const r = await runTestsTool.execute({}, makeCtx({ projectRoot: root, sandbox: executor }));
    expect(r.ok).toBe(true);
    expect(r.meta?.sandbox?.mode).toBe('local');
    expect(r.content).toContain('suite-ok');
    expect(r.content).toContain('[command timed out]');
  });

  it('package.json test script 退出码非 0 → fail', async () => {
    const root = mkdtempSync(join(tmpdir(), 'delta-exec-pkg-'));
    const fs = await import('node:fs');
    fs.writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'echo suite' } }));
    const { executor } = makeSpyExecutor({ code: 1, stdout: 'boom' });
    const r = await runTestsTool.execute({}, makeCtx({ projectRoot: root, sandbox: executor }));
    expect(r.ok).toBe(false);
    expect(r.content).toContain('boom');
  });
});
