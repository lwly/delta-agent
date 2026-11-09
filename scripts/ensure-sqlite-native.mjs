#!/usr/bin/env node
/**
 * vitest / 本地开发：当前 Node ABI 下 better-sqlite3 不可用时自动 rebuild。
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error(`✘ 需要 Node >= 20（当前 ${process.version}）。见 .nvmrc`);
  process.exit(1);
}
const corePkg = path.join(root, 'packages/core/package.json');
const req = createRequire(corePkg);

function canLoad() {
  try {
    const Database = req('better-sqlite3');
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

if (!canLoad()) {
  process.stderr.write(`[ensure-sqlite-native] 为 Node ${process.version} 重建 better-sqlite3 …\n`);
  const sqliteDir = path.dirname(req.resolve('better-sqlite3/package.json'));
  execFileSync('npm', ['run', 'build-release', '--prefix', sqliteDir], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (!canLoad()) {
    console.error(`✘ better-sqlite3 仍无法加载（当前 ${process.version}）。请：nvm install 20 && nvm use（见 .nvmrc）`);
    process.exit(1);
  }
} else {
  process.stderr.write(`[ensure-sqlite-native] ok（Node ${process.version}）\n`);
}
