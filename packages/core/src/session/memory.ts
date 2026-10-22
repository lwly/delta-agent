/**
 * L2 长期动态记忆（memory-design.md §3-§5/§8）
 * - 写入管线：SHA256 去重 → 配额检查（512 条/64k token）→ FIFO+importance 淘汰软删
 * - 召回评分：0.72 词汇覆盖率 + 0.12 importance + 0.08 confidence + 0.06 时间衰减 + 0.02 访问频率
 * - scope 隔离：global / project:<id> / session:<id>，召回按链路逐级合并
 * - 自动提炼候选进待确认队列（status='pending'），Web 一键采纳
 */
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export const MEMORY_QUOTA = 512;
export const MEMORY_DECAY_HALF_LIFE_DAYS = 30;
export const RECALL_THRESHOLD = 0.25;
export const TRASH_RETENTION_DAYS = 30;

export type MemoryKind = 'preference' | 'fact' | 'decision' | 'pitfall' | 'workflow';
export type MemoryStatus = 'confirmed' | 'pending';

export interface MemoryItem {
  id: string;
  scope: string;
  kind: MemoryKind | string;
  content: string;
  keywords: string;
  importance: number;
  confidence: number;
  access_count: number;
  last_access_at: number | null;
  source: string | null;
  status: MemoryStatus;
  superseded_by: string | null;
  created_at: number;
  deleted_at: number | null;
}

export interface SaveInput {
  scope: string;
  kind: MemoryKind | string;
  content: string;
  importance?: number;
  confidence?: number;
  keywords?: string;
  source?: 'tool' | 'auto-distill' | 'user';
  status?: MemoryStatus;
}

export interface SaveResult {
  ok: boolean;
  action: 'created' | 'duplicate' | 'superseded';
  id: string;
  evicted: MemoryItem[];
}

export interface MemoryHit {
  item: MemoryItem;
  score: number;
}

export interface Tokenizer {
  /** 查询/内容 → 检索 token 集合（中文按字 bigram + 英文按词，小写） */
  (text: string): Set<string>;
}

/**
 * 分词器：中文 2-gram + 英文/数字词。与 Skill 匹配器思路一致但独立实现
 * （记忆侧需要 token 集合运算，不做评分加权）。
 */
export const memoryTokenize: Tokenizer = (text) => {
  const out = new Set<string>();
  const lower = (text ?? '').toLowerCase();
  // 英文/数字词
  for (const w of lower.match(/[a-z0-9_]+/g) ?? []) out.add(w);
  // 中文（含 CJK 扩展）按字 bigram
  const cjk = lower.match(/[\u3200-\u9FFF\uF900-\uFAFF]+/g) ?? [];
  for (const run of cjk) {
    const chars = [...run];
    for (let i = 0; i < chars.length; i++) {
      out.add(chars[i]!);
      if (i + 1 < chars.length) out.add(chars[i]! + chars[i + 1]!);
    }
  }
  return out;
};

