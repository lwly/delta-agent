import { describe, expect, it } from 'vitest';
import { BUILTIN_HTTP_ROUTE_GROUPS } from '../src/server/builtin-routes/types.js';

describe('P4 builtin HTTP routes', () => {
  it('声明式路由组登记完整', () => {
    expect(BUILTIN_HTTP_ROUTE_GROUPS).toEqual([
      'cron',
      'worker-tasks',
      'sessions',
      'projects',
      'skills',
      'market',
      'mcp',
      'logs',
      'providers',
      'models',
      'sessions-stream',
      'browse',
      'experts',
      'terminal',
      'external-agents',
      'memory',
      'usage',
      'settings',
      'trash',
      'search',
      'system',
    ]);
  });
});
