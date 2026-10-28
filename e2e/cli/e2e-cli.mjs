#!/usr/bin/env node
/**
 * F-45 CLI E2E：黄金路径 × 退出码协议（F-29：0 成功 / 1 配置 / 2 引擎致命 / 3 轮次 / 4 预算 / 5 SIGINT）
 *
 * 驱动方式：tsx 子进程跑真实 CLI 入口（packages/cli/src/index.ts），
 * Provider 走 DELTA_FAKE_PROVIDER 脚本化假 Provider（零网络零密钥），
 * HOME 指向临时目录实现配置/存储全隔离（沿用 cron 冒烟的隔离 HOME 方案）。
 *
 * 用法：node e2e/cli/e2e-cli.mjs
 */
import { spawnSync, spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_ENTRY = path.join(repoRoot, 'packages/cli/src/index.ts');
const TSX = path.join(repoRoot, 'node_modules/.bin/tsx');

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✔' : '✘'} ${name}${cond || !detail ? '' : ` —— ${detail}`}`);
  if (!cond) failed++;
};

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'yz-e2e-cli-'));
// 隔离项目：含 note.txt 供假 Provider 的 read_file 工具调用执行
const projectDir = path.join(tmp, 'proj');
await fsp.mkdir(projectDir);
await fsp.writeFile(path.join(projectDir, 'note.txt'), 'e2e note content');

const home = path.join(tmp, 'home');
await fsp.mkdir(home, { recursive: true });

/** 真实 CLI 子进程：隔离 HOME（Windows 走 USERPROFILE）+ DELTA_FAKE_PROVIDER 注入 */
function runCli(args, env = {}, opts = {}) {
  const r = spawnSync(TSX, [CLI_ENTRY, ...args], {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 120_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home, // Windows：os.homedir() 读 USERPROFILE 而非 HOME
      DELTA_FAKE_PROVIDER: 'scripted',
      DELTA_FAKE_CHUNK_DELAY_MS: '0',
      ...env,
    },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function parseJsonReport(stdout) {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
}

// ── AC-45-2 ①：成功路径 → 退出码 0 + 结构化报告 ─────────────────────────────
{
  const r = runCli(['run', '读取 note.txt 并总结', '--json']);
  const report = parseJsonReport(r.stdout);
  check('成功路径退出码 0', r.code === 0, `code=${r.code} stderr=${r.stderr.slice(0, 300)}`);
  check('报告含最终结果（假 Provider 脚本文本）', report?.result?.includes('E2E_FAKE_DONE') === true);
  check('报告记录工具调用（read_file）', report?.tool_calls?.some((t) => t.name === 'read_file') === true);
  check('报告含 usage（tokens > 0）', (report?.usage?.input_tokens ?? 0) > 0);
}

// ── ② 配置错误（隔离 HOME 且无任何 Provider 配置/Key）→ 退出码 1 ─────────────
{
  const r = runCli(['run', '任务', '--json'], { DELTA_FAKE_PROVIDER: '' });
  check('配置错误退出码 1', r.code === 1, `code=${r.code} stderr=${r.stderr.slice(0, 200)}`);
}

// ── ③ 引擎致命错误（error 模式假 Provider）→ 退出码 2 ────────────────────────
{
  const r = runCli(['run', '任务', '--json'], { DELTA_FAKE_PROVIDER: 'error' });
  check('引擎致命错误退出码 2', r.code === 2, `code=${r.code} stderr=${r.stderr.slice(0, 200)}`);
}

// ── ④ 预算耗尽（burn 模式 + --max-cost）→ 退出码 4 ───────────────────────────
{
  const r = runCli(['run', '任务', '--json', '--model', 'gpt-4o-mini', '--max-cost', '0.001'], {
    DELTA_FAKE_PROVIDER: 'burn',
  });
  check('预算耗尽退出码 4', r.code === 4, `code=${r.code} stderr=${r.stderr.slice(0, 200)}`);
}

// ── ⑤ SIGINT 中断 → 退出码 5（Windows 跳过：kill 无法投递可被 handler 捕获的 SIGINT）──
if (process.platform !== 'win32') {
  // detached 进程组：SIGINT 发给整组（tsx 包装进程不会自动转发信号给 node 子进程）
  const child = spawn(TSX, [CLI_ENTRY, 'run', '长任务', '--json'], {
    cwd: projectDir,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DELTA_FAKE_PROVIDER: 'scripted',
      DELTA_FAKE_LONG_REPLY: '1',
      DELTA_FAKE_CHUNK_DELAY_MS: '30',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const exitCode = new Promise((resolve) => child.on('exit', (c) => resolve(c)));
  // 等引擎进入流式输出窗口（tsx 启动 ~1s + 引擎首轮）再发 SIGINT
  await new Promise((r) => setTimeout(r, 3_000));
  try {
    process.kill(-child.pid, 'SIGINT');
  } catch {
    child.kill('SIGINT');
  }
  const code = await Promise.race([
    exitCode,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 30_000)),
  ]);
  child.kill('SIGKILL');
  check('SIGINT 中断退出码 5', code === 5, `code=${code}`);
}

// ── ⑥ 轮次耗尽（max-turns 1 + 首轮即工具调用）→ 退出码 3 ─────────────────────
{
  const r = runCli(['run', '任务', '--json', '--max-turns', '1']);
  check('轮次耗尽退出码 3', r.code === 3, `code=${r.code} stderr=${r.stderr.slice(0, 200)}`);
}

await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
console.log(failed === 0 ? '\n✔ CLI E2E 全部通过' : `\n✘ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
