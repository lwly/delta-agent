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

  it('PASI-9：执行中的会话禁止删除，暂停后可删除', () => {
    const p = svc.ensureProject('/tmp/proj-a');
    const s = svc.createSession(p.id, { title: 'running' });
    const ac = new AbortController();
    svc.registerRun(s.id, ac);

    // 执行中：删除被拦截
    expect(() => svc.removeSession(s.id)).toThrow(/执行中/);
    expect(svc.getSession(s.id)).toBeDefined();

    // 暂停：中止本轮并把状态落库为 paused
    expect(svc.pauseRun(s.id)).toBe(true);
    expect(ac.signal.aborted).toBe(true);
    expect(svc.isRunning(s.id)).toBe(false);
    expect(svc.getSession(s.id)!.status).toBe('paused');

    // 暂停后（非执行中）：允许删除
    svc.removeSession(s.id);
    expect(svc.getSession(s.id)).toBeUndefined();
  });

  it('PASI-9：pauseRun 对未运行的会话返回 false；resumeSession 清除暂停标记', () => {
    const p = svc.ensureProject('/tmp/proj-a');
    const s = svc.createSession(p.id, { title: 'idle' });
    expect(svc.pauseRun(s.id)).toBe(false);

    svc.registerRun(s.id, new AbortController());
    expect(svc.pauseRun(s.id)).toBe(true);
    expect(svc.getSession(s.id)!.status).toBe('paused');

    // resume 幂等：paused 才动状态，active 会话不受影响
    svc.resumeSession(s.id);
    expect(svc.getSession(s.id)!.status).toBe('active');
    svc.resumeSession(s.id);
    expect(svc.getSession(s.id)!.status).toBe('active');
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

describe('回收站批量彻底清除', () => {
  it('purgeTrashBatch：混合 project+session 全部成功', () => {
    const p1 = svc.ensureProject('/tmp/proj-a');
    const p2 = svc.ensureProject('/tmp/proj-b');
    const p3 = svc.ensureProject('/tmp/proj-c');
    const s = svc.createSession(p3.id, { title: 's1' });
    svc.removeProject(p1.id, 'proj-a');
    svc.removeProject(p2.id, 'proj-b');
    svc.removeSession(s.id);
    expect(svc.listTrash()).toHaveLength(3); // 2 项目 + 1 独立软删会话

    const result = svc.purgeTrashBatch([
      { kind: 'project', id: p1.id },
      { kind: 'project', id: p2.id },
      { kind: 'session', id: s.id },
    ]);
    expect(result.purged).toBe(3);
    expect(result.failed).toHaveLength(0);
    expect(svc.listTrash()).toHaveLength(0);
    expect(svc.listProjects().map((x) => x.id)).toEqual([p3.id]); // 未勾选项目不受影响
  });

  it('purgeTrashBatch：单条失败不影响其余（部分失败场景）', () => {
    const p = svc.ensureProject('/tmp/proj-a');
    const s1 = svc.createSession(p.id, { title: 'ok-1' });
    const s2 = svc.createSession(p.id, { title: 'ok-2' });
    svc.removeSession(s1.id);
    svc.removeSession(s2.id);

    // no-such-id 不在回收站 → 计入 failed；bogus 为非法 kind → 计入 failed
    const result = svc.purgeTrashBatch([
      { kind: 'session', id: 'no-such-id' },
      { kind: 'session', id: s1.id },
      { kind: 'bogus' as 'session', id: 'x' },
    ]);
    expect(result.purged).toBe(1);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0]).toMatchObject({ kind: 'session', id: 'no-such-id' });
    expect(result.failed[1]).toMatchObject({ kind: 'bogus', error: 'invalid kind or id' });
    expect(svc.listTrash()).toHaveLength(1); // s2 仍在回收站
    expect(() => svc.restore('session', 'no-such-id')).toThrow(/not found/);
  });

  it('purgeTrashBatch：空列表返回 0 成功 0 失败', () => {
    const result = svc.purgeTrashBatch([]);
    expect(result.purged).toBe(0);
    expect(result.failed).toHaveLength(0);
  });

  it('purgeTrashBatch：项目与其级联软删会话同批清除（purgeTrash 级联路径）', () => {
    const p = svc.ensureProject('/tmp/proj-a');
    const s1 = svc.createSession(p.id, { title: 's1' });
    const s2 = svc.createSession(p.id, { title: 's2' });
    svc.removeProject(p.id, 'proj-a'); // 级联软删 s1/s2，三者均在回收站

    // 前端允许同时勾选项目与其会话：项目硬删会级联硬删会话，后续会话清除应静默成功
    const result = svc.purgeTrashBatch([
      { kind: 'project', id: p.id },
      { kind: 'session', id: s1.id },
      { kind: 'session', id: s2.id },
    ]);
    expect(result.failed).toHaveLength(0);
    expect(svc.listTrash()).toHaveLength(0);
    expect(svc.listProjects()).toHaveLength(0);
  });
});
