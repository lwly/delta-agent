import { startCronScheduler, type CronSchedulerHandle } from '../../cron/scheduler.js';
import type { BuiltinServicesOptions } from './types.js';
import type { HostService } from '../services.js';

/** 进程内单例：同一进程只允许一个 serve runtime 托管 cron */
let cronSchedulerActive = false;

export function createCronService(
  opts: Pick<
    BuiltinServicesOptions,
    'log' | 'runLog' | 'cronMode' | 'cronExecutor' | 'cronHomeDir' | 'projectRoots' | 'quota'
  >,
): { service: HostService; cronStatus: () => { running: boolean; mode: 'auto' | 'off' } } {
  let cronScheduler: CronSchedulerHandle | undefined;
  const mode = opts.cronMode;
  const service: HostService = {
    id: 'cron',
    start() {
      if (mode === 'auto') {
        if (!opts.cronExecutor) {
          opts.log('ℹ cron 调度器未启用：宿主未注入 cronExecutor（仅提供「立即运行」以外的面板能力）');
        } else if (cronSchedulerActive) {
          opts.log('ℹ cron 调度器已由本进程另一个 serve runtime 托管，跳过重复启动');
        } else {
          cronScheduler = startCronScheduler({
            executor: opts.cronExecutor,
            tickMs: 30_000,
            homeDir: opts.cronHomeDir,
            logger: (line, ctx) => {
              opts.runLog.append('info', 'cron', line, undefined, ctx?.projectId);
              opts.log(line);
            },
            projectRoots: opts.projectRoots,
            quota: opts.quota,
          });
          cronSchedulerActive = true;
          opts.log(
            '✔ cron 调度器已随 serve 托管（tick 30s，配置 ~/.delta/cron.json；可用 --cron-scheduler off 关闭）',
          );
        }
      } else {
        opts.log(
          'ℹ cron 调度器已关闭（--cron-scheduler off 或 DELTA_CRON_DISABLE_AUTOTICK=1）；定时任务需由 `delta cron daemon` 触发',
        );
      }
    },
    stop() {
      if (cronScheduler?.stop()) cronSchedulerActive = false;
      cronScheduler = undefined;
    },
  };
  return {
    service,
    cronStatus: () => ({ running: cronScheduler?.isRunning() ?? false, mode }),
  };
}

/** 测试用：复位进程内 cron 单例守卫 */
export function resetCronSchedulerActiveForTests(): void {
  cronSchedulerActive = false;
}
