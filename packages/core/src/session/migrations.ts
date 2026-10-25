/**
 * F-35 Schema migration：版本化数据迁移机制。
 * - 版本号存 `PRAGMA user_version`（SQLite 头字段，随事务提交/回滚）
 * - 迁移按 version 升序执行，每个迁移独立事务（SQL + 版本号原子生效）
 * - 迁移 SQL 必须幂等（CREATE TABLE IF NOT EXISTS 等），使
 *   「旧版本号的历史库」与「空库」都能安全收敛到最新状态：
 *   空库从头建表；历史库跳过已存在对象、仅补齐缺失结构
 * - 新增迁移：在 MIGRATIONS 数组末尾追加 { version: 上一版 + 1, name, sql }，
 *   不得修改历史迁移（已发布库的 user_version 已越过）
 */
import type Database from 'better-sqlite3';

export interface Migration {
  /** 递增版本号（= 应用后的 user_version 值） */
  version: number;
  name: string;
  /** 幂等 DDL，可多条语句 */
  sql: string;
}

/** v1 基线：F-17 之前的核心表结构（technical-design §8.1） */
const MIGRATION_V1_BASELINE = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  deleted_at TEXT DEFAULT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL DEFAULT 'New session',
  mode TEXT NOT NULL DEFAULT 'react',
  model TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT DEFAULT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS compactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  before_tokens INTEGER NOT NULL,
  after_tokens INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL DEFAULT 1,
  node_id TEXT NOT NULL,
  node_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  worker_id TEXT,
  lease_until INTEGER,
  heartbeat_at INTEGER,
  retries INTEGER NOT NULL DEFAULT 0,
  checkpoint_json TEXT,
  result TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  keywords TEXT,
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.8,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_access_at INTEGER,
  content_hash TEXT NOT NULL,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed',
  superseded_by TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS file_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  path TEXT NOT NULL,
  before_content TEXT,
  after_content TEXT,
  before_oversized INTEGER NOT NULL DEFAULT 0,
  after_oversized INTEGER NOT NULL DEFAULT 0,
  rolled_back INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id, status);
CREATE INDEX IF NOT EXISTS idx_mem_scope ON memories(scope, deleted_at);
CREATE INDEX IF NOT EXISTS idx_mem_hash ON memories(content_hash);
CREATE INDEX IF NOT EXISTS idx_changes_session ON file_changes(session_id, id);
`;

/** v2：F-17 对话检索的全文索引与向量表 */
const MIGRATION_V2_F17_SEARCH = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text,
  session_id UNINDEXED,
  role UNINDEXED,
  tokenize = 'unicode61'
);
CREATE TABLE IF NOT EXISTS message_embeddings (
  message_id INTEGER PRIMARY KEY,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL
);
`;

/** v3：F-31 用量报告——usage 补 model / created_at 并回填（会话级近似，裁决 #1） */
const MIGRATION_V3_F31_USAGE_REPORT = `
ALTER TABLE usage ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE usage ADD COLUMN created_at TEXT;
CREATE INDEX IF NOT EXISTS idx_usage_created_at ON usage(created_at);

-- 回填（幂等：重跑结果相同）。usage.session_id 关联 sessions.id（无外键约束，
-- 历史数据可能孤儿行，COALESCE 兜底不阻塞迁移）
UPDATE usage SET created_at = COALESCE(created_at,
  (SELECT s.created_at FROM sessions s WHERE s.id = usage.session_id));
-- 列名必须全限定：子查询的 sessions 也有 model，裸 model 会报 ambiguous column name
UPDATE usage SET model = CASE WHEN usage.model = ''
  THEN COALESCE((SELECT s.model FROM sessions s WHERE s.id = usage.session_id), '')
  ELSE usage.model END;
`;

/** v4：F-37 worktree 会话级绑定——sessions 加 worktree_path / worktree_branch（NULL = 主工作区） */
const MIGRATION_V4_F37_WORKTREE_BINDING = `
ALTER TABLE sessions ADD COLUMN worktree_path TEXT DEFAULT NULL;
ALTER TABLE sessions ADD COLUMN worktree_branch TEXT DEFAULT NULL;
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'baseline-core-tables', sql: MIGRATION_V1_BASELINE },
  { version: 2, name: 'f17-search-indexes', sql: MIGRATION_V2_F17_SEARCH },
  { version: 3, name: 'f31-usage-report', sql: MIGRATION_V3_F31_USAGE_REPORT },
  { version: 4, name: 'f37-worktree-binding', sql: MIGRATION_V4_F37_WORKTREE_BINDING },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** 当前库的 schema 版本（PRAGMA user_version）。 */
export function currentSchemaVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

export interface MigrateResult {
  from: number;
  to: number;
  /** 本次实际执行的迁移版本号（升序） */
  applied: number[];
}

/**
 * 应用所有未执行的迁移（幂等、事务化）。
 * 版本号校验：迁移列表必须严格递增且从 1 开始连续，防止漏写版本。
 */
export function migrate(db: Database.Database): MigrateResult {
  for (let i = 0; i < MIGRATIONS.length; i++) {
    const m = MIGRATIONS[i]!;
    if (m.version !== i + 1) {
      throw new Error(`migrations 版本号必须从 1 连续递增：第 ${i} 项 version=${m.version}`);
    }
  }
  const from = currentSchemaVersion(db);
  if (from > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `数据库 schema 版本 ${from} 高于程序支持的最高版本 ${LATEST_SCHEMA_VERSION}（是否用更新版本的 delta 打开过？）`,
    );
  }
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    const step = db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    });
    step();
    applied.push(m.version);
  }
  return { from, to: currentSchemaVersion(db), applied };
}
