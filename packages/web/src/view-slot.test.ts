import { describe, expect, it } from 'vitest';
import './builtin-views/register';
import { BUILTIN_VIEW_IDS } from './builtin-views/constants';
import { registerView, registeredViewNames, shellRoutes, viewsBySlot } from './view-slot';

describe('view slot', () => {
  it('内置视图 id 与登记一致', () => {
    expect([...BUILTIN_VIEW_IDS].sort()).toEqual([...registeredViewNames()].sort());
  });

  it('内置页面路径与改前一致', () => {
    expect(viewsBySlot('workbench-child').map((v) => v.path)).toEqual(['cron', 'usage']);
    const paths = shellRoutes().map((r) => r.path);
    expect(paths).toEqual(['/', '/projects', '/chat/:sessionId', '/settings', '/memory', '/logs', '/replay/:sessionId']);
    const workbench = shellRoutes()[0]!;
    expect(workbench.children?.map((c) => c.path)).toEqual(['cron', 'usage']);
  });

  it('重复视图名抛错', () => {
    expect(() => registerView({
      name: 'cron',
      path: 'cron2',
      slot: 'workbench-child',
      component: () => Promise.resolve({}),
    })).toThrow(/already registered: cron/);
  });
});
