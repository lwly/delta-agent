/**
 * F-55 Task 1：v6 迁移（sessions.external_id / external_agent + usage.billing）
 * 与 SessionStore.recordUsage 的 billing 口径（metered / subscription）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { SessionStore, SessionService } from '../src/index.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, hasColumn, migrate } from '../src/session/migrations.js';

const dirs: string[] = [];
async function tmpDb(name = 'test.db'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-f55-migrate-'));
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

describe('v6 迁移：f55-external-agents', () => {
  it('全新内存库：migrate 到最新版，三列结构符合设计', () => {
    const db = new Database(':memory:');
    try {
      const r = migrate(db);
      expect(r.applied).toContain(6);
      expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);

      const extId = columnInfo(db, 'sessions', 'external_id');
      expect(extId.type.toUpperCase()).toBe('TEXT');
      expect(extId.notnull).toBe(0);
      expect(extId.dflt_value).toBe('NULL');

      const extAgent = columnInfo(db, 'sessions', 'external_agent');
      expect(extAgent.type.toUpperCase()).toBe('TEXT');
      expect(extAgent.notnull).toBe(0);
      expect(extAgent.dflt_value).toBe('NULL');

      const billing = columnInfo(db, 'usage', 'billing');
      expect(billing.type.toUpperCase()).toBe('TEXT');
      expect(billing.notnull).toBe(1);
      expect(billing.dflt_value).toBe("'metered'");
    } finally {
      db.close();
    }
  });

  it('v5 旧库升级：历史 usage 行回填 billing=metered，sessions 新列为 NULL', () => {
    const db = new Database(':memory:');
    try {
      // 手工构造 v5 结构的库：执行 v1–v5 迁移 SQL，写入历史行，user_version=5
      for (const m of MIGRATIONS.slice(0, 5)) db.exec(m.sql);
      db.pragma('user_version = 5');
      db.prepare(
        "INSERT INTO projects (id, name, root_path, created_at) VALUES ('p-f55', 'f55', '/tmp/f55', '2026-01-01T00:00:00.000Z')",
      ).run();
      db.prepare(
        "INSERT INTO sessions (id, project_id, title, mode, model, status, created_at, updated_at) VALUES ('s-f55', 'p-f55', '旧会话', 'react', '', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
      ).run();
      db.prepare(
        "INSERT INTO usage (session_id, turn, input_tokens, output_tokens, cost_usd, model, created_at) VALUES ('s-f55', 1, 100, 50, 0.01, 'claude-x', '2026-01-01T00:00:00.000Z')",
      ).run();

      migrate(db);
      expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);

      // 历史数据保留：usage 行自动按 DEFAULT 回填 metered
      const usage = db.prepare("SELECT billing FROM usage WHERE session_id = 's-f55'").get() as { billing: string };
      expect(usage.billing).toBe('metered');
      // 历史会话新列为 NULL（零回归）
      const session = db.prepare("SELECT external_id, external_agent FROM sessions WHERE id = 's-f55'").get() as {
        external_id: string | null;
        external_agent: string | null;
      };
      expect(session.external_id).toBeNull();
      expect(session.external_agent).toBeNull();
    } finally {
      db.close();
    }
  });

  it('幂等重放：user_version 被改小到 5 且列已存在时，重跑 migrate 不炸且版本推进', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      // 模拟外部工具改小版本号：列已在、版本回退
      db.pragma('user_version = 5');
      const r = migrate(db);
      expect(r.to).toBe(LATEST_SCHEMA_VERSION);
      expect(r.applied).toContain(6);
      expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
      // skipIf 生效：三列仍各只有一份定义（ALTER 未重放）
      expect(hasColumn(db, 'sessions', 'external_id')).toBe(true);
      expect(hasColumn(db, 'sessions', 'external_agent')).toBe(true);
      expect(hasColumn(db, 'usage', 'billing')).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('SessionStore.recordUsage billing 口径', () => {
  it('缺省 billing 落库为 metered；显式 subscription 落库为 subscription', async () => {
    const file = await tmpDb();
    const svc = new SessionService(file);
    try {
      const pid = svc.ensureProject('/tmp/demo-f55-billing').id;
      const sid = svc.createSession(pid).id;

      svc.recordUsage(sid, 1, 10, 5, 0.001, 'claude-x');
      svc.recordUsage(sid, 2, 20, 8, 0, 'codex', 'subscription');

      const rows = svc.store.db
        .prepare('SELECT turn, billing FROM usage WHERE session_id = ? ORDER BY turn')
        .all(sid) as Array<{ turn: number; billing: string }>;
      expect(rows).toEqual([
        { turn: 1, billing: 'metered' },
        { turn: 2, billing: 'subscription' },
      ]);
    } finally {
      svc.close();
    }
  });

  it('SessionStore 直接调用：新尾参 billing 缺省值生效', async () => {
    const file = await tmpDb('store.db');
    const store = new SessionStore(file);
    try {
      store.createProject('p-f55-store', 'f55-store', '/tmp/demo-f55-store');
      const sid = store.createSession({ id: 's-f55-store', projectId: 'p-f55-store' }).id;
      store.recordUsage(sid, 1, 1, 1, 0);
      const row = store.db.prepare('SELECT billing FROM usage WHERE session_id = ?').get(sid) as { billing: string };
      expect(row.billing).toBe('metered');
    } finally {
      store.close();
    }
  });
});
