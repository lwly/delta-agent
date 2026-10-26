/**
 * F-22 定时任务 —— spawn 执行器（core 层通用实现）。
 *
 * 职责：把一条 cron 任务映射为一次独立的 headless 进程运行（spawn `run -p <prompt> --json`）。
 * 从 @delta/cli（原 cli/src/cron-executor.ts）下移，供多宿主复用：
 *  - CLI serve：cliEntry = 包内 dist/index.js，nodePath 缺省 process.execPath；
 *  - Electron 桌面：cliEntry / nodePath / env 由宿主显式注入（如 ELECTRON_RUN_AS_NODE=1），
 *    **core 不内置任何 process.execPath 假设**（Electron main 里 execPath 是 GUI 二进制）。
 *
 * 约束：
 *  - 子进程隔离：每次运行全新进程（MCP / hooks / 预算 / 权限全部重新装配），
 *    崩溃不波及宿主；复用 `delta run` 的全部非交互语义与退出码协议；
 *  - 超时保护：默认 30 分钟，超时 SIGTERM 并记 timeout；
 *  - 执行器约定：**不抛出**，一切失败（目录不存在、启动失败、JSON 解析失败、超时）
 *    收敛为结构化 CronExecutorResult。
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import type { CronExecutor, CronExecutorResult } from './runner.js';
import type { CronJob } from './store.js';

/** 单次运行超时（默认 30 分钟） */
export const DEFAULT_CRON_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 任务字段 → `delta run` 子进程参数（纯函数，executor 与单测共用）。
 * F-22b：任务级权限透传（沿用 F-23 resolvePermissionMode 语义）——
 *  - yolo → `--permission yolo --yolo` 双 flag（缺一会被降级告警）；
 *  - plan → `--permission plan`；
 *  - default / 缺省 → 不传任何 permission flag（沿用 CLI 默认）。
 */
export function buildCronSpawnArgs(job: Pick<CronJob, 'prompt' | 'maxCostUsd' | 'permission'>): string[] {
  const args = ['run', '-p', job.prompt, '--json'];
  if (job.maxCostUsd !== undefined) args.push('--max-cost', String(job.maxCostUsd));
  if (job.permission === 'yolo') args.push('--permission', 'yolo', '--yolo');
  else if (job.permission === 'plan') args.push('--permission', 'plan');
  return args;
}

/** 结果预览截断长度（避免 cron.json 膨胀） */
const RESULT_PREVIEW_MAX = 500;

export interface SpawnExecutorOptions {
  /**
   * CLI 入口绝对路径（dist/index.js）。**必传**：由宿主形态决定
   * （CLI 同级产物 / Electron 宿主解析出的 @delta/cli 产物）。
   */
  cliEntry: string;
  /** 单次运行超时毫秒数；缺省 30 分钟 */
  timeoutMs?: number;
  /** Node 可执行文件（缺省 process.execPath；Electron 宿主应显式传入） */
  nodePath?: string;
  /** 追加环境变量（如 Electron 宿主传 ELECTRON_RUN_AS_NODE: '1'） */
  env?: Record<string, string>;
}

/**
 * 构造 spawn 执行器。以 nodePath（缺省 process.execPath）运行 cliEntry 子进程。
 */
export function createSpawnExecutor(opts: SpawnExecutorOptions): CronExecutor {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CRON_TIMEOUT_MS;
  const cliEntry = opts.cliEntry;
  const nodePath = opts.nodePath ?? process.execPath;
  const extraEnv = opts.env ?? {};

  return async (job) => {
    if (!fs.existsSync(job.cwd)) {
      return { status: 'error', exitCode: null, error: `运行目录不存在：${job.cwd}` };
    }
    if (!fs.existsSync(cliEntry)) {
      return { status: 'error', exitCode: null, error: `CLI 入口不存在：${cliEntry}` };
    }

    const args = buildCronSpawnArgs(job);

    return await new Promise<CronExecutorResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const child = spawn(nodePath, [cliEntry, ...args], {
        cwd: job.cwd,
        env: { ...process.env, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ status: 'error', exitCode: null, error: `子进程启动失败：${e.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({
            status: 'timeout',
            exitCode: null,
            error: `任务超时（>${Math.round(timeoutMs / 60000)} 分钟），已 SIGTERM 终止`,
            resultPreview: stderr.slice(0, RESULT_PREVIEW_MAX),
          });
          return;
        }
        // 正常路径：stdout 是单个 JSON 报告（--json）
        try {
          const report = JSON.parse(stdout.trim()) as {
            status?: string;
            exit_code?: number;
            session_id?: string;
            result?: string;
            usage?: { cost_usd?: number };
            turns?: number;
            error?: string | null;
          };
          resolve({
            status: normalizeStatus(report.status, code),
            exitCode: code,
            ...(report.session_id ? { sessionId: report.session_id } : {}),
            ...(report.usage?.cost_usd !== undefined ? { costUsd: report.usage.cost_usd } : {}),
            ...(report.turns !== undefined ? { turns: report.turns } : {}),
            ...(report.error ? { error: report.error } : {}),
            ...(report.result ? { resultPreview: report.result.slice(0, RESULT_PREVIEW_MAX) } : {}),
          });
        } catch {
          resolve({
            status: 'error',
            exitCode: code,
            error: `子进程输出无法解析为 JSON 报告：${(stdout || stderr).trim().slice(0, RESULT_PREVIEW_MAX)}`,
          });
        }
      });
    });
  };
}

/** headless status → cron 运行状态（未知状态按退出码降级归类） */
function normalizeStatus(status: string | undefined, exitCode: number | null): CronExecutorResult['status'] {
  if (status === 'completed' || status === 'failed' || status === 'max_turns' || status === 'budget_exhausted' || status === 'aborted') {
    return status;
  }
  return exitCode === 0 ? 'completed' : 'failed';
}
