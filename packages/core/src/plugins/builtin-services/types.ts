import type { Notifier } from '../../notify/types.js';
import type { RunLog } from '../../logging/logger.js';
import type { CronExecutor } from '../../cron/runner.js';
import type { CronProjectRootRef } from '../../cron/store.js';
import type { QuotaStore } from '../../quota/store.js';
import type { Dispatcher } from '../../router/dispatcher.js';
import type { ServiceHost } from '../services.js';

export interface BuiltinServicesOptions {
  log: (line: string) => void;
  logError: (line: string) => void;
  runLog: RunLog;
  dispatcher: Dispatcher;
  cronMode: 'auto' | 'off';
  cronExecutor?: CronExecutor;
  cronHomeDir?: string;
  projectRoots: CronProjectRootRef[];
  quota: QuotaStore;
  notify: Notifier;
  /** 新项目注册后于服务 start 触发一次 onboarding 扫描 */
  onboarding?: { projectRoot: string };
}

export interface BuiltinServicesHandles {
  cronStatus: () => { running: boolean; mode: 'auto' | 'off' };
}

export type RegisterBuiltinServices = (
  host: ServiceHost,
  opts: BuiltinServicesOptions,
) => BuiltinServicesHandles;

/** P3 内置领域服务 id（登记顺序）。 */
export const BUILTIN_SERVICE_IDS = [
  'sandbox',
  'onboarding',
  'dispatcher',
  'cron',
  'notify',
  'usage',
  'evals',
] as const;
