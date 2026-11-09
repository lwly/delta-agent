/**
 * P3 内置领域服务：cron、router(dispatcher)、sandbox、notify、usage、onboarding、evals。
 * createServeRuntime 闭包注入后登记进 ServiceHost。
 */
import type { BuiltinServicesHandles, BuiltinServicesOptions } from './types.js';
import { createDispatcherService } from './dispatcher.service.js';
import { createCronService } from './cron.service.js';
import { createOnboardingService } from './onboarding.service.js';
import { createSandboxService } from './sandbox.service.js';
import { createNotifyService } from './notify.service.js';
import { createUsageService } from './usage.service.js';
import { createEvalsService } from './evals.service.js';

export {
  BUILTIN_SERVICE_IDS,
  type BuiltinServicesHandles,
  type BuiltinServicesOptions,
  type RegisterBuiltinServices,
} from './types.js';
export { resetCronSchedulerActiveForTests } from './cron.service.js';

export function registerBuiltinServices(
  host: import('../services.js').ServiceHost,
  opts: BuiltinServicesOptions,
): BuiltinServicesHandles {
  host.add(createSandboxService(opts.log));
  const onboarding = createOnboardingService(opts);
  if (onboarding) host.add(onboarding);
  host.add(createDispatcherService(opts.dispatcher));
  const { service: cron, cronStatus } = createCronService(opts);
  host.add(cron);
  host.add(createNotifyService(opts.notify, opts.log));
  host.add(createUsageService());
  host.add(createEvalsService());
  return { cronStatus };
}
