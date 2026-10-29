import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ok, fail, type AgentTool, type ToolContext } from '../types.js';
import { resolveInSandbox, isWhitelistedCommand } from '../sandbox.js';
import { runWithShell } from '../../engine/shell.js';
import type { SandboxMeta } from '../../sandbox/types.js';

export const DEFAULT_CMD_TIMEOUT_MS = 120_000;
/** E-3：stdout 截断收紧（20k → 10k 字符 ≈ 3.3k tokens）。大输出应重定向落文件后用 read_file 分段读。 */
export const MAX_CMD_OUTPUT = 10_000;

export interface ShellResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Cross-platform shell spawn via ShellAdapter (M5: PS→cmd 降级, darwin zsh). */
export function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ShellResult> {
  return runWithShell(command, cwd, timeoutMs, signal);
}

/** 输出截断与退出码尾巴（**历史口径，一字不改**：超时文本 / `[exit code: N]`）。 */
export function trimOutput(r: ShellResult): string {
  const parts = [
    r.stdout.length > MAX_CMD_OUTPUT ? r.stdout.slice(0, MAX_CMD_OUTPUT) + '\n...[stdout truncated]' : r.stdout,
    r.stderr ? (r.stderr.length > 4000 ? r.stderr.slice(0, 4000) + '\n...[stderr truncated]' : r.stderr) : '',
  ].filter(Boolean);
  const tail = r.timedOut ? '\n[command timed out]' : `\n[exit code: ${r.code}]`;
  return parts.join('\n') + tail;
}

// ── F-30 执行后端抽象 ───────────────────────────────────────────────────────

/** 后端执行的统一结果形态（local 与 sandbox 两种来源归一）。 */
export interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 策略层拒绝（沙箱不可用 / 工作区不安全），未执行任何命令 */
  denied?: boolean;
  /** denied 时的完整可诊断文案 */
  diagnostic?: string;
  /** 附加诊断（127/137/126、网络），追加在结果末尾 */
  hints: string[];
  /** 有值才写进 ToolResult.meta.sandbox */
  meta?: SandboxMeta;
}

/**
 * 唯一的执行后端入口：
 *  - `ctx.sandbox === undefined` → 与历史**逐字节一致**的路径（runShell → trimOutput → ok/fail）
 *  - 否则交给 `ctx.sandbox.run()`（LocalExecutor / DockerExecutor / SandboxRuntime 同接口）
 */
async function execViaBackend(
  command: string,
  cwd: string,
  timeoutMs: number,
  ctx: ToolContext,
): Promise<Outcome> {
  if (!ctx.sandbox) {
    const r = await runShell(command, cwd, timeoutMs, ctx.signal);
    return { code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut, hints: [] };
  }
  const r = await ctx.sandbox.run(command, { cwd, timeoutMs, signal: ctx.signal });
  return {
    code: r.code,
    stdout: r.stdout,
    stderr: r.stderr,
    timedOut: r.timedOut,
    ...(r.denied ? { denied: true } : {}),
    ...(r.diagnostic ? { diagnostic: r.diagnostic } : {}),
    hints: r.hints ?? [],
    ...(r.sandbox ? { meta: r.sandbox } : {}),
  };
}

/** denied 直接回传 diagnostic（不走 trimOutput）；其余沿用 trimOutput + hints。 */
function formatOutcome(o: Outcome): { text: string; ok: boolean } {
  if (o.denied) return { text: o.diagnostic ?? '[sandbox] 命令未执行', ok: false };
  const text =
    trimOutput({ code: o.code, stdout: o.stdout, stderr: o.stderr, timedOut: o.timedOut }) +
    (o.hints.length > 0 ? '\n' + o.hints.join('\n') : '');
  return { text, ok: o.code === 0 && !o.timedOut };
}

/** Z1/Z3：只有显式启用或 docker 模式才有 meta.sandbox。 */
function metaOf(o: Outcome): Record<string, unknown> | undefined {
  return o.meta ? { sandbox: o.meta } : undefined;
}

// ── F-54 后台执行 + task_output ────────────────────────────────────────────

/** task_output 返回给模型的输出尾上限（与 MAX_CMD_OUTPUT 同量级） */
const TASK_OUTPUT_CLIP = 10_000;

export const taskOutputTool: AgentTool = {
  name: 'task_output',
  description:
    '查询后台任务（run_command 的 run_in_background 启动）的状态与输出尾。' +
    '返回 status（running/done/failed/killed）、exit_code 与已收集输出；' +
    '任务尚在运行时输出为部分内容，可稍后再次查询。',
  schema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'run_command 后台启动时返回的任务 id（bg_*）' },
    },
    required: ['task_id'],
  },
  danger: 'safe',
  async execute(args, ctx) {
    const id = String(args.task_id ?? '').trim();
    if (!id) return fail('缺少 task_id 参数');
    if (!ctx.backgroundTasks) {
      return fail('task_output 不可用：当前运行环境未注入后台任务管理器', 'background_tasks_unavailable');
    }
    const r = ctx.backgroundTasks.getOutput(id);
    if (!r) return fail(`未知后台任务：${id}`, 'unknown_task');
    const output = r.output.length > TASK_OUTPUT_CLIP ? `...[truncated]\n${r.output.slice(-TASK_OUTPUT_CLIP)}` : r.output;
    const statusText =
      r.status === 'running'
        ? '运行中（输出为部分内容，可稍后再次查询）'
        : `已结束（${r.status}，exit code: ${r.exit_code ?? 'n/a'}）`;
    return ok(`[${id}] ${statusText}\n${output}`);
  },
};

