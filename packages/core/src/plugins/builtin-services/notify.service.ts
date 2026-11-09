import { noopNotifier, type Notifier } from '../../notify/types.js';
import type { HostService } from '../services.js';

export function createNotifyService(notify: Notifier, log: (line: string) => void): HostService {
  return {
    id: 'notify',
    start() {
      if (notify === noopNotifier) log('ℹ 通知：noop（未注入桌面通知器）');
      else log('✔ 通知：桌面通知器已注入');
    },
    stop() {},
  };
}
