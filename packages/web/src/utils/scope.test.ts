/**
 * F-59 项目作用域过滤纯函数测试（无 DOM、无后端）。
 * 覆盖：cwd 根本身 / 子目录 / 兄弟目录前缀陷阱 / 空值；日志 sessionId 命中 / 未命中 / 缺失。
 */
import { describe, expect, it } from 'vitest';
import { cwdInRoot, logEntryInProject, projectIdMatches } from './scope';

describe('cwdInRoot (F-59 定时任务项目作用域)', () => {
  const root = '/Users/me/work/project';

  it('项目根本身归属', () => {
    expect(cwdInRoot(root, root)).toBe(true);
  });

  it('项目子目录归属', () => {
    expect(cwdInRoot(`${root}/packages/web`, root)).toBe(true);
    expect(cwdInRoot(`${root}/`, root)).toBe(true);
  });

  it('前缀相同但路径不同的兄弟目录不归属（/project-x 不得命中 /project）', () => {
    expect(cwdInRoot('/Users/me/work/project-x', root)).toBe(false);
    expect(cwdInRoot('/Users/me/work/projectx/a', root)).toBe(false);
  });

  it('不相关目录与空值不归属', () => {
    expect(cwdInRoot('/other/path', root)).toBe(false);
    expect(cwdInRoot('', root)).toBe(false);
    expect(cwdInRoot(root, '')).toBe(false);
  });

  it('root 带尾斜杠时子目录仍归属', () => {
    expect(cwdInRoot(`${root}/web`, `${root}/`)).toBe(true);
  });
});

describe('logEntryInProject (F-59 运行日志项目作用域)', () => {
  const ids = new Set(['s1', 's2']);

  it('命中项目会话 id 归属', () => {
    expect(logEntryInProject('s1', ids)).toBe(true);
    expect(logEntryInProject('s2', ids)).toBe(true);
  });

  it('未命中 / 缺失 sessionId（serve/cron 全局条目）不归属', () => {
    expect(logEntryInProject('s9', ids)).toBe(false);
    expect(logEntryInProject(null, ids)).toBe(false);
    expect(logEntryInProject(undefined, ids)).toBe(false);
  });

  it('空会话集合不归属任何条目', () => {
    expect(logEntryInProject('s1', new Set())).toBe(false);
  });
});

describe('projectIdMatches (架构收口 T6：后端 project_id 过滤口径的纯函数镜像)', () => {
  it('projectId 相等命中', () => {
    expect(projectIdMatches('p-1', 'p-1')).toBe(true);
  });

  it('不相等 / 一方缺失不命中', () => {
    expect(projectIdMatches('p-2', 'p-1')).toBe(false);
    expect(projectIdMatches(undefined, 'p-1')).toBe(false);
    expect(projectIdMatches(null, 'p-1')).toBe(false);
    expect(projectIdMatches('', 'p-1')).toBe(false);
  });
});
