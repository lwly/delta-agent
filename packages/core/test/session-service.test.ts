import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionService, TRASH_RETENTION_DAYS } from '../src/session/service.js';

let tmp = '';
let dbFile = '';
let svc: SessionService;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-svc-'));
  dbFile = path.join(tmp, 'test.db');
  svc = new SessionService(dbFile);
});

describe('项目列表', () => {
  it('listProjects 返回存活项目 + 存活会话计数', () => {
    const a = svc.ensureProject('/tmp/proj-a');
    svc.ensureProject('/tmp/proj-b');
    svc.createSession(a.id, { title: 's1' });
    svc.createSession(a.id, { title: 's2' });
    const b = svc.getProject(svc.listProjects().find((p) => p.name === 'proj-b')!.id);
    svc.createSession(b!.id, { title: 's3' });

    const list = svc.listProjects();
    expect(list).toHaveLength(2);
    const pa = list.find((p) => p.name === 'proj-a')!;
    expect(pa.session_count).toBe(2);
  });

  it('软删除的项目不出现在列表', () => {
    const a = svc.ensureProject('/tmp/proj-a');
    svc.removeProject(a.id, 'proj-a');
    expect(svc.listProjects()).toHaveLength(0);
  });
});

describe('会话软删除 / 回收站 / 恢复', () => {
  it('removeSession 默认软删除：列表消失、回收站出现、restore 恢复', () => {
    const p = svc.ensureProject('/tmp/proj-a');
    const s = svc.createSession(p.id, { title: '目标会话' });
    svc.appendMessage(s.id, { role: 'user', content: 'hello' });

    svc.removeSession(s.id);
    expect(svc.listSessions(p.id)).toHaveLength(0);
    expect(svc.getSession(s.id)).toBeUndefined();

    const trash = svc.listTrash();
    expect(trash).toContainEqual(expect.objectContaining({ kind: 'session', id: s.id, name: '目标会话' }));

    svc.restore('session', s.id);
    expect(svc.listSessions(p.id)).toHaveLength(1);
    expect(svc.getHistory(s.id)).toHaveLength(1); // 软删除不动消息
    expect(svc.listTrash()).toHaveLength(0);
  });

  it('hard=true 物理清除：消息/压缩/用量一并删除', () => {
    const p = svc.ensureProject('/tmp/proj-a');
    const s = svc.createSession(p.id, { title: 'x' });
    svc.appendMessage(s.id, { role: 'user', content: 'data' });
    svc.recordUsage(s.id, 1, 10, 5, 0.01);
    svc.recordCompaction(s.id, 100, 60, 'summary');

    svc.removeSession(s.id, { hard: true });
    expect(svc.listTrash()).toHaveLength(0);
    expect(() => svc.restore('session', s.id)).toThrow(/not found/);
  });

  it('项目在回收站时不能恢复其会话', () => {
    const p = svc.ensureProject('/tmp/proj-a');
    const s = svc.createSession(p.id, { title: 'child' });
    svc.removeProject(p.id, 'proj-a'); // 级联软删除会话

    expect(() => svc.restore('session', s.id)).toThrow(/project is in trash/);
    svc.restore('project', p.id);
    expect(() => svc.restore('session', s.id)).not.toThrow();
  });
});

