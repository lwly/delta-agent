#!/usr/bin/env node
/**
 * 安装 git 钩子（scripts/hooks/* → .git/hooks/*）。
 *
 * 由 package.json 的 prepare 脚本触发，也可手动执行：node scripts/install-hooks.mjs
 * 非 git 环境（如 tarball 安装、CI 检出子目录）静默跳过，不影响安装流程。
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let gitDir;
try {
  gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repoRoot, encoding: 'utf8' }).trim();
} catch {
  process.exit(0); // 不是 git 仓库，跳过
}

const targetDir = path.resolve(repoRoot, gitDir, 'hooks');
const sourceDir = path.join(repoRoot, 'scripts', 'hooks');

if (!existsSync(sourceDir)) process.exit(0);
mkdirSync(targetDir, { recursive: true });

const hooks = ['pre-push'];
for (const name of hooks) {
  const src = path.join(sourceDir, name);
  if (!existsSync(src)) continue;
  const dest = path.join(targetDir, name);
  copyFileSync(src, dest);
  chmodSync(dest, 0o755);
  console.log(`[hooks] installed ${name} → ${path.relative(repoRoot, dest)}`);
}
