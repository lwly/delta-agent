import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SERVICE_IDS,
  registerBuiltinServices,
  resetCronSchedulerActiveForTests,
} from '../src/plugins/builtin-services/index.js';
import { createServiceHost } from '../src/plugins/services.js';
import type { Dispatcher } from '../src/router/dispatcher.js';
import { noopNotifier } from '../src/notify/types.js';
import { RunLog } from '../src/logging/logger.js';
import { QuotaStore } from '../src/quota/store.js';

function stubDispatcher(): Dispatcher {
  return {
    bootstrap: () => {},
    tick: async () => {},
  } as unknown as Dispatcher;
}

describe('P3 builtin domain services', () => {
  it('登记全部内置服务 id', () => {
    resetCronSchedulerActiveForTests();
    const log: string[] = [];
    const host = createServiceHost();
    const { cronStatus } = registerBuiltinServices(host, {
      log: (l) => log.push(l),
      logError: (l) => log.push(`err:${l}`),
      runLog: new RunLog(),
      dispatcher: stubDispatcher(),
      cronMode: 'off',
      projectRoots: [],
      quota: new QuotaStore(),
      notify: noopNotifier,
    });
    host.start();
    expect(cronStatus()).toEqual({ running: false, mode: 'off' });
    host.stop();
    // onboarding 未注入时 6 项；全量 id 表含 onboarding
    expect(BUILTIN_SERVICE_IDS).toEqual([
      'sandbox',
      'onboarding',
      'dispatcher',
      'cron',
      'notify',
      'usage',
      'evals',
    ]);
  });

  it('onboarding 可选：有 projectRoot 时多登记一项', () => {
    resetCronSchedulerActiveForTests();
    const host = createServiceHost();
    registerBuiltinServices(host, {
      log: () => {},
      logError: () => {},
      runLog: new RunLog(),
      dispatcher: stubDispatcher(),
      cronMode: 'off',
      projectRoots: [],
      quota: new QuotaStore(),
      notify: noopNotifier,
      onboarding: { projectRoot: process.cwd() },
    });
    host.start();
    host.stop();
  });
});
