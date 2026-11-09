#!/usr/bin/env node
/**
 * 根目录单测入口：校验 Node、确保 sqlite 原生绑定，并清掉外部环境注入的 NODE_OPTIONS
 * （WorkBuddy shim 会使 vitest SIGSEGV，见 design-f31 §9）。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
delete env.NODE_OPTIONS;

function runNode(script, args = []) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit', env });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

runNode(path.join(root, 'scripts/verify-node.mjs'));
runNode(path.join(root, 'scripts/ensure-sqlite-native.mjs'));

const r = spawnSync(
  'pnpm',
  ['-r', '--filter', '!@delta/e2e', 'run', 'test'],
  { cwd: root, stdio: 'inherit', env, shell: process.platform === 'win32' },
);
process.exit(r.status ?? 1);
