/**
 * 桌面宿主 cron 执行器：以 ELECTRON_RUN_AS_NODE 子进程跑 @delta/cli/dist/index.js run …。
 * 与 design-f40 §5「桌面 v2」一致；打包形态与仓库 dev 形态各有一套 cliEntry 候选路径。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import { createSpawnExecutor, type CronExecutor } from '@delta/core/cron';

export function resolveDesktopCliEntry(): string | undefined {
  const candidates = [
    process.env.DELTA_CLI_ENTRY,
    // electron-builder 打包：依赖随 asar 打入 node_modules
    path.join(app.getAppPath(), 'node_modules', '@delta/cli', 'dist', 'index.js'),
    // 仓库 dev：packages/desktop/dist/main.js → packages/cli/dist/index.js
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../cli/dist/index.js'),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => fs.existsSync(p));
}

/** 解析失败返回 undefined（createServeRuntime 保持 off，Web 提示与 v1 一致） */
export function createDesktopCronExecutor(): CronExecutor | undefined {
  const cliEntry = resolveDesktopCliEntry();
  if (!cliEntry) return undefined;
  return createSpawnExecutor({
    cliEntry,
    nodePath: process.execPath,
    env: { ELECTRON_RUN_AS_NODE: '1' },
  });
}
