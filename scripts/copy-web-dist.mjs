#!/usr/bin/env node
/**
 * npm 发布形态：把 packages/web/dist（Vue 构建产物）拷入 packages/cli/dist/web，
 * 供 `delta serve` 包内嵌托管（cli files 字段只含 dist/）。
 * 由 cli 的 prepack 钩子调用；产物缺失时静默跳过（仅 API 形态仍可用）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const src = path.join(repoRoot, 'packages', 'web', 'dist');
const dest = path.join(repoRoot, 'packages', 'cli', 'dist', 'web');

if (!fs.existsSync(path.join(src, 'index.html'))) {
  console.warn('[copy-web-dist] packages/web/dist 不存在，跳过（serve 将仅提供 /api）');
  process.exit(0);
}
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`[copy-web-dist] ${src} → ${dest}`);
