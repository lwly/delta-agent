#!/usr/bin/env node
/**
 * 打包单文件可执行产物（Node SEA）
 *
 *   node scripts/build-sea.mjs            完整流程
 *   node scripts/build-sea.mjs --skip-build   复用已有 dist，跳过重新编译
 *
 * 产物：build/delta-<platform>-<arch>
 *
 * 为什么不是直接 bundle：ink / yoga-layout 含 top-level await，打不进 CJS；
 * better-sqlite3 是原生模块，esbuild 也带不走。所以走「运行时整体释放」：
 * 把 dist + 生产依赖压成 runtime.zip 作为 SEA asset 嵌入，启动时解压到
 * ~/.delta/runtime/<指纹>/ 再 import。源码零改动，模块相对路径保持原样。
 *
 * 平台限制：当前只支持 macOS arm64（需要 Mach-O 重签名；其他平台直接换
 * 目标 node 二进制与原生模块即可，postject 不需 --macho-segment-name）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const RUNTIME = path.join(BUILD, 'runtime');
const ZIP = path.join(BUILD, 'runtime.zip');
const BLOB = path.join(BUILD, 'sea-prep.blob');
const TOOLS = path.join(BUILD, '.tools');
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const skipBuild = process.argv.includes('--skip-build');

function log(step, message) {
  process.stdout.write(`\n[${step}] ${message}\n`);
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
}

function runQuiet(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts }).trim();
}

function human(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── 平台断言 ────────────────────────────────────────────────────────────
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error(`当前只支持 macOS arm64，当前是 ${process.platform}-${process.arch}`);
  process.exit(1);
}
const OUT = path.join(BUILD, `delta-${process.platform}-${process.arch}`);

// ── 1. 编译 ─────────────────────────────────────────────────────────────
if (!skipBuild) {
  log('1/7', '编译全部子包');
  run('pnpm', ['build']);
  run('node', ['scripts/copy-web-dist.mjs']);
} else {
  log('1/7', '跳过编译（--skip-build）');
}

// ── 2. 组装自包含运行时 ─────────────────────────────────────────────────
log('2/7', 'pnpm deploy 组装生产依赖（hoisted 扁平结构，便于 zip）');
fs.rmSync(RUNTIME, { recursive: true, force: true });
// 注意：deploy 的相对路径是相对包目录的，必须给绝对路径
run('pnpm', [
  '--filter', '@delta/cli',
  '--config.node-linker=hoisted',
  'deploy', '--prod', RUNTIME,
]);

// ── 3. 瘦身 ─────────────────────────────────────────────────────────────
log('3/7', '裁掉运行时用不到的文件');
fs.rmSync(path.join(RUNTIME, 'node_modules/.bin'), { recursive: true, force: true });
fs.rmSync(path.join(RUNTIME, 'node_modules/.pnpm'), { recursive: true, force: true });
// better-sqlite3 只需要编译好的 .node，C++ 源码与 prebuild 工具用不上
const sqlite = path.join(RUNTIME, 'node_modules/better-sqlite3');
for (const sub of ['src', 'deps', 'node_modules']) {
  fs.rmSync(path.join(sqlite, sub), { recursive: true, force: true });
}

// ── 4. 完整性校验 ───────────────────────────────────────────────────────
const required = [
  path.join(RUNTIME, 'dist/index.js'),
  path.join(RUNTIME, 'dist/web/index.html'),
  path.join(sqlite, 'build/Release/better_sqlite3.node'),
];
for (const file of required) {
  if (!fs.existsSync(file)) {
    console.error(`✗ 运行时缺少必要文件：${path.relative(ROOT, file)}`);
    process.exit(1);
  }
}
const strayLinks = runQuiet('find', [RUNTIME, '-type', 'l']).split('\n').filter(Boolean);
if (strayLinks.length > 0) {
  console.error(`✗ 运行时里还有 ${strayLinks.length} 个符号链接，zip 解压时会丢：\n${strayLinks.slice(0, 5).join('\n')}`);
  process.exit(1);
}

// ── 5. 压缩 ─────────────────────────────────────────────────────────────
log('4/7', '压缩运行时资源');
fs.rmSync(ZIP, { force: true });
run('zip', ['-r', '-q', '-X', ZIP, '.', '-x', '*.DS_Store'], { cwd: RUNTIME });

// ── 6. 生成并注入 SEA blob ──────────────────────────────────────────────
log('5/7', '生成 SEA blob');
run('node', ['--experimental-sea-config', 'scripts/sea-config.json']);

log('6/7', '注入 node 二进制');
fs.rmSync(OUT, { force: true });
fs.copyFileSync(process.execPath, OUT);
fs.chmodSync(OUT, 0o755);

const postjectRel = 'node_modules/.bin/postject';
let postject = path.join(TOOLS, postjectRel);
if (!fs.existsSync(postject)) {
  process.stdout.write('    安装 postject 到 build/.tools ...\n');
  run('npm', ['i', 'postject', '--no-audit', '--no-fund', '--prefix', TOOLS]);
}
run(postject, [OUT, 'NODE_SEA_BLOB', BLOB,
  '--sentinel-fuse', SENTINEL,
  '--macho-segment-name', 'NODE_SEA']);

// ── 7. 签名 ─────────────────────────────────────────────────────────────
log('7/7', 'ad-hoc 重签名（arm64 必须）');
try {
  runQuiet('codesign', ['--remove-signature', OUT]);
} catch {
  /* 原本就没签名时忽略 */
}
run('codesign', ['--sign', '-', OUT]);

// ── 汇总 ────────────────────────────────────────────────────────────────
const size = fs.statSync(OUT).size;
const zipSize = fs.statSync(ZIP).size;
process.stdout.write(`
✓ 打包完成
  产物   ${path.relative(ROOT, OUT)}  (${human(size)})
  资源包 ${path.relative(ROOT, ZIP)}  (${human(zipSize)})

  运行   ./${path.relative(ROOT, OUT)} --version
  说明   首次运行会把内置运行时解压到 ~/.delta/runtime/<指纹>/（约 1 万个小文件），
         之后按指纹复用；换版本会自动清理旧目录。
`);
