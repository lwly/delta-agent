import { describe, expect, it } from 'vitest';
import { isWorkbenchSubRoute, showWorkbenchSessionSidebar } from './workbenchLayout';

describe('workbenchLayout', () => {
  it('子路由不展示会话侧栏', () => {
    expect(isWorkbenchSubRoute('/cron')).toBe(true);
    expect(isWorkbenchSubRoute('/usage')).toBe(true);
    expect(showWorkbenchSessionSidebar('/cron')).toBe(false);
    expect(showWorkbenchSessionSidebar('/usage')).toBe(false);
  });

  it('工作台主对话页展示会话侧栏', () => {
    expect(isWorkbenchSubRoute('/')).toBe(false);
    expect(showWorkbenchSessionSidebar('/')).toBe(true);
    expect(showWorkbenchSessionSidebar('/tasks')).toBe(true);
  });
});
