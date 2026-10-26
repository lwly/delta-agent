/**
 * F-22 定时任务 —— CLI 形态的 spawn 执行器（薄壳）。
 *
 * 实现已下移 @delta/core（core/src/cron/spawn-executor.ts）供多宿主复用；
 * 本文件只负责 CLI 形态的缺省参数：cliEntry = 本模块编译产物同级 index.js（bin 入口）。
 * Electron 等其他宿主应直接使用 core 的 createSpawnExecutor 并显式传 cliEntry / nodePath / env。
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCronSpawnArgs,
  createSpawnExecutor as createCoreSpawnExecutor,
  DEFAULT_CRON_TIMEOUT_MS,
  type CronExecutor,
} from '@delta/core';

export { buildCronSpawnArgs, DEFAULT_CRON_TIMEOUT_MS };

export interface SpawnExecutorOptions {
  /** CLI 入口绝对路径（缺省 = 本模块编译产物同级 index.js） */
  cliEntry?: string;
  /** 单次运行超时毫秒数；缺省 30 分钟 */
  timeoutMs?: number;
}

/**
 * 构造 spawn 执行器。CLI 入口 = 本文件编译产物同级 index.js
 * （src/cron-executor.ts → dist/cron-executor.js，与 index.js 同目录）。
 */
export function createSpawnExecutor(opts: SpawnExecutorOptions = {}): CronExecutor {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return createCoreSpawnExecutor({
    cliEntry: opts.cliEntry ?? path.join(here, 'index.js'),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
}
