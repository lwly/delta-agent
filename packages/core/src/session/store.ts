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
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id);
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
