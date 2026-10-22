/**
 * 文件变更管理（PRD F-24）：
 * - 每次写操作前自动快照（before/after 内容，超大/二进制只记标记）
 * - 会话级 diff 汇总（按文件聚合变更次数与行数增删）
 * - 一键回滚到任意检查点（反向应用 before 内容；新建文件回滚即删除）
 * git 集成（建议分支/自动 commit 策略）为后续独立任务。
 */
import Database from 'better-sqlite3';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { resolveInSandbox } from '../tools/sandbox.js';

/** 单文件快照上限（超过只记 oversized 标记，不存内容）。 */
export const MAX_SNAPSHOT_BYTES = 1_000_000;

export interface FileChangeRow {
  id: number;
  session_id: string;
  tool: string;
  path: string;
  before_content: string | null;
  after_content: string | null;
  before_oversized: number;
  after_oversized: number;
  /** 已被回滚应用过（防止重复撤销，如二次 /rollback 误删用户新建的文件） */
  rolled_back: number;
  created_at: number;
}

export interface RecordChangeInput {
  tool: string;
  /** 相对 projectRoot 的路径 */
  path: string;
  /** null = 写前文件不存在（新建） */
  before: string | null;
  /** null = 写后文件不存在或超大未存 */
  after: string | null;
  beforeOversized?: boolean;
  afterOversized?: boolean;
}

export interface ChangeSummaryItem {
  path: string;
  /** 变更次数 */
  changes: number;
  /** 行数增删统计（多重集合差近似口径） */
  added: number;
  removed: number;
  /** 最新一条变更 id（回滚锚点） */
  lastChangeId: number;
}

export interface RollbackResult {
  reverted: Array<{ id: number; path: string; action: 'restored' | 'deleted' }>;
  skipped: Array<{ id: number; path: string; reason: string }>;
}

/** 读文件内容用于快照：ENOENT → null（不存在）；超大/二进制 → oversized 标记。 */
export async function readSnapshot(
  absPath: string,
): Promise<{ content: string | null; oversized: boolean }> {
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    return { content: null, oversized: false }; // 不存在
  }
  if (stat.size > MAX_SNAPSHOT_BYTES) return { content: null, oversized: true };
  const buf = await fs.readFile(absPath).catch(() => Buffer.alloc(0));
  // 二进制探测：前 8KB 含 NUL 字节不快照（内容无法以 TEXT 可靠还原）
  if (buf.subarray(0, 8192).includes(0)) return { content: null, oversized: true };
  return { content: buf.toString('utf8'), oversized: false };
}