// ── run_command ────────────────────────────────────────────────────────────

export const runCommandTool: AgentTool = {
  name: 'run_command',
  description:
    '在项目目录中执行 shell 命令。高危工具：默认需要用户确认。' +
    '长耗时命令（安装依赖、构建、dev server 等）可传 run_in_background=true 转后台执行：' +
    '立即返回任务 id，用 task_output 工具查询状态与输出。',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      cwd: { type: 'string', description: 'relative directory to run in (default project root)' },
      timeout: { type: 'number', description: 'timeout in ms (default 120000, max 600000)' },
      run_in_background: {
        type: 'boolean',
        description: 'true = 后台执行：立即返回任务 id（bg_*），不等待命令完成（忽略 timeout）',
      },
      description: {
        type: 'string',
        description: '后台任务的短描述（3-8 词，Web 任务条展示用；如「安装依赖」）',
      },
    },
    required: ['command'],
  },
  danger: 'confirm',
  async execute(args, ctx) {
    const command = String(args.command ?? '');
    if (!command.trim()) return fail('command is empty');
    // 路径沙箱是第一道闸（容器只挂 /workspace 是第二道），逃逸在此拒绝、不产生任何 docker 调用
    const cwd = await resolveInSandbox(ctx.projectRoot, String(args.cwd ?? '.'));
    // F-54 后台执行：确认通过后立即 spawn 返回 id；不走沙箱后端（v1 限制，设计 §5）
    if (args.run_in_background === true) {
      if (ctx.sandbox) {
        return fail('沙箱模式下暂不支持后台执行（run_in_background），请同步运行或关闭沙箱', 'background_unsupported_in_sandbox');
      }
      if (!ctx.backgroundTasks) {
        return fail('后台执行不可用：当前运行环境未注入后台任务管理器，请同步运行', 'background_tasks_unavailable');
      }
      const id = ctx.backgroundTasks.start(ctx.sessionId ?? '', command, cwd, String(args.description ?? ''));
      return ok(
        `后台任务已启动：${id}\n描述：${String(args.description ?? '') || command.slice(0, 60)}\n` +
          '命令在后台运行，本轮继续其它工作即可；稍后用 task_output 工具（task_id=该 id）查询状态与输出。',
        { background_task_id: id },
      );
    }
    const timeout = Math.min(600_000, Number(args.timeout ?? ctx.defaultTimeoutMs ?? DEFAULT_CMD_TIMEOUT_MS));
    const outcome = await execViaBackend(command, cwd, timeout, ctx);
    const f = formatOutcome(outcome);
    return f.ok ? ok(f.text, metaOf(outcome)) : fail(f.text);
  },
};

// ── run_tests ──────────────────────────────────────────────────────────────

/**
 * `run_tests` 的 `ok` 判定**保持现状 `code === 0`**（历史口径，勿顺手统一）：
 * 与 `run_command` 的 `code === 0 && !timedOut` 存在既存差异（F-30 设计 D11 / R9），
 * 本特性承诺「口径完全沿用」，统一会改掉既有行为，超出范围。
 */
function testsOk(o: Outcome): boolean {
  return o.code === 0;
}

export const runTestsTool: AgentTool = {
  name: 'run_tests',
  description: '探测并运行项目测试套件（npm/vitest/jest/pytest/cargo/go）。',
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
        const outcome = await execViaBackend(cmd, root, DEFAULT_CMD_TIMEOUT_MS, ctx);
        const f = formatOutcome(outcome);
        return testsOk(outcome) ? ok(f.text, metaOf(outcome)) : fail(f.text);
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
      const outcome = await execViaBackend(cmd, root, DEFAULT_CMD_TIMEOUT_MS, ctx);
      const f = formatOutcome(outcome);
      return testsOk(outcome) ? ok(f.text, metaOf(outcome)) : fail(f.text);
    }

    // 3. cargo
    if (
      await fs
        .access(path.join(root, 'Cargo.toml'))
        .then(() => true)
        .catch(() => false)
    ) {
      const cmd = filter ? `cargo test ${filter}` : 'cargo test';
      const outcome = await execViaBackend(cmd, root, DEFAULT_CMD_TIMEOUT_MS, ctx);
      const f = formatOutcome(outcome);
      return testsOk(outcome) ? ok(f.text, metaOf(outcome)) : fail(f.text);
    }

    return fail(
      'no test runner detected (looked for package.json test script, pytest.ini, Cargo.toml)',
    );
  },
};

export { isWhitelistedCommand };
