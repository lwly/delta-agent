/**
 * F-31 成本与用量报告测试：
 * - v3 迁移三路径（空库 / v2 历史库回填 / 重复打开幂等）
 * - recordUsage 写入（model + ISO created_at）
 * - UsageStore 聚合（多项目/多模型/时间边界/软删除口径/孤儿行/空数据）
 * - HTTP API（summary/sessions、非法 range 回显、项目过滤）
 * - hub 逐轮落库回归（D5）
 */
import { describe, expect, it, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import type { ChatMessage, ChatRequest, LLMProvider, StreamEvent, ToolCall } from '@delta/shared';
import {
  SessionService,
  SessionHub,
  createWebServer,
  ToolRegistry,
  rangeCutoff,
} from '../src/index.js';
import { MIGRATIONS, LATEST_SCHEMA_VERSION } from '../src/session/migrations.js';
import { UsageStore, normalizeRange } from '../src/session/usage.js';

const dirs: string[] = [];
async function tmpFile(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-usage-'));
  dirs.push(dir);
  return path.join(dir, name);
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

function usageColumns(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info('usage')").all() as Array<{ name: string }>).map((c) => c.name);
}

const DAY = 86_400_000;

/** 直接写入一条带指定时间/模型的 usage 行（绕过 recordUsage 的 now 时间戳）。 */
function insertUsage(
  db: Database.Database,
  sessionId: string,
  turn: number,
  input: number,
  output: number,
  cost: number,
  model: string,
  createdAt: string,
): void {
  db.prepare(
    'INSERT INTO usage (session_id, turn, input_tokens, output_tokens, cost_usd, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(sessionId, turn, input, output, cost, model, createdAt);
}

// ── v3 迁移三路径 ──────────────────────────────────────────────────────────

describe('v3 迁移（F-31 usage 补 model/created_at）', () => {
  it('空库：直接建到最新版本，新列与索引齐备', async () => {
    const file = await tmpFile('fresh.db');
    const svc = new SessionService(file);
    try {
      expect(svc.store.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
      // F-37 起版本升到 4（v4 = worktree 绑定列；本组断言 v3 列仍齐备）
      expect(LATEST_SCHEMA_VERSION).toBe(5);
      const cols = usageColumns(svc.store.db);
      expect(cols).toContain('model');
      expect(cols).toContain('created_at');
      const objects = (
        svc.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(objects).toContain('idx_usage_created_at');
    } finally {
      svc.close();
    }
  });

  it('v2 历史库：自动升级并回填 model/created_at（孤儿行兜底不报错）', async () => {
    const file = await tmpFile('legacy.db');
    {
      const db = new Database(file);
      db.pragma('journal_mode = WAL');
      db.exec(MIGRATIONS[0]!.sql);
      db.exec(MIGRATIONS[1]!.sql);
      db.pragma('user_version = 2');
      db.prepare("INSERT INTO projects (id, name, root_path, created_at) VALUES ('p-legacy', 'legacy', '/tmp/legacy', '2026-01-01T00:00:00.000Z')").run();
      db.prepare(
        "INSERT INTO sessions (id, project_id, title, mode, model, status, created_at, updated_at) VALUES ('s-legacy', 'p-legacy', '旧会话', 'react', 'legacy-model', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
      ).run();
      // v2 时代的 usage 表：无 model/created_at 列
      db.prepare("INSERT INTO usage (session_id, turn, input_tokens, output_tokens, cost_usd) VALUES ('s-legacy', 1, 100, 50, 0.1)").run();
      db.prepare("INSERT INTO usage (session_id, turn, input_tokens, output_tokens, cost_usd) VALUES ('s-legacy', 2, 200, 80, 0.2)").run();
      // 孤儿行（session 已物理消失）：COALESCE 兜底，不阻塞迁移
      db.prepare("INSERT INTO usage (session_id, turn, input_tokens, output_tokens, cost_usd) VALUES ('s-gone', 1, 10, 5, 0.01)").run();
      db.close();
    }
    const svc = new SessionService(file);
    try {
      // v3 之后追加了 v4（F-37 worktree 绑定），升级落点为最新版本
      expect(svc.store.schemaVersion).toBe(5);
      const rows = svc.store.db
        .prepare('SELECT session_id, turn, model, created_at FROM usage ORDER BY session_id, turn')
        .all() as Array<{ session_id: string; turn: number; model: string; created_at: string | null }>;
      const legacy = rows.filter((r) => r.session_id === 's-legacy');
      expect(legacy).toHaveLength(2);
      for (const r of legacy) {
        expect(r.model).toBe('legacy-model'); // 回填自 sessions.model
        expect(r.created_at).toBe('2026-01-01T00:00:00.000Z'); // 回填自 sessions.created_at
      }
      const orphan = rows.find((r) => r.session_id === 's-gone')!;
      expect(orphan.model).toBe('');
      expect(orphan.created_at).toBeNull();
      // 回填后历史用量可按模型/时间聚合
      const report = svc.usage.summary();
      expect(report.totals.turns).toBe(3);
      const m = report.byModel.find((r) => r.model === 'legacy-model')!;
      expect(m.turns).toBe(2);
      expect(m.cost_usd).toBeCloseTo(0.3);
      const unknown = report.byProject.find((r) => r.project_id === null)!;
      expect(unknown.project_name).toBe('（未知项目）');
      expect(unknown.turns).toBe(1);
    } finally {
      svc.close();
    }
  });

  it('重复打开：幂等，回填结果不漂移', async () => {
    const file = await tmpFile('idem.db');
    const seed = () => {
      const svc = new SessionService(file);
      const pid = svc.ensureProject('/tmp/idem').id;
      const sid = svc.createSession(pid, { title: '幂等', model: 'm-idem' }).id;
      svc.recordUsage(sid, 1, 10, 5, 0.01, 'm-idem');
      svc.close();
    };
    seed();
    const svc1 = new SessionService(file);
    const before = svc1.usage.summary();
    svc1.close();
    const svc2 = new SessionService(file);
    try {
      expect(svc2.store.schemaVersion).toBe(5);
      const after = svc2.usage.summary();
      expect(after.totals).toEqual(before.totals);
      expect(after.byModel.map((r) => r.model)).toEqual(before.byModel.map((r) => r.model));
    } finally {
      svc2.close();
    }
  });
});

// ── recordUsage 写入 ───────────────────────────────────────────────────────

describe('recordUsage 写入（model + created_at）', () => {
  it('写入模型与 ISO 时间戳；缺省 model 为空串', async () => {
    const file = await tmpFile('write.db');
    const svc = new SessionService(file);
    try {
      const pid = svc.ensureProject('/tmp/write').id;
      const sid = svc.createSession(pid, { title: '写入' }).id;
      svc.recordUsage(sid, 1, 100, 50, 0.1, 'claude-sonnet-4-5');
      svc.recordUsage(sid, 2, 60, 30, 0.05);
      const rows = svc.store.db
        .prepare('SELECT turn, model, created_at FROM usage ORDER BY turn')
        .all() as Array<{ turn: number; model: string; created_at: string }>;
      expect(rows[0]).toMatchObject({ turn: 1, model: 'claude-sonnet-4-5' });
      expect(rows[1]!.model).toBe('');
      for (const r of rows) expect(r.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      svc.close();
    }
  });
});

// ── UsageStore 聚合 ────────────────────────────────────────────────────────

describe('UsageStore 聚合', () => {
  /** 构造多项目/多模型/跨时间数据集，返回 (service, db)。 */
  async function seed(): Promise<{ svc: SessionService; pidA: string; pidB: string; db: Database.Database }> {
    const file = await tmpFile('agg.db');
    const svc = new SessionService(file);
    const pidA = svc.ensureProject('/tmp/agg-a').id;
    const pidB = svc.ensureProject('/tmp/agg-b').id;
    const sA1 = svc.createSession(pidA, { title: 'A1', model: 'm1' }).id;
    const sA2 = svc.createSession(pidA, { title: 'A2', model: 'm2' }).id;
    const sB1 = svc.createSession(pidB, { title: 'B1', model: 'm1' }).id;
    const db = svc.store.db;
    const now = new Date();
    insertUsage(db, sA1, 1, 100, 50, 0.1, 'm1', now.toISOString()); // 今/7d/30d/all
    insertUsage(db, sA1, 2, 200, 100, 0.2, 'm1', new Date(now.getTime() - 3 * DAY).toISOString()); // 7d/30d/all
    insertUsage(db, sA1, 3, 400, 200, 0.4, 'm1', new Date(now.getTime() - 10 * DAY).toISOString()); // 30d/all
    insertUsage(db, sA1, 4, 800, 400, 0.8, 'm1', new Date(now.getTime() - 40 * DAY).toISOString()); // all
    insertUsage(db, sA2, 1, 10, 5, 0.01, 'm2', now.toISOString());
    insertUsage(db, sB1, 1, 1000, 500, 1.0, 'm1', now.toISOString());
    svc.removeSession(sB1); // 软删除：费用计入汇总，明细不列
    return { svc, pidA, pidB, db };
  }

  it('all：总计与逐行手算一致（含软删除会话费用，D8）', async () => {
    const { svc } = await seed();
    try {
      const r = svc.usage.summary({ range: 'all' });
      expect(r.range).toBe('all');
      expect(r.totals.input_tokens).toBe(100 + 200 + 400 + 800 + 10 + 1000);
      expect(r.totals.output_tokens).toBe(50 + 100 + 200 + 400 + 5 + 500);
      expect(r.totals.cost_usd).toBeCloseTo(0.1 + 0.2 + 0.4 + 0.8 + 0.01 + 1.0);
      expect(r.totals.turns).toBe(6);
      expect(r.totals.sessions).toBe(3); // 含软删除会话
    } finally {
      svc.close();
    }
  });

  it('时间范围过滤：today/7d/30d 边界正确', async () => {
    const { svc } = await seed();
    try {
      const today = svc.usage.summary({ range: 'today' });
      expect(today.totals.input_tokens).toBe(100 + 10 + 1000);
      const d7 = svc.usage.summary({ range: '7d' });
      expect(d7.totals.input_tokens).toBe(100 + 200 + 10 + 1000);
      const d30 = svc.usage.summary({ range: '30d' });
      expect(d30.totals.input_tokens).toBe(100 + 200 + 400 + 10 + 1000);
    } finally {
      svc.close();
    }
  });

  it('today 边界：恰好本地 0 点的行计入（>= cutoff）', async () => {
    const file = await tmpFile('boundary.db');
    const svc = new SessionService(file);
    try {
      const pid = svc.ensureProject('/tmp/boundary').id;
      const sid = svc.createSession(pid, { title: '边界', model: 'm1' }).id;
      const cutoff = rangeCutoff('today')!;
      expect(cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      insertUsage(svc.store.db, sid, 1, 7, 7, 0.07, 'm1', cutoff); // 恰好落在 0 点
      const r = svc.usage.summary({ range: 'today' });
      expect(r.totals.turns).toBe(1);
      expect(r.totals.input_tokens).toBe(7);
    } finally {
      svc.close();
    }
  });

  it('项目过滤：byProject/bySession/totals 均收窄到目标项目', async () => {
    const { svc, pidA } = await seed();
    try {
      const r = svc.usage.summary({ range: 'all', projectId: pidA });
      expect(r.totals.input_tokens).toBe(100 + 200 + 400 + 800 + 10);
      expect(r.totals.sessions).toBe(2);
      expect(r.byProject).toHaveLength(1);
      expect(r.byProject[0]!.project_id).toBe(pidA);
      expect(r.byModel.map((m) => m.model).sort()).toEqual(['m1', 'm2']);
    } finally {
      svc.close();
    }
  });

  it('软删除口径：byProject 计入沉没成本；bySession 仅列活跃会话', async () => {
    const { svc } = await seed();
    try {
      const r = svc.usage.summary({ range: 'all' });
      const b = r.byProject.find((p) => p.project_name === 'agg-b')!;
      expect(b.cost_usd).toBeCloseTo(1.0); // 软删除会话费用计入
      const sessions = svc.usage.bySession({ range: 'all' });
      expect(sessions.map((s) => s.title).sort()).toEqual(['A1', 'A2']); // B1 不在明细
      expect(sessions[0]!.sessions).toBe(1);
    } finally {
      svc.close();
    }
  });

  it('孤儿 usage 行：totals 计入、byProject 归「未知项目」、bySession 排除', async () => {
    const { svc, db } = await seed();
    try {
      insertUsage(db, 's-orphan', 1, 33, 22, 0.33, 'm1', new Date().toISOString());
      const r = svc.usage.summary({ range: 'all' });
      expect(r.totals.turns).toBe(7);
      expect(r.byProject.find((p) => p.project_id === null)!.cost_usd).toBeCloseTo(0.33);
      expect(svc.usage.bySession().some((s) => s.session_id === 's-orphan')).toBe(false);
    } finally {
      svc.close();
    }
  });

  it('空数据：返回零值结构而非报错', async () => {
    const file = await tmpFile('empty.db');
    const svc = new SessionService(file);
    try {
      const r = svc.usage.summary();
      expect(r.range).toBe('all');
      expect(r.totals).toEqual({ input_tokens: 0, output_tokens: 0, cost_usd: 0, turns: 0, sessions: 0 });
      expect(r.byProject).toEqual([]);
      expect(r.byModel).toEqual([]);
      expect(svc.usage.bySession()).toEqual([]);
    } finally {
      svc.close();
    }
  });

  it('normalizeRange：非法值归一化为 all', () => {
    expect(normalizeRange('today')).toBe('today');
    expect(normalizeRange('7d')).toBe('7d');
    expect(normalizeRange('30d')).toBe('30d');
    expect(normalizeRange('all')).toBe('all');
    expect(normalizeRange('bogus')).toBe('all');
    expect(normalizeRange(null)).toBe('all');
    expect(normalizeRange(undefined)).toBe('all');
  });
});

// ── HTTP API ───────────────────────────────────────────────────────────────

describe('usage HTTP API', () => {
  let svc: SessionService;
  let server: ReturnType<typeof createWebServer>;
  let base = '';
  let pid: string;
  let sid: string;

  const api = async (p: string) => {
    const res = await fetch(`${base}${p}`);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  async function setup(): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-usage-api-'));
    dirs.push(dir);
    svc = new SessionService(path.join(dir, 'db.sqlite'));
    pid = svc.ensureProject(dir).id;
    sid = svc.createSession(pid, { title: 'api 会话', model: 'api-model' }).id;
    insertUsage(svc.store.db, sid, 1, 100, 50, 0.1, 'api-model', new Date().toISOString());
    const hub = new SessionHub({
      service: svc,
      registry: new ToolRegistry(),
      resolveProvider: async () => {
        throw new Error('no provider');
      },
    });
    server = createWebServer({ service: svc, hub, port: 0 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  }

  function teardown(): void {
    server?.close();
    svc?.close();
  }

  it('GET /api/usage/summary：结构完整且项目过滤生效', async () => {
    await setup();
    try {
      const r = await api(`/api/usage/summary?range=all&project=${pid}`);
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({
        range: 'all',
        project: pid,
        totals: { input_tokens: 100, output_tokens: 50, cost_usd: 0.1, turns: 1, sessions: 1 },
      });
      expect((r.json.by_project as Array<Record<string, unknown>>)[0]).toMatchObject({
        project_id: pid,
      });
      expect(typeof (r.json.by_project as Array<Record<string, unknown>>)[0]!.project_name).toBe('string');
      expect((r.json.by_model as Array<Record<string, unknown>>)[0]).toMatchObject({ model: 'api-model', turns: 1 });
    } finally {
      teardown();
    }
  });

  it('非法 range 归一化 all 并回显；未知项目过滤得零值结构', async () => {
    await setup();
    try {
      const bogus = await api('/api/usage/summary?range=bogus');
      expect(bogus.json.range).toBe('all');
      const miss = await api('/api/usage/summary?range=today&project=no-such-project');
      expect(miss.json.range).toBe('today');
      expect(miss.json.project).toBe('no-such-project');
      expect(miss.json.totals).toMatchObject({ input_tokens: 0, turns: 0, sessions: 0 });
      const sessions = await api('/api/usage/sessions?range=nonsense');
      expect(sessions.json.range).toBe('all');
      expect(Array.isArray(sessions.json.items)).toBe(true);
    } finally {
      teardown();
    }
  });

  it('GET /api/usage/sessions：逐会话明细（snake_case，与 CLI 同构）', async () => {
    await setup();
    try {
      const r = await api('/api/usage/sessions?range=all');
      expect(r.status).toBe(200);
      const items = r.json.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        session_id: sid,
        project_id: pid,
        title: 'api 会话',
        model: 'api-model',
        input_tokens: 100,
        output_tokens: 50,
        cost_usd: 0.1,
        turns: 1,
        sessions: 1,
      });
    } finally {
      teardown();
    }
  });
});

// ── hub 逐轮落库（D5 回归）────────────────────────────────────────────────

/** Scripted mock provider（与 server.test 同思路）。 */
class MockProvider implements LLMProvider {
  readonly id = 'mock';
  constructor(private script: Array<{ text?: string; toolCalls?: ToolCall[] }>) {}
  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    void req;
    const next = this.script.shift();
    if (!next) {
      yield { type: 'error', message: 'mock exhausted', retriable: false };
      return;
    }
    if (next.text) {
      for (const chunk of next.text.match(/.{1,4}/gs) ?? []) {
        yield { type: 'text_delta', text: chunk };
      }
    }
    for (const [i, c] of (next.toolCalls ?? []).entries()) {
      yield { type: 'tool_call_delta', index: i, id: c.id, name: c.name, argsDelta: c.argsJson };
    }
    yield { type: 'usage', input: 20, output: 8 };
    yield { type: 'done' };
  }
  estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((n, m) => n + m.content.length, 0);
  }
}

describe('hub 逐轮落库（D5：替代 done 一次性 turn=0）', () => {
  it('两轮任务落 2 行 usage（turn 1/2），model 来自引擎 usage 事件', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-usage-hub-'));
    dirs.push(dir);
    await fs.writeFile(path.join(dir, 'note.txt'), 'hello');
    const svc = new SessionService(path.join(dir, 'db.sqlite'));
    try {
      const pid = svc.ensureProject(dir).id;
      const sid = svc.createSession(pid, { title: 'hub 逐轮' }).id; // 无 model → 默认模型兜底
      const provider = new MockProvider([
        { toolCalls: [{ id: 'c1', name: 'read_file', argsJson: JSON.stringify({ path: 'note.txt' }) }] },
        { text: '完成' },
      ]);
      const hub = new SessionHub({ service: svc, registry: new ToolRegistry(), resolveProvider: async () => provider });
      await hub.send(sid, '读一下 note.txt');

      const rows = svc.store.db
        .prepare('SELECT turn, input_tokens, output_tokens, cost_usd, model, created_at FROM usage ORDER BY turn')
        .all() as Array<{ turn: number; input_tokens: number; output_tokens: number; cost_usd: number; model: string; created_at: string }>;
      // 逐轮：两轮各一行（替代旧行为的 done 一次性 turn=0 整轮行）
      expect(rows.map((r) => r.turn)).toEqual([1, 2]);
      for (const r of rows) {
        expect(r.input_tokens).toBe(20);
        expect(r.output_tokens).toBe(8);
        expect(r.model).toBe('claude-sonnet-4-5-20250929'); // ev.model ?? ctx.model 兜底链
        expect(r.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
      const report = svc.usage.summary();
      expect(report.totals.turns).toBe(2);
      expect(report.totals.sessions).toBe(1);
    } finally {
      svc.close();
    }
  });
});
