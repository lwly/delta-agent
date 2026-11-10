import { describe, expect, it } from 'vitest';
import { BUILTIN_VIEW_IDS } from '../builtin-views/constants';

describe('useSessionSidebar / layout routes', () => {
  it('内置视图含 projects 与 tasks', () => {
    expect(BUILTIN_VIEW_IDS).toContain('projects');
    expect(BUILTIN_VIEW_IDS).toContain('tasks');
  });
});
