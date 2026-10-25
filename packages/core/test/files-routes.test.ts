/**
 * F-38 HTTP 只读路由契约测试（不依赖 SQLite / 不依赖 git init）
 *
 * 为什么单独一份：工程师的 `files-api.test.ts` 通过 `SessionService` 起真服务，
 * 本机 sqlite 不可用（WAL 需要删除 -journal，被安全守卫拦截）→ 那套用例跑不了。
 * 这里改为直接调用 `handleBrowseRoute`，用**结构化假 service** 替代 SessionService，
 * 因此可在任何环境跑；git 相关断言（diff 行号）用真实仓库守卫跳过。
 *
 * 断言基准：docs/design-f38-project-file-panel.md §4（契约）/ §4.6（错误码）/ §6（安全边界）
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import type * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import {
  handleBrowseRoute,
  type BrowseRouteInput,
  type BrowseRouteOutcome,
} from '../src/server/browse-routes.js';
import type { SessionRow, ProjectRow } from '../src/session/store.js';
import type { SessionService } from '../src/session/service.js';

// ── 假 service（结构性替代，绝不实例化 SessionService）─────────────────────

interface FakeServiceOptions {
  sessions?: SessionRow[];
  projects?: ProjectRow[];
}

function fakeService(opts: FakeServiceOptions): SessionService {
  const sessions = new Map((opts.sessions ?? []).map((s) => [s.id, s]));
  const projects = new Map((opts.projects ?? []).map((p) => [p.id, p]));
  return {
    getSession: (id: string) => sessions.get(id) ?? null,
    getProject: (id: string) => projects.get(id) ?? null,
  } as unknown as SessionService;
}

function makeSession(id: string, projectId: string, worktreePath: string | null = null): SessionRow {
  return {
    id,
    project_id: projectId,
    title: `t-${id}`,
    mode: 'auto',
    model: 'claude-sonnet-4.5',
    status: 'idle',
    created_at: '2026-10-24T00:00:00.000Z',
    updated_at: '2026-10-24T00:00:00.000Z',
    worktree_path: worktreePath,
    worktree_branch: worktreePath ? 'feature/x' : null,
  };
}

function makeProject(id: string, rootPath: string): ProjectRow {
  return {
    id,
    name: path.basename(rootPath),
    root_path: rootPath,
    created_at: '2026-10-24T00:00:00.000Z',
    session_count: 0,
  };
}

// ── 调用助手 ───────────────────────────────────────────────────────────────

type RouteFn = typeof handleBrowseRoute;

const SID = 'sess-1';
const PID = 'proj-1';

function reqWithBody(body?: unknown): http.IncomingMessage {
  const payload = body === undefined ? [] : [JSON.stringify(body)];
  return Readable.from(payload) as unknown as http.IncomingMessage;
}

/** 构造并调用一次路由（path 段由 scope 与 action 决定）。 */
async function call(opts: {
  service: SessionService;
  family?: 'sessions' | 'projects';
  id?: string;
  action: string;
  method?: string;
  query?: Record<string, string>;
  body?: unknown;
  reveal?: (abs: string, isDir: boolean) => void;
  parts?: string[];
  /** 原样拼接到 URL 的查询串（用于复现客户端送来的百分号编码，如 `path=..%2F..%2Fetc`） */
  rawQuery?: string;
}): Promise<BrowseRouteOutcome | null> {
  const family = opts.family ?? 'sessions';
  const id = opts.id ?? (family === 'sessions' ? SID : PID);
  const parts = opts.parts ?? ['api', family, id, 'browse', opts.action];
  // 注意：用 URLSearchParams 会二次编码 '%'（'..%2F' → '..%252F'），无法复现真实客户端请求，
  // 故 rawQuery 原样拼接。
  const search = opts.rawQuery ?? new URLSearchParams(opts.query ?? {}).toString();
  const url = new URL(`http://localhost/${parts.join('/')}${search ? `?${search}` : ''}`);
  const input: BrowseRouteInput = {
    method: opts.method ?? (opts.action === 'reveal' ? 'POST' : 'GET'),
    parts,
    url,
    req: reqWithBody(opts.body),
    service: opts.service,
    browseDeps: opts.reveal ? { reveal: opts.reveal } : {},
  };
  return handleBrowseRoute(input);
}