/** 行数增删统计：多重集合差近似（相同行抵消，不做最长公共子序列）。 */
export function countLineDelta(
  before: string | null,
  after: string | null,
): { added: number; removed: number } {
  if (before === null && after === null) return { added: 0, removed: 0 };
  if (before === null) return { added: (after ?? '').split('\n').length, removed: 0 };
  if (after === null) return { added: 0, removed: before.split('\n').length };
  const tally = new Map<string, number>();
  for (const line of before.split('\n')) tally.set(line, (tally.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of after.split('\n')) {
    const n = tally.get(line) ?? 0;
    if (n > 0) tally.set(line, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of tally.values()) removed += n;
  return { added, removed };
}

/**
 * FileChangeStore：与 SessionStore 同库（复用其 SQLite 连接）。
 * 写操作快照 → 会话级汇总 → 任意检查点回滚。
 */
export class FileChangeStore {
  constructor(private readonly db: Database.Database) {}

  record(sessionId: string, input: RecordChangeInput): number {
    const r = this.db
      .prepare(
        `INSERT INTO file_changes (session_id, tool, path, before_content, after_content, before_oversized, after_oversized, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        input.tool,
        input.path,
        input.before,
        input.after,
        input.beforeOversized ? 1 : 0,
        input.afterOversized ? 1 : 0,
        Date.now(),
      );
    return Number(r.lastInsertRowid);
  }

  get(sessionId: string, id: number): FileChangeRow | undefined {
    return this.db
      .prepare('SELECT * FROM file_changes WHERE session_id = ? AND id = ?')
      .get(sessionId, id) as FileChangeRow | undefined;
  }

  /** 会话变更清单（时间序，limit 默认 100）。 */
  list(sessionId: string, limit = 100): FileChangeRow[] {
    return this.db
      .prepare('SELECT * FROM file_changes WHERE session_id = ? ORDER BY id DESC LIMIT ?')
      .all(sessionId, limit) as FileChangeRow[];
  }

  /** 会话级 diff 汇总：按文件聚合变更次数 + 行数增删。 */
  summary(sessionId: string): ChangeSummaryItem[] {
    const rows = this.db
      .prepare('SELECT * FROM file_changes WHERE session_id = ? ORDER BY id ASC')
      .all(sessionId) as FileChangeRow[];
    const byPath = new Map<string, ChangeSummaryItem>();
    for (const row of rows) {
      let item = byPath.get(row.path);
      if (!item) {
        item = { path: row.path, changes: 0, added: 0, removed: 0, lastChangeId: row.id };
        byPath.set(row.path, item);
      }
      item.changes++;
      const delta = countLineDelta(row.before_content, row.after_content);
      item.added += delta.added;
      item.removed += delta.removed;
      item.lastChangeId = row.id;
    }
    return [...byPath.values()];
  }

  /** 会话内 changeId 之后的变更条数（beforeId 缺省 = 全部）。 */
  countAfter(sessionId: string, beforeId?: number): number {
    const r = beforeId
      ? this.db
          .prepare('SELECT COUNT(*) AS n FROM file_changes WHERE session_id = ? AND id > ?')
          .get(sessionId, beforeId)
      : this.db.prepare('SELECT COUNT(*) AS n FROM file_changes WHERE session_id = ?').get(sessionId);
    return Number((r as { n: number }).n);
  }

  /**
   * 一键回滚：撤销 changeId 之后（缺省 = 会话内全部）尚未回滚过的变更，按 id 逆序应用。
   * 应用成功的变更标记 rolled_back（不会被再次应用）。
   * - before 存在 → 恢复内容（restored）
   * - before 为 null（新建文件）→ 删除（deleted）
   * - before 超大未存 → 跳过（无法还原）
   */
  async rollbackTo(sessionId: string, projectRoot: string, beforeId?: number): Promise<RollbackResult> {
    const rows = beforeId
      ? (this.db
          .prepare(
            'SELECT * FROM file_changes WHERE session_id = ? AND id > ? AND rolled_back = 0 ORDER BY id DESC',
          )
          .all(sessionId, beforeId) as FileChangeRow[])
      : (this.db
          .prepare(
            'SELECT * FROM file_changes WHERE session_id = ? AND rolled_back = 0 ORDER BY id DESC',
          )
          .all(sessionId) as FileChangeRow[]);
    const result: RollbackResult = { reverted: [], skipped: [] };
    for (const row of rows) {
      if (row.before_oversized) {
        result.skipped.push({ id: row.id, path: row.path, reason: 'before snapshot oversized/binary' });
        continue;
      }
      let abs: string;
      try {
        abs = await resolveInSandbox(projectRoot, row.path);
      } catch (e) {
        result.skipped.push({ id: row.id, path: row.path, reason: (e as Error).message });
        continue;
      }
      if (row.before_content === null) {
        // 新建文件：回滚 = 删除
        await fs.rm(abs, { force: true });
        result.reverted.push({ id: row.id, path: row.path, action: 'deleted' });
      } else {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, row.before_content, 'utf8');
        result.reverted.push({ id: row.id, path: row.path, action: 'restored' });
      }
      this.db.prepare('UPDATE file_changes SET rolled_back = 1 WHERE id = ?').run(row.id);
    }
    return result;
  }
}

/** 渲染会话级变更汇总（CLI/TUI 用）。 */
export function renderSummary(items: ChangeSummaryItem[]): string {
  if (items.length === 0) return '（会话暂无文件变更）';
  return items
    .map(
      (it) =>
        `${it.path} · ${it.changes} 次变更（+${it.added} -${it.removed} 行）· 最新变更 #${it.lastChangeId}`,
    )
    .join('\n');
}
