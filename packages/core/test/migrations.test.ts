/**
 * F-35 Schema migration 测试：全新库建表、旧库升级（数据保留）、
 * 幂等重开、版本回退防护。
 */
import { describe, expect, it, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { SessionStore, SessionService } from '../src/index.js';
import { MIGRATIONS, LATEST_SCHEMA_VERSION, migrate, currentSchemaVersion } from '../src/session/migrations.js';

const dirs: string[] = [];
async function tmpFile(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-migrate-'));
  dirs.push(dir);
  return path.join(dir, name);
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe('migrate() 运行器', () => {
  it('迁移版本号必须从 1 连续递增', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    expect(LATEST_SCHEMA_VERSION).toBe(MIGRATIONS.length);
  });

  it('全新库：应用全部迁移，建齐所有表', async () => {
    const file = await tmpFile('fresh.db');
    const store = new SessionStore(file);
    try {
      expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
      const tables = (
        store.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as Array<{ name: string }>
      ).map((r) => r.name);
      for (const t of ['projects', 'sessions', 'messages', 'messages_fts', 'message_embeddings', 'idx_messages_session']) {
        expect(tables).toContain(t);
      }
    } finally {
      store.close();
    }
  });

  it('重复打开：幂等，版本不变，数据保留', async () => {
    const file = await tmpFile('idem.db');
    let sid = '';
    {
      const svc = new SessionService(file);
      const pid = svc.ensureProject('/tmp').id;
      sid = svc.createSession(pid, { title: '幂等' }).id;
      svc.appendMessage(sid, { role: 'user', content: '迁移幂等验证' });
      svc.close();
    }
    {
      const svc = new SessionService(file);
      try {
        expect(svc.store.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
        expect(svc.getSession(sid)?.title).toBe('幂等');
        expect(svc.getHistory(sid)).toHaveLength(1);
      } finally {
        svc.close();
      }
    }
  });

  it('旧库升级：v1 数据保留，v2 结构补齐且检索可用', async () => {
    const file = await tmpFile('legacy.db');
    // 手工构造 v1 时代的库：仅执行第一条迁移，写入一条消息，user_version=1
    {
      const db = new Database(file);
      db.pragma('journal_mode = WAL');
      db.exec(MIGRATIONS[0]!.sql);
      db.pragma('user_version = 1');
      // projects 表有 FK，先建项目行再建会话行（better-sqlite3 默认开启外键）
      db.prepare("INSERT INTO projects (id, name, root_path, created_at) VALUES ('p-legacy', 'legacy', '/tmp/legacy', '2026-01-01T00:00:00.000Z')").run();
      db.prepare(
        "INSERT INTO sessions (id, project_id, title, mode, model, status, created_at, updated_at) VALUES ('s-legacy', 'p-legacy', '旧会话', 'react', '', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
      ).run();
      db.prepare(
        "INSERT INTO messages (session_id, seq, role, content_json, tokens, created_at) VALUES ('s-legacy', 1, 'user', ?, 0, '2026-01-01T00:00:00.000Z')",
      ).run(JSON.stringify({ role: 'user', content: '历史遗留的池化讨论' }));
      db.close();
    }
    // 新版本代码打开：自动升级到最新版本
    const store = new SessionStore(file);
    try {
      expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
      // 旧数据完整保留
      const msg = store.db.prepare("SELECT content_json FROM messages WHERE session_id = 's-legacy'").get() as
        | { content_json: string }
        | undefined;
      expect(msg?.content_json).toContain('池化');
      // v2 结构存在且旧消息可被懒回填检索
      const svc = new SessionService(file);
      try {
        const hits = await svc.searchMessages('池化', { mode: 'fulltext' });
        expect(hits.length).toBe(1);
        expect(hits[0]!.sessionId).toBe('s-legacy');
      } finally {
        svc.close();
      }
    } finally {
      store.close();
    }
  });

  it('库版本高于程序支持时拒绝打开（防降级写坏数据）', async () => {
    const file = await tmpFile('future.db');
    {
      const db = new Database(file);
      db.pragma('user_version = 999');
      db.close();
    }
    expect(() => new SessionStore(file)).toThrow(/高于程序支持的最高版本/);
  });

  it('currentSchemaVersion 与 migrate 返回值一致', async () => {
    const file = await tmpFile('meta.db');
    const db = new Database(file);
    try {
      const r = migrate(db);
      expect(r.from).toBe(0);
      expect(r.to).toBe(LATEST_SCHEMA_VERSION);
      expect(r.applied).toEqual(MIGRATIONS.map((m) => m.version));
      expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });
});
