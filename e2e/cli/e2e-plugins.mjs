#!/usr/bin/env node
/**
 * P6 插件真机 E2E：CLI registerCommand + delta serve 路由/GET /api/plugins 视图元数据。
 */
import { spawn, spawnSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { installE2ePluginFixture } from '../../scripts/e2e-plugin-fixture.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function sqliteServeReady() {
  if (Number(process.versions.node.split('.')[0]) < 20) return false;
  try {
    const req = createRequire(path.join(repoRoot, 'packages/core/package.json'));
    const Database = req('better-sqlite3');
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

const CLI_ENTRY = path.join(repoRoot, 'packages/cli/src/index.ts');
const TSX = path.join(repoRoot, 'node_modules/.bin/tsx');

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✔' : '✘'} ${name}${cond || !detail ? '' : ` —— ${detail}`}`);
  if (!cond) failed++;
};

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'yz-e2e-plugins-'));
const home = path.join(tmp, 'home');
await fsp.mkdir(home, { recursive: true });
const deltaHome = path.join(home, '.delta');
await installE2ePluginFixture(deltaHome);

const projectDir = path.join(tmp, 'proj');
await fsp.mkdir(projectDir);

function runCli(args, env = {}) {
  const r = spawnSync(TSX, [CLI_ENTRY, ...args], {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DELTA_FAKE_PROVIDER: 'scripted',
      DELTA_FAKE_CHUNK_DELAY_MS: '0',
      ...env,
    },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

{
  const r = runCli(['plugin-e2e-hello']);
  check('CLI 插件子命令退出码 0', r.code === 0, `stderr=${r.stderr.slice(0, 200)}`);
  check('CLI 插件子命令输出', r.stdout.includes('PLUGIN_E2E_HELLO'));
}

if (!sqliteServeReady()) {
  console.log('⊘ 跳过 serve 插件 E2E（需 Node >= 20 且 better-sqlite3 可用）');
} else {
const servePort = 17902;
const dbPath = path.join(home, '.delta', 'agent.db');
await fsp.mkdir(path.dirname(dbPath), { recursive: true });

const serve = spawn(TSX, [CLI_ENTRY, 'serve', '--port', String(servePort), '--db', dbPath], {
  cwd: projectDir,
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    DELTA_CRON_DISABLE_AUTOTICK: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serveOut = '';
serve.stdout?.on('data', (d) => { serveOut += d.toString(); });
const serveReady = new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('serve 启动超时')), 25_000);
  const tick = () => {
    if (/127\.0\.0\.1:\d+/.test(serveOut) || serveOut.includes('Web 控制台已启动')) {
      clearTimeout(t);
      resolve();
    }
  };
  serve.stdout?.on('data', tick);
  const poll = async () => {
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${servePort}/api/plugins`);
        if (res.ok) {
          clearTimeout(t);
          resolve();
          return;
        }
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  void poll();
});

try {
  await serveReady;
  const routeRes = await fetch(`http://127.0.0.1:${servePort}/api/_e2e_plugin`);
  check('serve 插件路由 200', routeRes.status === 200, `status=${routeRes.status}`);
  check('serve 插件路由 body', (await routeRes.json()).via === 'plugin');

  const metaRes = await fetch(`http://127.0.0.1:${servePort}/api/plugins`);
  const meta = await metaRes.json();
  check('GET /api/plugins 200', metaRes.status === 200);
  const loaded = meta.plugins?.some((p) => p.id === 'e2e-serve' && p.status === 'loaded');
  check('serve 插件快照含 e2e-serve', loaded === true);
  const view = meta.views?.find((v) => v.name === 'plugin-e2e-view');
  check('视图元数据含 plugin-e2e-view', view?.path === '/plugin-e2e-view' && view?.module === '/e2e-plugin-view.mjs');
} catch (e) {
  check('serve 插件链路', false, e instanceof Error ? e.message : String(e));
} finally {
  serve.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  serve.kill('SIGKILL');
}
}

await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
console.log(failed === 0 ? '\n✔ 插件 E2E 全部通过' : `\n✘ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
