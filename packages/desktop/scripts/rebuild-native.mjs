#!/usr/bin/env node
/**
 * better-sqlite3 原生模块重编译（桌面打包链路专用）。
 *
 * 为什么不用 prebuild：better-sqlite3 v11.x 发布资产只有 electron-v135 及以下，
 * Electron 38 是 ABI 139（NODE_MODULE_VERSION 139），prebuild-install 必 404，
 * 只能按 Electron 头文件源码编译。
 *
 * 为什么不用 electron-builder 内置 @electron/rebuild：其捆绑 node-gyp 9.x，
 * gyp 里仍 `import distutils`，Python 3.12+ 已移除该模块，必然失败 ——
 * electron-builder.yml 已设 `npmRebuild: false`，由本脚本替代（`pnpm dist` 已串入）。
 *
 * ABI 只有一份：编译为 Electron ABI 后，`pnpm test` / CLI 会报 NODE_MODULE_VERSION
 * 不匹配。打包完成后执行 `node scripts/rebuild-native.mjs --restore`
 * （不带 --runtime=electron）恢复 Node ABI。
 *
 * 前置：mac 需 Xcode CLT（xcode-select --install）；Windows 需 VS Build Tools
 * （C++ 工作负载）+ Windows SDK。
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const restore = process.argv.includes('--restore');
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

// Electron 版本取自 devDependencies 实际安装版本，避免硬编码漂移
const desktopRequire = createRequire(resolve(desktopRoot, 'package.json'));
const electronVersion = desktopRequire('electron/package.json').version;

// better-sqlite3 是 @delta/core 的依赖，node-gyp 必须在该包目录内执行
const coreRoot = resolve(desktopRoot, '../core');
const sqliteDir = dirname(createRequire(resolve(coreRoot, 'package.json')).resolve('better-sqlite3/package.json'));

const args = ['-y', 'node-gyp@11', 'rebuild', '--release', `--arch=${process.arch}`];
if (!restore) {
  args.push(`--runtime=electron`, `--target=${electronVersion}`, '--dist-url=https://electronjs.org/headers');
}

console.log(
  `[rebuild-native] better-sqlite3 → ${restore ? `Node ABI（恢复）` : `Electron ${electronVersion} ABI`}\n` +
    `[rebuild-native] cwd: ${sqliteDir}`,
);

// Windows：.cmd 不可直接 exec，必须经 cmd.exe 解析（execFileSync 直调 npx.cmd 抛 EINVAL）
execFileSync(isWin ? 'npx.cmd' : 'npx', args, {
  cwd: sqliteDir,
  stdio: 'inherit',
  shell: isWin,
});

console.log('[rebuild-native] done.');