/** 断言 200 并返回 body（窄化类型后仍保留原始对象用于键集合断言）。 */
function expectOk(out: BrowseRouteOutcome | null): Record<string, unknown> {
  expect(out).not.toBeNull();
  const o = out as BrowseRouteOutcome;
  expect(o.status).toBe(200);
  expect(o.body).toBeTypeOf('object');
  return o.body as Record<string, unknown>;
}

function expectError(out: BrowseRouteOutcome | null, status: number): Record<string, unknown> {
  expect(out).not.toBeNull();
  const o = out as BrowseRouteOutcome;
  expect(o.status).toBe(status);
  const body = o.body as Record<string, unknown>;
  expect(body).toHaveProperty('error');
  expect(typeof body.error).toBe('string');
  return body;
}

/** 错误体绝不可回显根绝对路径（PRD §6 / design §4.6）。 */
function expectNoAbsolutePath(body: Record<string, unknown>, roots: string[]): void {
  const serialized = JSON.stringify(body);
  for (const root of roots) {
    expect(serialized).not.toContain(root);
  }
  expect(serialized).not.toContain(os.tmpdir());
}

// ── 夹具 ───────────────────────────────────────────────────────────────────

let root = ''; // 项目根
let worktree = ''; // 存活的 worktree 目录
let outside = ''; // 根外目录（符号链接逃逸目标）
let plain = ''; // 非 git 空目录

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-f38r-root-'));
  worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-f38r-wt-'));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-f38r-out-'));
  plain = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-f38r-plain-'));

  // 根内内容
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'a.md'), '# 标题\n\n正文\n');
  await fs.writeFile(path.join(root, 'B.ts'), 'export const b = 1;\n');
  await fs.writeFile(path.join(root, 'logo.png'), PNG_BYTES);
  await fs.writeFile(path.join(root, 'blob.bin'), Buffer.from([0x41, 0x00, 0x42, 0x43]));
  await fs.writeFile(path.join(root, 'big.txt'), 'x'.repeat(1_000_001));

  // worktree 内独有文件（用于区分根口径）
  await fs.writeFile(path.join(worktree, 'FROM_WORKTREE.md'), '# worktree\n');
  // 根外机密
  await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret');
  // 符号链接：逃逸目录 + 根内文件
  await fs.symlink(outside, path.join(root, 'escape'));
  await fs.symlink(path.join(root, 'B.ts'), path.join(root, 'inner-link'));
});

