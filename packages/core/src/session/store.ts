import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ChatMessage } from '@y-zero/shared';

const SCHEMA = `
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
  session_id TEXT NOT NULL REFERENCES sessions(id),
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
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id, status);
CREATE INDEX IF NOT EXISTS idx_mem_scope ON memories(scope, deleted_at);
CREATE INDEX IF NOT EXISTS idx_mem_hash ON memories(content_hash);
`;

export interface SessionRow {
  id: string;
  project_id: string;
  title: string;
  mode: string;
  model: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
  session_count: number;
}

export interface TrashItem {
  kind: 'project' | 'session';
  id: string;
  name: string;
  deleted_at: string;
  /** session 项携带所属项目（恢复前校验项目存活） */
  project_id?: string;
}

/**
 * SQLite persistence (better-sqlite3, WAL mode).
 * Soft-delete via deleted_at; raw messages are never destroyed except by
 * explicit hard purge (回收站 30 天策略属 M4 Web 交付范围).
 */
export class SessionStore {
  readonly db: Database.Database;
  readonly file: string;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.file = dbPath;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ── projects ──────────────────────────────────────────────────────────────

  findProjectByRoot(rootPath: string): { id: string; name: string; root_path: string } | undefined {
    return this.db
      .prepare('SELECT id, name, root_path FROM projects WHERE root_path = ? AND deleted_at IS NULL')
      .get(path.resolve(rootPath)) as { id: string; name: string; root_path: string } | undefined;
  }

  createProject(id: string, name: string, rootPath: string): void {
    this.db
      .prepare('INSERT INTO projects (id, name, root_path, created_at) VALUES (?, ?, ?, ?)')
      .run(id, name, path.resolve(rootPath), new Date().toISOString());
  }

  /** Live projects with per-project live session counts. */
  listProjects(): ProjectRow[] {
    return this.db.prepare(
      `SELECT p.id, p.name, p.root_path, p.created_at,
              (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id AND s.deleted_at IS NULL) AS session_count
       FROM projects p WHERE p.deleted_at IS NULL ORDER BY p.created_at ASC`,
    ).all() as ProjectRow[];
  }

