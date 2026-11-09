import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CONTRIBUTION_PACKAGES,
  BUILTIN_HTTP_ROUTE_GROUPS,
  BUILTIN_VIEW_IDS,
  createServeRuntime,
  loadPlugins,
} from '../src/index.js';

describe('@delta/host P7', () => {
  it('导出 serve 装配与内置贡献清单', () => {
    expect(typeof createServeRuntime).toBe('function');
    expect(typeof loadPlugins).toBe('function');
    expect(BUILTIN_CONTRIBUTION_PACKAGES).toHaveLength(5);
    expect(BUILTIN_HTTP_ROUTE_GROUPS).toContain('system');
    expect(BUILTIN_VIEW_IDS).toContain('cron');
  });
});