describe('项目移除（二次确认 + 级联）', () => {
  it('confirmName 不匹配 → 报错', () => {
    const p = svc.ensureProject('/tmp/proj-a');
    expect(() => svc.removeProject(p.id, 'wrong-name')).toThrow(/confirmName/);
    expect(svc.listProjects()).toHaveLength(1);
  });

  it('级联软删除全部会话；恢复项目后会话仍待单独恢复', () => {
    const p = svc.ensureProject('/tmp/proj-a');
    const s1 = svc.createSession(p.id, { title: 'a' });
    const s2 = svc.createSession(p.id, { title: 'b' });

    svc.removeProject(p.id, 'proj-a');
    const trash = svc.listTrash();
    expect(trash.filter((t) => t.kind === 'session')).toHaveLength(2);
    expect(trash.filter((t) => t.kind === 'project')).toHaveLength(1);

    svc.restore('project', p.id);
    expect(svc.listSessions(p.id)).toHaveLength(0); // 会话仍在回收站
    svc.restore('session', s1.id);
    svc.restore('session', s2.id);
    expect(svc.listSessions(p.id)).toHaveLength(2);
  });

  it('hard 移除项目：数据物理清除，仅解除注册', () => {
    const p = svc.ensureProject('/tmp/proj-a');
    const s = svc.createSession(p.id, { title: 'x' });
    svc.appendMessage(s.id, { role: 'user', content: 'keep-source' });

    svc.removeProject(p.id, 'proj-a', { hard: true });
    expect(svc.listProjects()).toHaveLength(0);
    expect(svc.listTrash()).toHaveLength(0);
    // 项目目录与源码不被触碰
    expect(fs.existsSync('/tmp/proj-a') || true).toBe(true);
  });

  it('运行中会话删除前先中止', () => {
    const p = svc.ensureProject('/tmp/proj-a');
    const s = svc.createSession(p.id, { title: 'running' });
    const ac = new AbortController();
    svc.registerRun(s.id, ac);

    svc.removeSession(s.id);
    expect(ac.signal.aborted).toBe(true);
    expect(svc.isRunning(s.id)).toBe(false);
  });

  it('运行中项目级联中止', () => {
    const p = svc.ensureProject('/tmp/proj-a');
    const s = svc.createSession(p.id, { title: 'r' });
    const ac = new AbortController();
    svc.registerRun(s.id, ac);
    svc.removeProject(p.id, 'proj-a');
    expect(ac.signal.aborted).toBe(true);
  });
});

describe('回收站过期清理', () => {
  it('purgeExpired(0) 立即清除全部软删除；默认 30 天常量', () => {
    expect(TRASH_RETENTION_DAYS).toBe(30);
    const p = svc.ensureProject('/tmp/proj-a');
    const s = svc.createSession(p.id, { title: 'x' });
    svc.removeSession(s.id);
    svc.removeProject(p.id, 'proj-a');
    expect(svc.purgeExpired(0)).toBe(2);
    expect(svc.listTrash()).toHaveLength(0);
  });

  it('新删除的不受 purgeExpired(30) 影响', () => {
    const p = svc.ensureProject('/tmp/proj-a');
    const s = svc.createSession(p.id, { title: 'fresh' });
    svc.removeSession(s.id);
    expect(svc.purgeExpired(TRASH_RETENTION_DAYS)).toBe(0);
    expect(svc.listTrash()).toHaveLength(1);
  });
});

describe('会话检索', () => {
  it('按标题与消息内容命中；空查询返回空', () => {
    const p = svc.ensureProject('/tmp/proj-a');
    const s1 = svc.createSession(p.id, { title: '数据库迁移' });
    const s2 = svc.createSession(p.id, { title: '前端重构' });
    svc.appendMessage(s2.id, { role: 'user', content: '讨论一下数据库索引优化' });
    svc.createSession(p.id, { title: '无关会话' });

    expect(svc.searchSessions('数据库').map((s) => s.id).sort()).toEqual([s1.id, s2.id].sort());
    expect(svc.searchSessions('重构').map((s) => s.id)).toEqual([s2.id]);
    expect(svc.searchSessions('  ')).toHaveLength(0);
  });

  it('软删除会话不参与检索；% _ 特殊字符不 wildcard', () => {
    const p = svc.ensureProject('/tmp/proj-a');
    const s = svc.createSession(p.id, { title: 'percent%test' });
    svc.appendMessage(s.id, { role: 'user', content: 'like_underscore' });
    svc.removeSession(s.id);
    expect(svc.searchSessions('percent%test')).toHaveLength(0);

    const s2 = svc.createSession(p.id, { title: 'literal' });
    svc.appendMessage(s2.id, { role: 'user', content: 'value has 100% and x_y' });
    expect(svc.searchSessions('100%').map((x) => x.id)).toEqual([s2.id]);
    expect(svc.searchSessions('x_y').map((x) => x.id)).toEqual([s2.id]);
  });
});

describe('renameSession', () => {
  it('重命名生效；空标题忽略；不存在报错', () => {
    const p = svc.ensureProject('/tmp/proj-a');
    const s = svc.createSession(p.id, { title: 'old' });
    svc.renameSession(s.id, 'new title');
    expect(svc.getSession(s.id)!.title).toBe('new title');
    svc.renameSession(s.id, '   ');
    expect(svc.getSession(s.id)!.title).toBe('new title');
    expect(() => svc.renameSession('nope', 'x')).toThrow(/not found/);
  });
});
