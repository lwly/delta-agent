/**
 * F-17 对话检索：全文（SQLite FTS5 + 中文 bigram 预分词）+ 语义（embedding 向量）
 * 混合检索，RRF（Reciprocal Rank Fusion）融合排序。
 * - 全文：messages_fts 虚拟表，rowid = messages.id；写入随 appendMessage 同步，
 *   存量数据懒回填（ensureIndexed）；软删会话（deleted_at 非空）不参与检索（§8.1）。
 * - 语义：message_embeddings 表（Float32 BLOB）；embedding client 懒解析、
 *   网络失败标记失效并降级为纯全文；cosine 相似度（本地规模全表扫描足够）。
 * - 融合：mode=auto 时两路命中按 RRF 合并；mode=fulltext/semantic 强制单路。
 */
import { memoryTokenize } from './memory.js';
import type { EmbeddingClient } from '../llm/embeddings.js';

export type SearchMode = 'auto' | 'fulltext' | 'semantic';

export interface SearchOptions {
  limit?: number;
  mode?: SearchMode;
}

export interface SearchHit {
  messageId: number;
  sessionId: string;
  sessionTitle: string;
  role: string;
  content: string;
  snippet: string;
  at: string;
  score: number;
  /** 命中来源：fulltext / semantic / hybrid（两路同时命中） */
  via: 'fulltext' | 'semantic' | 'hybrid';
}

/** FTS 索引文本上限（超长 tool 结果类内容截断） */
const FTS_INDEX_MAX_CHARS = 20_000;
/** 单条消息参与 embedding 的文本上限 */
const EMBED_MAX_CHARS = 2_000;
/** embedding 批大小 */
const EMBED_BATCH = 32;
/** 语义回填单次最多补嵌入的消息数（控制首次检索成本） */
const EMBED_BACKFILL_MAX = 1_000;
/** RRF 常数（论文推荐 k=60） */
const RRF_K = 60;

export type EmbedderFactory = () => EmbeddingClient | undefined;

/**
 * 检索分词：英文/数字词 + 中文 bigram（长度 1 的 CJK 串保留单字）。
 * 相比 memoryTokenize 去掉了单字 CJK——FTS 精确短语匹配需要 bigram 粒度，
 * 单字会引入大量误召回（"对话" 的 "对" 命中 "对齐"）。
 */
export function ftsTokenize(text: string): string[] {
  const out: string[] = [];
  const lower = (text ?? '').toLowerCase();
  for (const w of lower.match(/[a-z0-9_]+/g) ?? []) out.push(w);
  const cjk = lower.match(/[\u3200-\u9FFF\uF900-\uFAFF]+/g) ?? [];
  for (const run of cjk) {
    const chars = [...run];
    if (chars.length === 1) {
      out.push(chars[0]!);
      continue;
    }
    for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
  }
  return out;
}

/** 构建 FTS5 MATCH 查询串：每个 token 加引号、AND 连接（空 token 序列返回 null）。 */
export function buildFtsQuery(query: string): string | null {
  const tokens = ftsTokenize(query);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
}

/**
 * 从原文截取命中片段：定位任一查询 token 的首次出现，取前后窗口。
 * 找不到（如纯语义命中）回退为开头截断。
 */
