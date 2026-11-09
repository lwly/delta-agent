import type { Dispatcher } from '../../router/dispatcher.js';
import type { HostService } from '../services.js';

export function createDispatcherService(dispatcher: Dispatcher): HostService {
  let dispatchTimer: ReturnType<typeof setInterval> | undefined;
  return {
    id: 'dispatcher',
    start() {
      dispatcher.bootstrap();
      dispatchTimer = setInterval(() => {
        void dispatcher.tick().catch(() => undefined);
      }, 60_000);
      dispatchTimer.unref?.();
    },
    stop() {
      if (dispatchTimer) clearInterval(dispatchTimer);
      dispatchTimer = undefined;
    },
  };
}
