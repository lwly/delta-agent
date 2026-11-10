import { describe, expect, it } from 'vitest';
import { workerTaskCanCancel } from './workerTaskLabels';

describe('workerTaskLabels', () => {
  it('workerTaskCanCancel：排队/预检/运行/待裁决可取消', () => {
    expect(workerTaskCanCancel('queued')).toBe(true);
    expect(workerTaskCanCancel('preflight')).toBe(true);
    expect(workerTaskCanCancel('running')).toBe(true);
    expect(workerTaskCanCancel('needs_decision')).toBe(true);
    expect(workerTaskCanCancel('done')).toBe(false);
    expect(workerTaskCanCancel('draft')).toBe(false);
  });
});