afterEach(async () => {
  // 受限环境会拒绝删除临时目录，残留无害（不参与断言）
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(worktree, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(outside, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(plain, { recursive: true, force: true }).catch(() => undefined);
});

function sessionService(sessionWorktree: string | null = null): SessionService {
  return fakeService({
    sessions: [makeSession(SID, PID, sessionWorktree)],
    projects: [makeProject(PID, root)],
  });
}

// ══════════════════════════════════════════════════════════════════════════
// B1 两套作用域 + worktree 根口径
// ══════════════════════════════════════════════════════════════════════════

describe('B1 作用域与工作根（session 走 resolveWorkRoot / project 走 root_path）', () => {
  it('session 作用域命中：parts=[api,sessions,sid,browse,tree] → 200', async () => {
    const body = expectOk(
      await call({
        service: sessionService(),
        family: 'sessions',
        action: 'tree',
        query: { path: '' },
      }),
    );
    expect(body.root_name).toBe(path.basename(root));
    const names = (body.entries as Array<{ name: string }>).map((e) => e.name);
    expect(names).toContain('docs');
  });

  it('project 作用域命中：parts=[api,projects,pid,browse,tree] → 200 且根一致', async () => {
    const body = expectOk(
      await call({
        service: sessionService(),
        family: 'projects',
        action: 'tree',
        query: { path: 'docs' },
      }),
    );
    expect(body.path).toBe('docs');
    expect(body.root_name).toBe(path.basename(root));
  });

  it('session 有存活 worktree_path → 根切到 worktree 目录（不是项目根）', async () => {
    const body = expectOk(
      await call({
        service: sessionService(worktree),
        family: 'sessions',
        action: 'tree',
        query: { path: '' },
      }),
    );
    expect(body.root_name).toBe(path.basename(worktree));
    const names = (body.entries as Array<{ name: string }>).map((e) => e.name);
    expect(names).toContain('FROM_WORKTREE.md');
    expect(names).not.toContain('docs'); // 项目根的内容不该出现
  });

  it('worktree_path 目录已不存在 → 回落 project.root_path（resolveWorkRoot 语义）', async () => {
    const gone = path.join(os.tmpdir(), `yz-f38r-gone-${Date.now()}-${Math.random()}`);
    expect(existsSync(gone)).toBe(false);
    const body = expectOk(
      await call({
        service: sessionService(gone),
        family: 'sessions',
        action: 'tree',
        query: { path: '' },
      }),
    );
    expect(body.root_name).toBe(path.basename(root));
    const names = (body.entries as Array<{ name: string }>).map((e) => e.name);
    expect(names).toContain('docs');
    expect(names).not.toContain('FROM_WORKTREE.md');
  });

  it('session 不存在 → 404 session not found；project 不在 → 404 project not found', async () => {
    const svc = sessionService();
    const b1 = expectError(
      await call({ service: svc, family: 'sessions', id: 'nope', action: 'tree', query: {} }),
      404,
    );
    expect(b1.error).toBe('session not found');

    const orphan = fakeService({ sessions: [makeSession(SID, 'missing-project')] });
    const b2 = expectError(await call({ service: orphan, family: 'sessions', action: 'tree' }), 404);
    expect(b2.error).toBe('project not found');

    const b3 = expectError(
      await call({ service: svc, family: 'projects', id: 'nope', action: 'tree' }),
      404,
    );
    expect(b3.error).toBe('project not found');
  });

  it('非 browse 子路径 / 段数不对 / 作用域族不认识 → 返回 null（交回 http.ts 后续分发）', async () => {
    const svc = sessionService();
    const cases: Array<Promise<BrowseRouteOutcome | null>> = [
      call({ service: svc, action: 'tree', parts: ['api', 'sessions', SID, 'files', 'tree'] }),
      call({ service: svc, action: 'tree', parts: ['api', 'sessions', SID, 'browse'] }),
      call({ service: svc, action: 'tree', parts: ['api', 'sessions', SID, 'browse', 'tree', 'x'] }),
      call({ service: svc, action: 'tree', parts: ['api', 'hubs', SID, 'browse', 'tree'] }),
      call({ service: svc, action: 'nope', parts: ['api', 'sessions', SID, 'browse', 'nope'] }),
      call({ service: svc, action: 'tree', method: 'POST' }), // 方法不匹配也交回
    ];
    for (const c of cases) expect(await c).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// B2 契约逐字断言（design §4.1–§4.4）
// ══════════════════════════════════════════════════════════════════════════

describe('B2 响应契约（snake_case 字段集合逐字对齐 design §4）', () => {
  it('tree：恰好 ok/path/root_name/entries/total/truncated；entry 形状合法', async () => {
    const body = expectOk(
      await call({ service: sessionService(), action: 'tree', query: { path: '' } }),
    );
    expect(Object.keys(body).sort()).toEqual(['entries', 'ok', 'path', 'root_name', 'total', 'truncated']);
    expect(body.ok).toBe(true);
    expect(body.path).toBe('');
    expect(body.truncated).toBe(false);

    const entries = body.entries as Array<{ name: string; type: string; size?: number }>;
    expect(Array.isArray(entries)).toBe(true);
    expect(body.total).toBe(entries.length); // 小目录无截断 → total = 条目数
    for (const e of entries) {
      expect(['dir', 'file']).toContain(e.type);
      expect(typeof e.name).toBe('string');
      if (e.type === 'file') expect(typeof e.size).toBe('number');
      if (e.type === 'dir') expect(e.size).toBeUndefined();
    }
    const docs = entries.find((e) => e.name === 'docs');
    expect(docs?.type).toBe('dir');
    const bigTxt = entries.find((e) => e.name === 'big.txt');
    expect(bigTxt?.size).toBe(1_000_001);
  });

  it('file（markdown）：kind=markdown + content + language=markdown + 元信息', async () => {
    const body = expectOk(
      await call({ service: sessionService(), action: 'file', query: { path: 'docs/a.md' } }),
    );
    expect(body.ok).toBe(true);
    expect(body.kind).toBe('markdown');
    expect(body.path).toBe('docs/a.md');
    expect(body.name).toBe('a.md');
    expect(body.language).toBe('markdown');
    expect(body.content).toBe('# 标题\n\n正文\n');
    expect(typeof body.size).toBe('number');
    expect(Number.isNaN(Date.parse(String(body.modified_at)))).toBe(false);
    // ISO 8601 往返一致
    expect(new Date(String(body.modified_at)).toISOString()).toBe(body.modified_at);
  });

  it('file（pNG）：kind=image + mime + data_url 以 data:image/png;base64, 开头且不含 content', async () => {
    const body = expectOk(
      await call({ service: sessionService(), action: 'file', query: { path: 'logo.png' } }),
    );
    expect(body.kind).toBe('image');
    expect(body.mime).toBe('image/png');
    expect(String(body.data_url).startsWith('data:image/png;base64,')).toBe(true);
    expect(body.content).toBeUndefined();
    expect(body.reason).toBeUndefined();
    // base64 可解回原字节（证明不是占位串）
    const b64 = String(body.data_url).slice('data:image/png;base64,'.length);
    expect(Buffer.from(b64, 'base64').equals(PNG_BYTES)).toBe(true);
  });

  it('file（>1MB）：kind=oversize + 中文 reason，且**没有** content/data_url', async () => {
    const body = expectOk(
      await call({ service: sessionService(), action: 'file', query: { path: 'big.txt' } }),
    );
    expect(body.kind).toBe('oversize');
    expect(body.size).toBe(1_000_001);
    expect(body.content).toBeUndefined();
    expect(body.data_url).toBeUndefined();
    expect(typeof body.reason).toBe('string');
    expect(String(body.reason)).toMatch(/1MB/);
  });

  it('file（含 NUL）：kind=binary + 中文 reason，且没有 content', async () => {
    const body = expectOk(
      await call({ service: sessionService(), action: 'file', query: { path: 'blob.bin' } }),
    );
    expect(body.kind).toBe('binary');
    expect(body.content).toBeUndefined();
    expect(String(body.reason)).toContain('二进制');
  });

  it('changes（非 git）：200 + 契约字段齐备 + is_repo:false + 中文 reason', async () => {
    const svc = fakeService({ projects: [makeProject(PID, plain)] });
    const body = expectOk(
      await call({ service: svc, family: 'projects', action: 'changes' }),
    );
    expect(body.ok).toBe(true);
    expect(body.is_repo).toBe(false);
    expect(Array.isArray(body.files)).toBe(true);
    expect(body.files).toEqual([]);
    expect(body.totals).toEqual({ added: 0, removed: 0 });
    expect(body.total_files).toBe(0);
    expect(body.truncated).toBe(false);
    expect(body.root_name).toBe(path.basename(plain));
    expect(typeof body.reason).toBe('string');
    // 中文 reason，且不是英文/空串（design §4.3 原文）
    expect(body.reason).toBe('当前目录不是 git 仓库，无法查看变更');
    const keys = Object.keys(body).sort();
    expect(keys).toEqual(
      ['files', 'is_repo', 'ok', 'reason', 'root_name', 'total_files', 'totals', 'truncated'].sort(),
    );
  });

  it('diff：path 缺省 → 400；语法非法 → 400（业务态不 500）', async () => {
    const svc = sessionService();
    const missing = expectError(await call({ service: svc, action: 'diff', query: {} }), 400);
    expect(missing.error).toBe('缺少 path 参数');

    const bad = expectError(
      await call({ service: svc, action: 'diff', query: { path: '../../etc/passwd' } }),
      400,
    );
    expectNoAbsolutePath(bad, [root]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// B3 安全边界（design §6）
// ══════════════════════════════════════════════════════════════════════════

describe('B3 安全：越界一律 400 且错误体不含根绝对路径', () => {
  /** 语法层越界（这些会被 normalizeRelPath 直接拒绝，无需真实文件存在） */
  const badPaths = ['../', '../../etc/passwd', '/etc/passwd', 'docs/../../etc'];

  it('tree：4 类语法越界路径全部 400', async () => {
    const svc = sessionService();
    for (const p of badPaths) {
      const body = expectError(await call({ service: svc, action: 'tree', query: { path: p } }), 400);
      expect(body.error).toBe('路径非法或超出根目录范围');
      expectNoAbsolutePath(body, [root]);
    }
  });

  it('tree：客户端百分号编码的 ..%2F..%2Fetc 解码后同样 400（原样复现线上请求）', async () => {
    const svc = sessionService();
    const body = expectError(
      await call({ service: svc, action: 'tree', rawQuery: 'path=..%2F..%2Fetc%2Fpasswd' }),
      400,
    );
    expect(body.error).toBe('路径非法或超出根目录范围');
    expectNoAbsolutePath(body, [root]);
  });

  it('file：越界路径同样 400（解码后 ../ 也拦住）', async () => {
    const svc = sessionService();
    for (const p of ['../etc/passwd', '/etc/passwd']) {
      const body = expectError(await call({ service: svc, action: 'file', query: { path: p } }), 400);
      expect(body.error).toBe('路径非法或超出根目录范围');
      expectNoAbsolutePath(body, [root]);
    }
    expectError(
      await call({ service: svc, action: 'file', rawQuery: 'path=..%2F..%2Fetc%2Fpasswd' }),
      400,
    );
  });

  it('根外符号链接：目录逃逸 / 根内文件链接 均 400，且树里不出现链接条目', async () => {
    const svc = sessionService();
    const tree = expectOk(await call({ service: svc, action: 'tree', query: { path: '' } }));
    const names = (tree.entries as Array<{ name: string }>).map((e) => e.name);
    expect(names).not.toContain('escape');
    expect(names).not.toContain('inner-link');

    for (const p of ['escape', 'escape/secret.txt', 'inner-link']) {
      const body = expectError(await call({ service: svc, action: 'tree', query: { path: p } }), 400);
      expectNoAbsolutePath(body, [root, outside]);
      // 逃逸目录内的文件也不可通过 file 端点读到
      if (p !== 'inner-link') {
        expectError(await call({ service: svc, action: 'file', query: { path: p } }), 400);
      }
    }
  });

  it('不存在 → 404 且文案固定中文', async () => {
    const svc = sessionService();
    const b1 = expectError(
      await call({ service: svc, action: 'file', query: { path: 'nope.txt' } }),
      404,
    );
    expect(b1.error).toBe('文件已不存在，可能已被删除或移动');
    const b2 = expectError(await call({ service: svc, action: 'tree', query: { path: 'nope' } }), 404);
    expect(b2.error).toBe('文件已不存在，可能已被删除或移动');
    expectNoAbsolutePath(b1, [root]);
  });

  it('reveal：钩子收到根内绝对路径 + isDir 正确，且响应 {ok:true}（不真弹 Finder）', async () => {
    const calls: Array<{ abs: string; isDir: boolean }> = [];
    const svc = sessionService();
    const reveal = (abs: string, isDir: boolean) => void calls.push({ abs, isDir });

    const dirBody = expectOk(
      await call({ service: svc, action: 'reveal', body: { path: 'docs' }, reveal }),
    );
    expect(dirBody).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.isDir).toBe(true);
    expect(calls[0]!.abs).toBe(path.join(root, 'docs'));
    expect(calls[0]!.abs.startsWith(root)).toBe(true);

    const fileBody = expectOk(
      await call({ service: svc, action: 'reveal', body: { path: 'docs/a.md' }, reveal }),
    );
    expect(fileBody).toEqual({ ok: true });
    expect(calls[1]!.isDir).toBe(false);
    expect(calls[1]!.abs).toBe(path.join(root, 'docs', 'a.md'));
  });

  it('reveal：缺省 path = 根目录；越界 → 400 且钩子不被调用', async () => {
    const calls: Array<{ abs: string; isDir: boolean }> = [];
    const svc = sessionService();
    const reveal = (abs: string, isDir: boolean) => void calls.push({ abs, isDir });

    expectOk(await call({ service: svc, action: 'reveal', body: {}, reveal }));
    expect(calls[0]).toEqual({ abs: root, isDir: true });

    const before = calls.length;
    const body = expectError(
      await call({ service: svc, action: 'reveal', body: { path: '../' }, reveal }),
      400,
    );
    expect(body.error).toBe('路径非法或超出根目录范围');
    expect(calls).toHaveLength(before); // 越界不触发 OS 调用
  });
});

// ══════════════════════════════════════════════════════════════════════════
// B4 非 git 目录的业务态
// ══════════════════════════════════════════════════════════════════════════

describe('B4 非 git 目录：200 业务态，不崩', () => {
  it('changes → is_repo:false + 中文 reason（已在上方逐字断言，这里补「不抛错」）', async () => {
    const svc = fakeService({ projects: [makeProject(PID, plain)] });
    const out = await call({ service: svc, family: 'projects', action: 'changes' });
    expect(out).not.toBeNull();
    expect((out as BrowseRouteOutcome).status).toBe(200);
  });

  it('diff 对不存在文件：200 业务态（ok:false + rows 空），绝不 500', async () => {
    const svc = fakeService({ projects: [makeProject(PID, plain)] });
    const body = expectOk(
      await call({
        service: svc,
        family: 'projects',
        action: 'diff',
        query: { path: 'nope.ts' },
      }),
    );
    expect(body.ok).toBe(false);
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows).toEqual([]);
    expect(body.path).toBe('nope.ts');
    expect(typeof body.reason).toBe('string');
    expect(body.added).toBe(0);
    expect(body.removed).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// B5 目录枚举规则
// ══════════════════════════════════════════════════════════════════════════

describe('B5 目录枚举：点号目录可见、构建产物目录不可见、目录优先、total 为过滤后总数', () => {
  let enumRoot = '';

  beforeEach(async () => {
    enumRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-f38r-enum-'));
    for (const dir of ['.github', '.workbuddy', 'node_modules', 'dist', 'build', 'out']) {
      await fs.mkdir(path.join(enumRoot, dir), { recursive: true });
      await fs.writeFile(path.join(enumRoot, dir, 'x.txt'), 'x\n');
    }
    await fs.writeFile(path.join(enumRoot, 'one.ts'), 'export const one = 1;\n');
    await fs.writeFile(path.join(enumRoot, 'two.md'), '# two\n');
  });

  afterEach(async () => {
    await fs.rm(enumRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('含 .github/.workbuddy，不含 node_modules/dist/build/out；目录排在文件前；total=过滤后总数', async () => {
    const svc = fakeService({ projects: [makeProject('p-enum', enumRoot)] });
    const body = expectOk(
      await call({ service: svc, family: 'projects', id: 'p-enum', action: 'tree', query: {} }),
    );
    const entries = body.entries as Array<{ name: string; type: 'dir' | 'file' }>;
    const names = entries.map((e) => e.name);

    expect(names).toContain('.github');
    expect(names).toContain('.workbuddy');
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('dist');
    expect(names).not.toContain('build');
    expect(names).not.toContain('out');

    // 目录优先
    const firstFileIdx = entries.findIndex((e) => e.type === 'file');
    const lastDirIdx = entries.map((e) => e.type).lastIndexOf('dir');
    expect(lastDirIdx).toBeLessThan(firstFileIdx);

    // total = 过滤后总数（2 个点号目录 + 2 个文件）
    expect(body.total).toBe(4);
    expect(entries).toHaveLength(4);
    expect(body.truncated).toBe(false);
    expect(body.path).toBe('');
  });

  it('子目录 path 生效：path=docs 时 path 回显 docs', async () => {
    await fs.mkdir(path.join(enumRoot, 'docs'), { recursive: true });
    await fs.writeFile(path.join(enumRoot, 'docs', 'z.txt'), 'z\n');
    const svc = fakeService({ projects: [makeProject('p-enum', enumRoot)] });
    const body = expectOk(
      await call({
        service: svc,
        family: 'projects',
        id: 'p-enum',
        action: 'tree',
        query: { path: 'docs' },
      }),
    );
    expect(body.path).toBe('docs');
    expect((body.entries as Array<{ name: string }>).map((e) => e.name)).toEqual(['z.txt']);
    expect(body.total).toBe(1);
  });
});