/** O(n) token 估算：中文 ≈1 token/字，英文 ≈3 chars/token（配额检查用）。 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3200-\u9FFF\uF900-\uFAFF]/g) ?? []).length;
  return cjk + Math.ceil((text.length - cjk) / 3);
}

const KINDS: string[] = ['preference', 'fact', 'decision', 'pitfall', 'workflow'];

export class MemoryStore {
  constructor(private readonly db: Database.Database) {}

  // ── 写入管线（§4）────────────────────────────────────────────────────────

  save(input: SaveInput): SaveResult {
    const content = input.content.trim();
    if (!content) throw new Error('memory content is empty');
    const kind = KINDS.includes(input.kind) ? input.kind : 'fact';
    const importance = clamp(input.importance ?? 0.5);
    const confidence = clamp(input.confidence ?? 0.8);
    const hash = createHash('sha256').update(content).digest('hex');

    // ② SHA256 去重（scope 内）：命中合并来源、confidence 取最大
    const dup = this.db
      .prepare(
        `SELECT * FROM memories WHERE content_hash = ? AND scope = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .get(hash, input.scope) as MemoryItem | undefined;
    if (dup) {
      this.db
        .prepare('UPDATE memories SET confidence = MAX(confidence, ?), source = ? WHERE id = ?')
        .run(confidence, input.source ?? dup.source, dup.id);
      return { ok: true, action: 'duplicate', id: dup.id, evicted: [] };
    }

    // ④ 冲突：同 kind 且词汇高度重叠的旧条 → 保留新，旧条降 confidence 标 superseded（§8）
    const superseded = this.supersedeConflicts(input.scope, kind, content, hash);

    // ③ 配额检查 → 超额先淘汰（候选回收站不占配额）
    const evicted = this.evictForQuota(input.scope, 1);

    // ⑤ 写入
    const id = randomUUID();
    const keywords = (input.keywords ?? [...memoryTokenize(content)].slice(0, 40).join(' ')).slice(0, 2000);
    this.db
      .prepare(
        `INSERT INTO memories (id, scope, kind, content, keywords, importance, confidence, access_count, content_hash, source, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(
        id, input.scope, kind, content, keywords, importance, confidence, hash,
        input.source ?? 'tool', input.status ?? 'confirmed', Date.now(),
      );
    return { ok: true, action: superseded.length > 0 ? 'superseded' : 'created', id, evicted };
  }

  /** 同 kind 新旧冲突：覆盖率 ≥ 0.6 视为同一事实的新版本。 */
  private supersedeConflicts(scope: string, kind: string, content: string, excludeHash: string): MemoryItem[] {
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE scope = ? AND kind = ? AND deleted_at IS NULL AND status = 'confirmed' AND content_hash != ?`)
      .all(scope, kind, excludeHash) as MemoryItem[];
    const q = memoryTokenize(content);
    const marked: MemoryItem[] = [];
    for (const row of rows) {
      const coverage = coverageOf(q, `${row.content} ${row.keywords}`);
      if (coverage >= 0.6) {
        this.db
          .prepare('UPDATE memories SET confidence = 0.3, superseded_by = ? WHERE id = ?')
          .run('pending-new-write', row.id);
        marked.push(row);
      }
    }
    return marked;
  }

  /** 配额：超额时 FIFO 取最旧一批，按 importance 升序淘汰低价值项（软删）。 */
  private evictForQuota(scope: string, incoming: number): MemoryItem[] {
    const count = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM memories WHERE scope = ? AND deleted_at IS NULL')
        .get(scope) as { n: number }
    ).n;
    let over = count + incoming - MEMORY_QUOTA;
    if (over <= 0) return [];
    const evicted: MemoryItem[] = [];
    // 旧一批（FIFO 前 64 条），按 importance 升序淘汰
    const candidates = this.db
      .prepare(
        `SELECT * FROM memories WHERE scope = ? AND deleted_at IS NULL
         ORDER BY created_at ASC LIMIT 64`,
      )
      .all(scope) as MemoryItem[];
    candidates.sort((a, b) => a.importance - b.importance || a.created_at - b.created_at);
    for (const c of candidates) {
      if (over <= 0) break;
      if (c.importance >= 1) continue; // 置顶（importance=1）不淘汰
      this.db
        .prepare('UPDATE memories SET deleted_at = ? WHERE id = ?')
        .run(Date.now(), c.id);
      evicted.push(c);
      over--;
    }
    return evicted;
  }

  // ── 召回（§5）────────────────────────────────────────────────────────────

  /**
   * 评分召回：scope 链路逐级合并（如 [session, project, global]，先出现优先）。
   * 召回即反馈：access_count+1、刷新 last_access_at。
   */
  recall(query: string, scopes: string[], k = 5): MemoryHit[] {
    const q = memoryTokenize(query);
    if (q.size === 0) return [];
    const now = Date.now();
    const hits: MemoryHit[] = [];
    const seen = new Set<string>();
    for (const scope of scopes) {
      const rows = this.db
        .prepare(
          `SELECT * FROM memories WHERE scope = ? AND deleted_at IS NULL AND status = 'confirmed'`,
        )
        .all(scope) as MemoryItem[];
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        const coverage = coverageOf(q, `${row.content} ${row.keywords}`);
        const ageDays = (now - row.created_at) / 86_400_000;
        const decay = Math.pow(0.5, ageDays / MEMORY_DECAY_HALF_LIFE_DAYS);
        const freq = Math.min(1, Math.log2(1 + row.access_count) / 5);
        const score =
          0.72 * coverage + 0.12 * row.importance + 0.08 * row.confidence + 0.06 * decay + 0.02 * freq;
        if (score < RECALL_THRESHOLD) continue;
        hits.push({ item: row, score: Math.min(1, score) });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, k);
    // 召回即反馈
    for (const h of top) {
      this.db
        .prepare('UPDATE memories SET access_count = access_count + 1, last_access_at = ? WHERE id = ?')
        .run(now, h.item.id);
    }
    return top;
  }

  // ── 管理（§8/§9）─────────────────────────────────────────────────────────

  list(filter: { scope?: string; kind?: string; status?: MemoryStatus } = {}): MemoryItem[] {
    const where = ['deleted_at IS NULL'];
    const vals: unknown[] = [];
    if (filter.scope) { where.push('scope = ?'); vals.push(filter.scope); }
    if (filter.kind) { where.push('kind = ?'); vals.push(filter.kind); }
    if (filter.status) { where.push('status = ?'); vals.push(filter.status); }
    return this.db
      .prepare(`SELECT * FROM memories WHERE ${where.join(' AND ')} ORDER BY importance DESC, created_at DESC`)
      .all(...vals) as MemoryItem[];
  }

  get(id: string): MemoryItem | undefined {
    return this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryItem | undefined;
  }

  update(id: string, patch: Partial<Pick<MemoryItem, 'content' | 'keywords' | 'importance' | 'confidence' | 'kind' | 'status'>>): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.content !== undefined) {
      sets.push('content = ?', 'content_hash = ?');
      const c = String(patch.content).trim();
      vals.push(c, createHash('sha256').update(c).digest('hex'));
    }
    if (patch.keywords !== undefined) { sets.push('keywords = ?'); vals.push(patch.keywords); }
    if (patch.importance !== undefined) { sets.push('importance = ?'); vals.push(clamp(patch.importance)); }
    if (patch.confidence !== undefined) { sets.push('confidence = ?'); vals.push(clamp(patch.confidence)); }
    if (patch.kind !== undefined) { sets.push('kind = ?'); vals.push(patch.kind); }
    if (patch.status !== undefined) { sets.push('status = ?'); vals.push(patch.status); }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  remove(id: string, hard = false): boolean {
    if (hard) return this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
    return this.db.prepare('UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(Date.now(), id).changes > 0;
  }

  restore(id: string): boolean {
    return this.db.prepare('UPDATE memories SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL').run(id).changes > 0;
  }

  listTrash(): MemoryItem[] {
    return this.db
      .prepare('SELECT * FROM memories WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC')
      .all() as MemoryItem[];
  }

  /** 记忆回收站过期清理（默认 30 天），返回清除条数。 */
  purgeExpired(days = TRASH_RETENTION_DAYS): number {
    const cutoff = Date.now() - days * 86_400_000;
    return this.db.prepare('DELETE FROM memories WHERE deleted_at IS NOT NULL AND deleted_at <= ?').run(cutoff).changes;
  }

  /** 待确认队列（自动提炼候选）。 */
  listPending(): MemoryItem[] {
    return this.list({ status: 'pending' });
  }

  approve(id: string): boolean {
    return this.db.prepare("UPDATE memories SET status = 'confirmed' WHERE id = ? AND status = 'pending'").run(id).changes > 0;
  }

  reject(id: string): boolean {
    return this.remove(id, false);
  }

  /** 导出（可迁移/备份，§8）。 */
  export(scope?: string): MemoryItem[] {
    if (scope) return this.list({ scope });
    return this.list();
  }

  /** 配额用量（面板展示）。 */
  usage(scope: string): { count: number; tokens: number } {
    const rows = this.list({ scope });
    return {
      count: rows.length,
      tokens: rows.reduce((n, r) => n + estimateTokens(r.content), 0),
    };
  }
}

/** 查询 token 被记忆覆盖的比例（词汇覆盖率核心项）。 */
export function coverageOf(queryTokens: Set<string>, memoryText: string): number {
  if (queryTokens.size === 0) return 0;
  const m = memoryTokenize(memoryText);
  let hit = 0;
  for (const t of queryTokens) if (m.has(t)) hit++;
  return hit / queryTokens.size;
}

function clamp(v: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.5));
}