  getProject(id: string): ProjectRow | undefined {
    return this.db.prepare(
      `SELECT p.id, p.name, p.root_path, p.created_at,
              (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id AND s.deleted_at IS NULL) AS session_count
       FROM projects p WHERE p.id = ? AND p.deleted_at IS NULL`,
    ).get(id) as ProjectRow | undefined;
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  createSession(row: {
    id: string;
    projectId: string;
    title?: string;
    mode?: string;
    model?: string;
  }): SessionRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO sessions (id, project_id, title, mode, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(row.id, row.projectId, row.title ?? 'New session', row.mode ?? 'react', row.model ?? '', 'active', now, now);
    return this.getSession(row.id)!;
  }

  getSession(id: string): SessionRow | undefined {
    return this.db
      .prepare('SELECT id, project_id, title, mode, model, status, created_at, updated_at FROM sessions WHERE id = ? AND deleted_at IS NULL')
      .get(id) as SessionRow | undefined;
  }

  listSessions(projectId: string): SessionRow[] {
    return this.db
      .prepare('SELECT id, project_id, title, mode, model, status, created_at, updated_at FROM sessions WHERE project_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC')
      .all(projectId) as SessionRow[];
  }

  touchSession(id: string, patch: { title?: string; status?: string }): void {
    const sets: string[] = ['updated_at = ?'];
    const vals: unknown[] = [new Date().toISOString()];
    if (patch.title !== undefined) { sets.push('title = ?'); vals.push(patch.title); }
    if (patch.status !== undefined) { sets.push('status = ?'); vals.push(patch.status); }
    vals.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  /** Soft delete: mark deleted_at; hard purge is a separate explicit call. */
  softDeleteSession(id: string): void {
    this.db.prepare('UPDATE sessions SET deleted_at = ?, status = ? WHERE id = ?')
      .run(new Date().toISOString(), 'deleted', id);
  }

  /** Soft delete project + cascade soft-delete its live sessions (§8.2). */
  softDeleteProject(id: string): void {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE projects SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, id);
      this.db.prepare("UPDATE sessions SET deleted_at = ?, status = 'deleted' WHERE project_id = ? AND deleted_at IS NULL").run(now, id);
    });
    tx();
  }

  /** Restore a soft-deleted session (project must be alive). */
  restoreSession(id: string): void {
    const project = this.db.prepare(
      'SELECT p.deleted_at AS p_deleted FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?',
    ).get(id) as { p_deleted: string | null } | undefined;
    if (!project) throw new Error('session not found in trash');
    if (project.p_deleted) throw new Error('project is in trash; restore the project first');
    this.db.prepare("UPDATE sessions SET deleted_at = NULL, status = 'active' WHERE id = ?").run(id);
  }

  /** Restore a soft-deleted project (its sessions stay in trash until restored individually). */
  restoreProject(id: string): void {
    const r = this.db.prepare('UPDATE projects SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL').run(id);
    if (r.changes === 0) throw new Error('project not found in trash');
  }

  /** Trash listing: soft-deleted sessions and projects. */
  listTrash(): TrashItem[] {
    const sessions = this.db.prepare(
      "SELECT id, title AS name, project_id, deleted_at FROM sessions WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC",
    ).all() as Array<{ id: string; name: string; project_id: string; deleted_at: string }>;
    const projects = this.db.prepare(
      'SELECT id, name, deleted_at FROM projects WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC',
    ).all() as Array<{ id: string; name: string; deleted_at: string }>;
    return [
      ...projects.map((p) => ({ kind: 'project' as const, id: p.id, name: p.name, deleted_at: p.deleted_at })),
      ...sessions.map((s) => ({ kind: 'session' as const, id: s.id, name: s.name, deleted_at: s.deleted_at, project_id: s.project_id })),
    ];
  }

  /** Physical delete of one session and its children, inside a transaction. */
  hardDeleteSession(id: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM compactions WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM usage WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM tasks WHERE session_id = ?').run(id);
      this.db.prepare("DELETE FROM memories WHERE scope = ?").run(`session:${id}`);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    });
    tx();
  }

  /** Physical delete of a project and ALL its sessions' data, inside a transaction. */
  hardDeleteProject(id: string): void {
    const tx = this.db.transaction(() => {
      const ids = (this.db.prepare('SELECT id FROM sessions WHERE project_id = ?').all(id) as Array<{ id: string }>)
        .map((r) => r.id);
      for (const sid of ids) {
        this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sid);
        this.db.prepare('DELETE FROM compactions WHERE session_id = ?').run(sid);
        this.db.prepare('DELETE FROM usage WHERE session_id = ?').run(sid);
        this.db.prepare('DELETE FROM tasks WHERE session_id = ?').run(sid);
      }
      this.db.prepare("DELETE FROM memories WHERE scope = ?").run(`project:${id}`);
      this.db.prepare('DELETE FROM sessions WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    });
    tx();
  }

  /** Purge soft-deleted items older than `days` (default 30). Returns purged count. */
  purgeExpired(days = 30): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const stale = (this.db.prepare(
      "SELECT id FROM sessions WHERE deleted_at IS NOT NULL AND deleted_at <= ? UNION SELECT id FROM projects WHERE deleted_at IS NOT NULL AND deleted_at <= ?",
    ).all(cutoff, cutoff) as Array<{ id: string }>).map((r) => r.id);
    for (const id of stale) {
      const isProject = (this.db.prepare('SELECT 1 AS x FROM projects WHERE id = ?').get(id)) !== undefined;
      if (isProject) this.hardDeleteProject(id);
      else this.hardDeleteSession(id);
    }
    return stale.length;
  }

  /** Full-text-ish search: title or message content LIKE (live sessions only). */
  searchSessions(query: string, limit = 20): SessionRow[] {
    const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.db.prepare(
      `SELECT DISTINCT s.id, s.project_id, s.title, s.mode, s.model, s.status, s.created_at, s.updated_at
       FROM sessions s LEFT JOIN messages m ON m.session_id = s.id
       WHERE s.deleted_at IS NULL AND (s.title LIKE ? ESCAPE '\\' OR m.content_json LIKE ? ESCAPE '\\')
       ORDER BY s.updated_at DESC LIMIT ?`,
    ).all(like, like, limit) as SessionRow[];
  }

  // ── messages ──────────────────────────────────────────────────────────────

  appendMessage(sessionId: string, m: ChatMessage): void {
    const seq = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE session_id = ?')
      .get(sessionId) as { s: number }).s + 1;
    this.db
      .prepare('INSERT INTO messages (session_id, seq, role, content_json, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, seq, m.role, JSON.stringify(m), Math.max(0, m.tokens ?? 0), new Date().toISOString());
  }

  /** Load full history ordered by seq (for resume). */
  getMessages(sessionId: string): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT content_json FROM messages WHERE session_id = ? ORDER BY seq ASC')
      .all(sessionId) as Array<{ content_json: string }>;
    return rows.map((r) => JSON.parse(r.content_json) as ChatMessage);
  }

  /** F-18 会话回放：带落库时间戳的消息（按 seq 升序）。 */
  getMessagesDetailed(sessionId: string): Array<{ message: ChatMessage; at: string }> {
    const rows = this.db
      .prepare('SELECT content_json, created_at FROM messages WHERE session_id = ? ORDER BY seq ASC')
      .all(sessionId) as Array<{ content_json: string; created_at: string }>;
    return rows.map((r) => ({ message: JSON.parse(r.content_json) as ChatMessage, at: r.created_at }));
  }

  recordCompaction(sessionId: string, before: number, after: number, summary: string): void {
    this.db
      .prepare('INSERT INTO compactions (session_id, before_tokens, after_tokens, summary_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, before, after, JSON.stringify({ summary }), new Date().toISOString());
  }

  recordUsage(sessionId: string, turn: number, inputTokens: number, outputTokens: number, costUsd: number): void {
    this.db
      .prepare('INSERT INTO usage (session_id, turn, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, turn, inputTokens, outputTokens, costUsd);
  }
}
