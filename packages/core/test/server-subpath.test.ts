import { describe, expect, it } from 'vitest';
import * as server from '../src/server/index.js';

describe('@delta/core/server 子路径', () => {
  it('导出 Hub / HTTP / 路由与只读处理器', () => {
    expect(typeof server.SessionHub).toBe('function');
    expect(typeof server.createWebServer).toBe('function');
    expect(typeof server.createServeRuntime).toBe('function');
    expect(typeof server.appendRoutes).toBe('function');
    expect(typeof server.handleBrowseRoute).toBe('function');
    expect(typeof server.handleExpertsRoute).toBe('function');
  });
});
