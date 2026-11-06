/**
 * F-58 Task T1：v7 迁移（sessions.kind/role_label/task_id + worker_tasks + task_inbox）。
 * 对齐 migrations-f55.test.ts 的三条路径：空库直达 / v6 旧库升级 / user_version 被改小重放。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { SessionStore } from '../src/index.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, hasColumn, migrate } from '../src/session/migrations.js';

const dirs: string[] = [];
async function tmpDb(name = 'test.db'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-f58-migrate-'));
  dirs.push(dir);
  return path.join(dir, name);
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

function columnInfo(db: Database.Database, table: string, column: string): ColumnInfo {
  const rows = db.pragma(`table_info(${table})`) as ColumnInfo[];
  const col = rows.find((r) => r.name === column);
  expect(col, `${table}.${column} 列应存在`).toBeTruthy();
  return col!;
}

function indexNames(db: Database.Database, table: string): Set<string> {
  const rows = db.pragma(`index_list(${table})`) as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

describe('v7 迁移：f58-router-worker', () => {
  it('空库直跑迁移到 v7：sessions 三列 + 两表 + 索引齐备', () => {
    const db = new Database(':memory:');
    try {
      const r = migrate(db);
      expect(r.applied).toContain(7);
      expect(LATEST_SCHEMA_VERSION).toBe(7);
      expect(db.pragma('user_version', { simple: true })).toBe(7);

      const kind = columnInfo(db, 'sessions', 'kind');
      expect(kind.type.toUpperCase()).toBe('TEXT');
      expect(kind.notnull).toBe(1);
      expect(kind.dflt_value).toBe("'chat'");

      const roleLabel = columnInfo(db, 'sessions', 'role_label');
      expect(roleLabel.notnull).toBe(0);
      expect(roleLabel.dflt_value).toBe('NULL');

      const taskId = columnInfo(db, 'sessions', 'task_id');
      expect(taskId.notnull).toBe(0);

      expect(indexNames(db, 'sessions').has('idx_sessions_project_kind')).toBe(true);
      expect([...indexNames(db, 'worker_tasks')]).toEqual(
        expect.arrayContaining(['idx_wtasks_project', 'idx_wtasks_router', 'idx_wtasks_session']),
      );
      expect(indexNames(db, 'task_inbox')).toContain('idx_inbox_router');
    } finally {
      db.close();
    }
  });

  it('v6 旧库升级：历史行 kind=chat、role_label IS NULL，v6 列保留', () => {
    const db = new Database(':memory:');
    try {
      for (const m of MIGRATIONS.slice(0, 6)) db.exec(m.sql);
      db.pragma('user_version = 6');
      db.prepare(
        "INSERT INTO projects (id, name, root_path, created_at) VALUES ('p-f58', 'f58', '/tmp/f58', '2026-01-01T00:00:00.000Z')",
      ).run();
      db.prepare(
        "INSERT INTO sessions (id, project_id, title, mode, model, status, created_at, updated_at) VALUES ('s-f58', 'p-f58', '旧会话', 'react', '', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
      ).run();

      migrate(db);
      expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);

      const session = db.prepare(
        'SELECT kind, role_label, task_id, external_id, external_agent FROM sessions WHERE id = ?',
      ).get('s-f58') as { kind: string; role_label: string | null; task_id: string | null; external_id: string | null; external_agent: string | null };
      expect(session.kind).toBe('chat');
      expect(session.role_label).toBeNull();
      expect(session.task_id).toBeNull();
      // v6 列不受影响（零回归）
      expect(session.external_id).toBeNull();
      expect(session.external_agent).toBeNull();
    } finally {
      db.close();
    }
  });

  it('user_version 被改小到 6 后重放：skipIf 跳过 ALTER，repairSql 仍建 idx_sessions_project_kind', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      db.pragma('user_version = 6');
      const r = migrate(db);
      expect(r.to).toBe(LATEST_SCHEMA_VERSION);
      expect(r.applied).toContain(7);
      // skipIf 生效：三列仍各只有一份定义（ALTER 未重放，重复列会炸）
      expect(hasColumn(db, 'sessions', 'kind')).toBe(true);
      expect(hasColumn(db, 'sessions', 'role_label')).toBe(true);
      expect(hasColumn(db, 'sessions', 'task_id')).toBe(true);
      // repairSql 生效：即使跳过主 SQL，sessions 复合索引也存在
      expect(indexNames(db, 'sessions').has('idx_sessions_project_kind')).toBe(true);
      // 两表数据不丢
      expect(db.prepare('SELECT COUNT(*) AS n FROM worker_tasks').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('SessionStore 打开即迁移：schemaVersion=7，新会话 kind 默认 chat，可写 kind/task_id', async () => {
    const file = await tmpDb();
    const store = new SessionStore(file);
    try {
      expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
      store.createProject('p-kind', 'kind-demo', '/tmp/demo-f58-kind');
      const s = store.createSession({ id: 's-kind', projectId: 'p-kind' });
      expect(s.kind).toBe('chat');
      expect(s.role_label).toBeNull();
      expect(s.task_id).toBeNull();

      store.setSessionKind('s-kind', 'router');
      store.setSessionTask('s-kind', 'wt-123');
      const updated = store.getSession('s-kind')!;
      expect(updated.kind).toBe('router');
      expect(updated.task_id).toBe('wt-123');

      expect(() => store.setSessionKind('missing', 'router')).toThrow('session not found');
      expect(() => store.setSessionTask('missing', null)).toThrow('session not found');
    } finally {
      store.close();
    }
  });
});
