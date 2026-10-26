/**
 * F-39 T05：v5 迁移、会话绑定与降级
 */
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore, SessionService } from '../src/index.js';
import { currentSchemaVersion, migrate, hasColumn } from '../src/session/migrations.js';
import { resolveBinding } from '../src/experts/session-binding.js';
import type { ExpertRecord } from '../src/experts/types.js';

const dirs: string[] = [];
async function tmpDb(name = 'test.db'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-expert-bind-'));
  dirs.push(dir);
  return path.join(dir, name);
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

const fakeRecord = (over: Partial<ExpertRecord> = {}): ExpertRecord =>
  ({
    name: 'alpha',
    version: '1.0.0',
    description: '',
    author: { name: 't' },
    expertType: 'agent',
    displayName: { en: 'Alpha', zh: '阿尔法' },
    profession: { en: 'E', zh: '工程师' },
    layer: 'builtin',
    dir: '/tmp',
    avatarPath: null,
    skills: [],
    tools: null,
    keywords: [],
    categoryId: null,
    dependencies: { mcpServers: [] },
    agent: { id: 'alpha-agent', description: '', displayName: { en: 'a', zh: 'a' }, profession: { en: '', zh: '' }, body: 'b', skills: [], tools: [] },
    members: [],
    promptStats: { chars: 1, tokens: 1, truncated: false },
    ...over,
  }) as ExpertRecord;

describe('v5 迁移', () => {
  it('空库 → user_version=5，sessions 含两新列与索引', async () => {
    const store = new SessionStore(await tmpDb());
    try {
      expect(store.schemaVersion).toBe(5);
      expect(hasColumn(store.db, 'sessions', 'expert')).toBe(true);
      expect(hasColumn(store.db, 'sessions', 'expert_type')).toBe(true);
      const idx = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_expert'")
        .get();
      expect(idx).toBeTruthy();
    } finally {
      store.close();
    }
  });

  it('旧会话行 expert 为 NULL（零回归）', async () => {
    const store = new SessionStore(await tmpDb());
    const svc = new SessionService(store.file);
    try {
      const pid = svc.ensureProject('/tmp/demo-f39').id;
      const s = svc.createSession(pid);
      expect(s.expert).toBeNull();
      expect(s.expert_type).toBeNull();
    } finally {
      svc.close();
    }
  });

  it('幂等重放：user_version 被改小后重开 → 不抛错、版本推进、索引仍在', async () => {
    const file = await tmpDb('replay.db');
    const first = new SessionStore(file);
    const pid = first.listProjects().length;
    first.close();
    expect(pid).toBeGreaterThanOrEqual(0);

    const raw = (await import('better-sqlite3')).default(file);
    raw.pragma('user_version = 4');
    raw.close();

    const store = new SessionStore(file);
    try {
      expect(currentSchemaVersion(store.db)).toBe(5);
      expect(hasColumn(store.db, 'sessions', 'expert')).toBe(true);
      const idx = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_expert'")
        .get();
      expect(idx).toBeTruthy();
    } finally {
      store.close();
    }
  });

  it('migrate() 返回 applied 含 5', async () => {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    try {
      expect(migrate(db).applied).toContain(5);
    } finally {
      db.close();
    }
  });
});

describe('会话绑定', () => {
  it('team → mode 强制 react；agent → 原样；非法 expertType → 抛错', async () => {
    const store = new SessionStore(await tmpDb());
    const svc = new SessionService(store.file);
    try {
      const pid = svc.ensureProject('/tmp/demo-f39-2').id;
      const team = svc.createSession(pid, { mode: 'multi-agent', expert: 'software-dev-team', expertType: 'team' });
      expect(team.mode).toBe('react');
      expect(team.expert).toBe('software-dev-team');
      expect(team.expert_type).toBe('team');

      const solo = svc.createSession(pid, { mode: 'plan-execute', expert: 'alpha', expertType: 'agent' });
      expect(solo.mode).toBe('plan-execute');

      expect(() => svc.createSession(pid, { expert: 'x', expertType: 'team!' as never })).toThrow(/非法的 expert_type/);
    } finally {
      svc.close();
    }
  });

  it('getSession / listSessions / searchSessions 三处都返回新字段', async () => {
    const store = new SessionStore(await tmpDb());
    const svc = new SessionService(store.file);
    try {
      const pid = svc.ensureProject('/tmp/demo-f39-3').id;
      svc.createSession(pid, { title: '绑定会话', expert: 'alpha', expertType: 'agent' });
      expect(svc.getSession(svc.listSessions(pid)[0]!.id)!.expert).toBe('alpha');
      expect(svc.listSessions(pid)[0]!.expert_type).toBe('agent');
      expect(svc.searchSessions('绑定')[0]!.expert).toBe('alpha');
    } finally {
      svc.close();
    }
  });

  it('resolveBinding：正常 / 团队 / 缺失包', () => {
    expect(resolveBinding({ expert: 'alpha', mode: 'react' }, fakeRecord())).toEqual({
      name: 'alpha',
      type: 'agent',
      mode: 'react',
    });
    expect(resolveBinding({ expert: 't', mode: 'multi-agent' }, fakeRecord({ name: 't', expertType: 'team' }))).toEqual({
      name: 't',
      type: 'team',
      mode: 'react',
    });
    expect(resolveBinding({ expert: 'ghost', mode: 'react' }, undefined)).toEqual({
      name: null,
      type: null,
      mode: 'react',
      missing: 'ghost',
    });
    expect(resolveBinding({}, undefined)).toEqual({ name: null, type: null, mode: 'react' });
  });

  it('setSessionExpert 就地改绑/解绑（CLI 空会话用）', async () => {
    const store = new SessionStore(await tmpDb());
    const svc = new SessionService(store.file);
    try {
      const pid = svc.ensureProject('/tmp/demo-f39-4').id;
      const s = svc.createSession(pid);
      svc.setSessionExpert(s.id, { expert: 'alpha', expertType: 'agent' });
      expect(svc.getSession(s.id)!.expert).toBe('alpha');
      svc.setSessionExpert(s.id, { expert: null, expertType: null });
      expect(svc.getSession(s.id)!.expert).toBeNull();
    } finally {
      svc.close();
    }
  });
});
