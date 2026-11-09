import type { HostService } from '../services.js';

/** evals 由 CLI `delta evals` 驱动；serve 侧仅占位登记（P3）。 */
export function createEvalsService(): HostService {
  return { id: 'evals', start() {}, stop() {} };
}
