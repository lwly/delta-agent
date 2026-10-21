import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { ok, fail, type AgentTool } from '../types.js';
import { resolveInSandbox, isWhitelistedCommand } from '../sandbox.js';

export const DEFAULT_CMD_TIMEOUT_MS = 120_000;
export const MAX_CMD_OUTPUT = 20_000;

export interface ShellResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Cross-platform shell spawn: PowerShell on win32, /bin/sh elsewhere. */
export function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const bin = isWin ? 'powershell.exe' : '/bin/sh';
    const args = isWin ? ['-NoProfile', '-Command', command] : ['-c', command];
    const child = spawn(bin, args, { cwd, env: process.env, windowsHide: true });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const onAbort = () => {
      timedOut = false;
      child.kill('SIGKILL');
    };
    signal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (d) => (stdout += String(d)));
    child.stderr?.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ code: -1, stdout, stderr: stderr + String(e.message), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export function trimOutput(r: ShellResult): string {
  const parts = [
    r.stdout.length > MAX_CMD_OUTPUT ? r.stdout.slice(0, MAX_CMD_OUTPUT) + '\n...[stdout truncated]' : r.stdout,
    r.stderr ? (r.stderr.length > 4000 ? r.stderr.slice(0, 4000) + '\n...[stderr truncated]' : r.stderr) : '',
  ].filter(Boolean);
  const tail = r.timedOut ? '\n[command timed out]' : `\n[exit code: ${r.code}]`;
  return parts.join('\n') + tail;
}

// ── run_command ────────────────────────────────────────────────────────────

export const runCommandTool: AgentTool = {
  name: 'run_command',
  description:
    'Execute a shell command in the project directory. High-risk tool: requires user confirmation by default.',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      cwd: { type: 'string', description: 'relative directory to run in (default project root)' },
      timeout: { type: 'number', description: 'timeout in ms (default 120000, max 600000)' },
    },
    required: ['command'],
  },
  danger: 'confirm',
  async execute(args, ctx) {
    const command = String(args.command ?? '');
    if (!command.trim()) return fail('command is empty');
    const cwd = await resolveInSandbox(ctx.projectRoot, String(args.cwd ?? '.'));
    const timeout = Math.min(600_000, Number(args.timeout ?? ctx.defaultTimeoutMs ?? DEFAULT_CMD_TIMEOUT_MS));
    const result = await runShell(command, cwd, timeout, ctx.signal);
    const text = trimOutput(result);
    return result.code === 0 && !result.timedOut ? ok(text) : fail(text);
  },
};

// ── run_tests ──────────────────────────────────────────────────────────────

export const runTestsTool: AgentTool = {
  name: 'run_tests',
  description: 'Detect and run the project test suite (npm/vitest/jest/pytest/cargo/go).',
  schema: {
    type: 'object',
    properties: {
      filter: { type: 'string', description: 'optional test name/file filter' },
    },
  },
  danger: 'confirm',
  async execute(args, ctx) {
    const filter = args.filter ? String(args.filter) : '';
    const root = await resolveInSandbox(ctx.projectRoot, '.');

    // 1. package.json test script
    try {
      const pkgRaw = await fs.readFile(path.join(root, 'package.json'), 'utf8');
      const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string>; packageManager?: string };
      if (pkg.scripts?.test) {
        const pm = pkg.packageManager?.startsWith('pnpm') ? 'pnpm' : 'npm';
        const cmd = filter ? `${pm} test -- ${filter}` : `${pm} test`;
        const r = await runShell(cmd, root, DEFAULT_CMD_TIMEOUT_MS, ctx.signal);
        const text = trimOutput(r);
        return r.code === 0 ? ok(text) : fail(text);
      }
    } catch {
      /* no package.json */
    }

    // 2. python pytest
    if (
      await fs
        .access(path.join(root, 'pytest.ini'))
        .then(() => true)
        .catch(() => false)
    ) {
      const cmd = filter ? `python3 -m pytest ${filter}` : 'python3 -m pytest';
      const r = await runShell(cmd, root, DEFAULT_CMD_TIMEOUT_MS, ctx.signal);
      const text = trimOutput(r);
      return r.code === 0 ? ok(text) : fail(text);
    }

    // 3. cargo
    if (
      await fs
        .access(path.join(root, 'Cargo.toml'))
        .then(() => true)
        .catch(() => false)
    ) {
      const cmd = filter ? `cargo test ${filter}` : 'cargo test';
      const r = await runShell(cmd, root, DEFAULT_CMD_TIMEOUT_MS, ctx.signal);
      const text = trimOutput(r);
      return r.code === 0 ? ok(text) : fail(text);
    }

    return fail(
      'no test runner detected (looked for package.json test script, pytest.ini, Cargo.toml)',
    );
  },
};

export { isWhitelistedCommand };