export function makeSnippet(content: string, query: string, width = 96): string {
  const text = content.replace(/\s+/g, ' ').trim();
  if (text.length <= width) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  // 候选：英文词（≥2 字符）+ 查询 CJK 串的 bigram
  const candidates = new Set<string>();
  for (const w of q.match(/[a-z0-9_]{2,}/g) ?? []) candidates.add(w);
  for (const run of q.match(/[\u3200-\u9FFF\uF900-\uFAFF]+/g) ?? []) {
    const chars = [...run];
    if (chars.length === 1) candidates.add(chars[0]!);
    for (let i = 0; i + 1 < chars.length; i++) candidates.add(chars[i]! + chars[i + 1]!);
  }
  let pos = -1;
  for (const c of candidates) {
    const idx = lower.indexOf(c);
    if (idx >= 0 && (pos < 0 || idx < pos)) pos = idx;
  }
  if (pos < 0) return text.slice(0, width) + '…';
  const start = Math.max(0, pos - Math.floor(width / 3));
  const end = Math.min(text.length, start + width);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

interface RawRow {
  message_id: number;
  session_id: string;
  title: string;
  role: string;
  content_json: string;
  created_at: string;
}

function rowToHit(row: RawRow, score: number, via: SearchHit['via'], query: string): SearchHit {
  const content = (JSON.parse(row.content_json) as { content?: string }).content ?? '';
  return {
    messageId: row.message_id,
    sessionId: row.session_id,
    sessionTitle: row.title,
    role: row.role,
    content,
    snippet: makeSnippet(content, query),
    at: row.created_at,
    score,
    via,
  };
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

export class SearchStore {
  private embedder: EmbeddingClient | undefined;
  private embedFailed = false;

  constructor(
    private readonly db: import('better-sqlite3').Database,
    private readonly embedderFactory?: EmbedderFactory,
  ) {}

  // ── 全文索引维护 ──────────────────────────────────────────────────────────

  /** 单条消息入 FTS 索引（非 user/assistant 角色占位空行，避免回填重复尝试）。 */
  indexMessage(messageId: number, sessionId: string, role: string, content: string): void {
    const text = role === 'user' || role === 'assistant'
      ? (content ?? '').slice(0, FTS_INDEX_MAX_CHARS)
      : '';
    const fts = ftsTokenize(text).join(' ');
    this.db
      .prepare('INSERT OR REPLACE INTO messages_fts (rowid, text, session_id, role) VALUES (?, ?, ?, ?)')
      .run(messageId, fts, sessionId, role);
  }

  /** 存量消息懒回填：messages 有而 fts 缺的行补索引（幂等，事务批量）。 */
  ensureIndexed(): void {
    const missing = this.db
      .prepare(
        `SELECT m.id, m.session_id, m.role, m.content_json
         FROM messages m WHERE m.id NOT IN (SELECT rowid FROM messages_fts)
         ORDER BY m.id ASC`,
      )
      .all() as Array<{ id: number; session_id: string; role: string; content_json: string }>;
    if (missing.length === 0) return;
    const insert = this.db.prepare(
      'INSERT INTO messages_fts (rowid, text, session_id, role) VALUES (?, ?, ?, ?)',
    );
    const tx = this.db.transaction((rows: typeof missing) => {
      for (const r of rows) {
        const content = r.role === 'user' || r.role === 'assistant'
          ? (JSON.parse(r.content_json) as { content?: string }).content ?? ''
          : '';
        insert.run(r.id, ftsTokenize(content.slice(0, FTS_INDEX_MAX_CHARS)).join(' '), r.session_id, r.role);
      }
    });
    tx(missing);
  }

  /** 删除一批会话的全文索引与向量（硬删除级联调用）。 */
  removeSessionData(sessionIds: string[]): void {
    if (sessionIds.length === 0) return;
    const delFts = this.db.prepare('DELETE FROM messages_fts WHERE session_id = ?');
    const delVec = this.db.prepare(
      `DELETE FROM message_embeddings WHERE message_id NOT IN (SELECT id FROM messages)`,
    );
    const tx = this.db.transaction(() => {
      for (const id of sessionIds) delFts.run(id);
      delVec.run();
    });
    tx();
  }

  // ── 检索主入口 ────────────────────────────────────────────────────────────

  async search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const mode = opts.mode ?? 'auto';

    this.ensureIndexed();

    let ftsList: Array<{ id: number; hit: SearchHit }> = [];
    let semList: Array<{ id: number; hit: SearchHit }> = [];

    if (mode !== 'semantic') {
      ftsList = this.searchFulltext(q, limit);
    }
    if (mode !== 'fulltext') {
      semList = await this.searchSemantic(q, limit);
    }

    // 单路模式直接返回
    if (mode === 'fulltext') return ftsList.map((x) => x.hit);
    if (mode === 'semantic') return semList.map((x) => x.hit);

    // RRF 融合
    const scores = new Map<number, { score: number; sources: Set<'fulltext' | 'semantic'>; hit: SearchHit }>();
    const bump = (list: Array<{ id: number; hit: SearchHit }>, src: 'fulltext' | 'semantic') => {
      list.forEach((item, rank) => {
        let entry = scores.get(item.id);
        if (!entry) {
          entry = { score: 0, sources: new Set(), hit: item.hit };
          scores.set(item.id, entry);
        }
        entry.score += 1 / (RRF_K + rank + 1);
        entry.sources.add(src);
      });
    };
    bump(ftsList, 'fulltext');
    bump(semList, 'semantic');

    return [...scores.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limit)
      .map(([, entry]) => {
        const via = entry.sources.size > 1 ? 'hybrid' : [...entry.sources][0]!;
        return { ...entry.hit, score: entry.score, via };
      });
  }

  /** 语义检索是否可用（embedder 已解析且未失败）——CLI/Web 提示降级用。 */
  get semanticAvailable(): boolean {
    return !this.embedFailed && this.getEmbedder() !== undefined;
  }

  private searchFulltext(query: string, limit: number): Array<{ id: number; hit: SearchHit }> {
    const match = buildFtsQuery(query);
    if (!match) return [];
    const rows = this.db
      .prepare(
        `SELECT f.rowid AS message_id, m.session_id, s.title, m.role, m.content_json, m.created_at,
                bm25(messages_fts) AS rank
         FROM messages_fts f
         JOIN messages m ON m.id = f.rowid
         JOIN sessions s ON s.id = m.session_id AND s.deleted_at IS NULL
         WHERE messages_fts MATCH ?
         ORDER BY rank ASC
         LIMIT ?`,
      )
      .all(match, limit) as Array<RawRow & { rank: number }>;
    return rows.map((r) => ({
      id: r.message_id,
      // bm25 越小越相关 → 取负转正便于展示
      hit: rowToHit(r, Math.max(0, -r.rank), 'fulltext', query),
    }));
  }

  // ── 语义检索 ──────────────────────────────────────────────────────────────

  private getEmbedder(): EmbeddingClient | undefined {
    if (this.embedFailed) return undefined;
    if (!this.embedder && this.embedderFactory) {
      try {
        this.embedder = this.embedderFactory();
      } catch {
        this.embedder = undefined;
      }
    }
    return this.embedder;
  }

  /** 确保向量就绪：模型切换清空重建、缺失消息批量补嵌入。返回可用 embedder。 */
  private async ensureEmbedded(): Promise<EmbeddingClient | undefined> {
    const emb = this.getEmbedder();
    if (!emb) return undefined;

    const stored = this.db.prepare('SELECT model FROM message_embeddings LIMIT 1').get() as
      | { model: string }
      | undefined;
    if (stored && stored.model !== emb.model) {
      this.db.prepare('DELETE FROM message_embeddings').run();
    }

    const missing = this.db
      .prepare(
        `SELECT m.id, m.content_json FROM messages m
         JOIN sessions s ON s.id = m.session_id AND s.deleted_at IS NULL
         WHERE m.role IN ('user', 'assistant')
           AND m.id NOT IN (SELECT message_id FROM message_embeddings)
         ORDER BY m.id DESC
         LIMIT ?`,
      )
      .all(EMBED_BACKFILL_MAX) as Array<{ id: number; content_json: string }>;
    if (missing.length === 0) return emb;

    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO message_embeddings (message_id, model, dim, vec) VALUES (?, ?, ?, ?)',
    );
    for (let i = 0; i < missing.length; i += EMBED_BATCH) {
      const batch = missing.slice(i, i + EMBED_BATCH);
      try {
        const texts = batch.map((r) =>
          ((JSON.parse(r.content_json) as { content?: string }).content ?? '').slice(0, EMBED_MAX_CHARS),
        );
        const vectors = await emb.embed(texts);
        const tx = this.db.transaction(() => {
          batch.forEach((r, j) => {
            const vec = vectors[j];
            if (!vec) return;
            insert.run(r.id, emb.model, vec.length, Buffer.from(new Float32Array(vec).buffer));
          });
        });
        tx();
      } catch {
        // embedding 不可用（网络/配额）→ 本进程内降级为纯全文
        this.embedFailed = true;
        return undefined;
      }
    }
    return emb;
  }

  private async searchSemantic(query: string, limit: number): Promise<Array<{ id: number; hit: SearchHit }>> {
    const emb = await this.ensureEmbedded();
    if (!emb) return [];

    let qvec: number[][];
    try {
      qvec = await emb.embed([query.slice(0, EMBED_MAX_CHARS)]);
    } catch {
      this.embedFailed = true;
      return [];
    }
    const q = new Float32Array(qvec[0] ?? []);
    if (q.length === 0) return [];

    const rows = this.db
      .prepare(
        `SELECT e.message_id, e.vec, m.session_id, s.title, m.role, m.content_json, m.created_at
         FROM message_embeddings e
         JOIN messages m ON m.id = e.message_id
         JOIN sessions s ON s.id = m.session_id AND s.deleted_at IS NULL
         WHERE e.model = ?`,
      )
      .all(emb.model) as Array<RawRow & { vec: Buffer }>;

    const scored = rows
      .map((r) => {
        const vec = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4);
        return { row: r, sim: vec.length === q.length ? cosine(q, vec) : 0 };
      })
      .filter((x) => x.sim > 0.3)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, limit);
    return scored.map((x) => ({ id: x.row.message_id, hit: rowToHit(x.row, x.sim, 'semantic', query) }));
  }
}

export function formatSearchHits(hits: SearchHit[], query: string): string {
  if (hits.length === 0) return `未检索到与「${query}」相关的历史对话`;
  const viaLabel: Record<SearchHit['via'], string> = {
    fulltext: '全文',
    semantic: '语义',
    hybrid: '混合',
  };
  return [
    `检索「${query}」命中 ${hits.length} 条：`,
    ...hits.map((h, i) => {
      const d = new Date(h.at).toLocaleString('zh-CN');
      const head = `${i + 1}. [${viaLabel[h.via]}] ${h.sessionTitle} · ${h.role} · ${d}`;
      return `${head}\n   ${h.snippet}`;
    }),
  ].join('\n');
}
