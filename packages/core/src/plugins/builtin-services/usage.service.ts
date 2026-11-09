import type { HostService } from '../services.js';

/** usage 落库在 hub / SessionService；此槽位标记领域边界（P3）。 */
export function createUsageService(): HostService {
  return { id: 'usage', start() {}, stop() {} };
}
