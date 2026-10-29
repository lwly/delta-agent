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

// ── ⑦ F-51 AC-51-4：全新环境 doctor 冒烟（隔离 HOME；--offline 零网络） ──────
// 覆盖「全新 Windows VM：安装 → doctor → headless run」链路中的 doctor 环节，
// 与 CI windows-installer job 的 SEA 二进制 doctor 冒烟互补。
{
  const fresh = runCli(['doctor', '--offline']);
  check('doctor（全新环境）退出码 0', fresh.code === 0, `code=${fresh.code} stderr=${fresh.stderr.slice(0, 200)}`);
  check('doctor 报告含版本/Node/配置目录项', /版本/.test(fresh.stdout) && /Node/.test(fresh.stdout) && /配置目录/.test(fresh.stdout));
  check('doctor 全新环境结论为全部通过', /全部通过/.test(fresh.stdout));
  // 隔离 HOME 未配置 Provider（--offline 跳过连通项）：配置项应为提示，且整体无失败标记
  check('doctor 无 Provider 时为提示而非失败', /Provider 配置：未配置/.test(fresh.stdout) && !/✘/.test(fresh.stdout));
}

// ── ⑧ F-52 AC-52-5：市场闭环（本地 registry 服务：list → search → install → 加载 → remove）──
// registry 用子进程托管（node -e）：与 CLI 子进程同为兄弟进程，兼容沙箱/CI 网络环境
{
  const serverScript = `const http=require('node:http');const data=${JSON.stringify(JSON.stringify({
    skills: [
      { name: 'deploy-check', description: 'E2E 部署检查技能', body: '# 部署检查步骤', triggers: ['deploy'],
        scripts: [{ name: 'check.sh', content: '#!/bin/sh\necho ok' }] },
      { name: 'plain-e2e', description: 'E2E 无脚本技能', body: '# 直接安装' },
    ],
  }))};const s=http.createServer((q,r)=>{r.writeHead(200,{'content-type':'application/json'});r.end(data)});s.listen(0,'127.0.0.1',()=>console.log('PORT',s.address().port));setTimeout(()=>process.exit(0),120000)`;
  const regProc = spawn(process.execPath, ['-e', serverScript], { stdio: ['ignore', 'pipe', 'pipe'] });
  const regUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('registry 服务启动超时')), 10_000);
    regProc.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/PORT (\d+)/);
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}/registry.json`); }
    });
  });

  // source add + list（订阅源条目可见，内置条目同时在列）
  const add = runCli(['market', 'source', 'add', 'e2e', regUrl, '--kind', 'skills']);
  check('market source add 成功', add.code === 0, `code=${add.code} stderr=${add.stderr.slice(0, 200)}`);
  const list = runCli(['market', 'list']);
  check('market list 含内置 code-review 与订阅源条目', list.code === 0 && /code-review/.test(list.stdout) && /plain-e2e/.test(list.stdout));
  const search = runCli(['market', 'search', 'E2E']);
  check('market search 命中订阅源条目', /plain-e2e/.test(search.stdout) && /deploy-check/.test(search.stdout));

  // install：无脚本直接装 → skill list 可见（三层加载器发现，AC-52-2「三层覆盖自动生效」）
  const inst = runCli(['market', 'install', 'plain-e2e']);
  check('market install（无脚本）成功', inst.code === 0, `code=${inst.code} stderr=${inst.stderr.slice(0, 200)}`);
  const loaded = runCli(['skill', 'list']);
  check('安装后 skill list 可见（加载链路）', /plain-e2e/.test(loaded.stdout));

  // install：含 scripts 未确认 → 拒绝（退出码 1，逐脚本展示）；--yes 放行
  const blocked = runCli(['market', 'install', 'deploy-check']);
  check('含脚本安装未确认被拒', blocked.code === 1 && /check\.sh/.test(blocked.stderr) && /--yes/.test(blocked.stderr));
  const allowed = runCli(['market', 'install', 'deploy-check', '--yes']);
  check('含脚本安装 --yes 放行并落盘脚本', allowed.code === 0 && /check\.sh/.test(allowed.stdout));
  const scriptOnDisk = fs.existsSync(path.join(home, '.delta', 'skills', 'deploy-check', 'scripts', 'check.sh'));
  check('脚本随包写入 scripts/', scriptOnDisk);

  // plan 权限模式拒绝安装（AC-52-3）
  const planRefused = runCli(['market', 'install', 'plain-e2e', '--project', '--permission', 'plan']);
  check('plan 权限模式拒绝安装', planRefused.code === 1 && /plan 权限模式/.test(planRefused.stderr));

  // remove：卸载后 skill list 不再显示
  const rm = runCli(['market', 'remove', 'plain-e2e']);
  check('market remove 成功', rm.code === 0, `code=${rm.code} stderr=${rm.stderr.slice(0, 200)}`);
  const afterRm = runCli(['skill', 'list']);
  check('卸载后 skill list 不再显示', !/plain-e2e/.test(afterRm.stdout));

  regProc.kill('SIGKILL');
}

await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
console.log(failed === 0 ? '\n✔ CLI E2E 全部通过' : `\n✘ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
