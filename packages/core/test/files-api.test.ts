/**
 * F-38 T02：只读 HTTP 端点单测（两套作用域 × 5 端点）
 * - session 作用域走 resolveWorkRoot、project 作用域走 project.root_path（两者结果一致时也要各自通）
 * - 路径越界 / 绝对路径 / 根外符号链接 → 400；不存在 → 404；错误体不含根绝对路径
 * - 非 git → 200 + is_repo:false + 中文 reason；git 正常 → 清单含未跟踪/删除/改名真实行数
 * - 未跟踪 diff 服务端合成全新增；二进制 diff → binary:true + rows 空
 * - 300 条上限截断 + totals 为全量合计
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChatMessage, ChatRequest, LLMProvider, StreamEvent } from '@y-zero/shared';
import { SessionService } from '../src/session/service.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { SessionHub, createWebServer } from '../src/server/index.js';

class NoopProvider implements LLMProvider {
  readonly id = 'noop';
  async *chat(_req: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: 'done' };
  }
  estimateTokens(messages: ChatMessage[]): number {
    return messages.length;
  }
}

let root = ''; // git 仓库（项目根）
let plain = ''; // 非 git 目录
let outside = ''; // 根外目录（符号链接目标）
/** SQLite 目录独立于项目根：否则 db.sqlite* 会作为未跟踪文件污染 git status 断言 */
let dbDir = '';
let server: ReturnType<typeof createWebServer>;
let base = '';
let projectId = '';
let sessionId = '';
let plainProjectId = '';
const reveals: Array<{ abs: string; isDir: boolean }> = [];

function git(cmd: string): void {
  execSync(cmd, { cwd: root, stdio: 'pipe' });
}

interface JsonResult {
  status: number;
  json: Record<string, unknown>;
}

const get = async (p: string): Promise<JsonResult> => {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};

const post = async (p: string, body: unknown): Promise<JsonResult> => {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-f38-api-'));
  plain = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-f38-plain-'));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-f38-out-'));
  dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-f38-db-'));
  reveals.length = 0;

  // 初始提交内容
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.mkdir(path.join(root, '.github'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'a.md'), '# hi\n');
  await fs.writeFile(path.join(root, 'README.md'), '# init\n');
  await fs.writeFile(path.join(root, '.github', 'ci.yml'), 'on: push\n');
  await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'x');
  await fs.writeFile(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3]));

  git('git init');
  git('git config user.email test@example.com');
  git('git config user.name tester');
  git('git add -A');
  git('git commit -m init');

  // 四类工作区变更：未跟踪 / 修改 / 删除 / 改名 + 二进制改动
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'new.ts'), 'a\nb\nc\n');
  await fs.writeFile(path.join(root, 'docs', 'a.md'), '# hi\nline2\n');
  await fs.rm(path.join(root, 'README.md'));
  git('git mv .github/ci.yml .github/ci2.yml');
  await fs.writeFile(path.join(root, 'bin.dat'), Buffer.from([0, 9, 9, 9]));
  // 根外符号链接
  await fs.symlink(outside, path.join(root, 'evil-link'), 'dir');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret');

  await fs.writeFile(path.join(plain, 'note.md'), '# plain\n');

  const service = new SessionService(path.join(dbDir, 'db.sqlite'));
  projectId = service.ensureProject(root).id;
  plainProjectId = service.ensureProject(plain).id;
  sessionId = service.createSession(projectId, { title: 's' }).id;
  const hub = new SessionHub({
    service,
    registry: new ToolRegistry(),
    resolveProvider: async () => new NoopProvider(),
  });
  server = createWebServer({
    service,
    hub,
    port: 0,
    browseReveal: (abs, isDir) => reveals.push({ abs, isDir }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // 清理失败不影响断言（部分受限环境会拒绝删除临时目录，残留目录无害）
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(plain, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(outside, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(dbDir, { recursive: true, force: true }).catch(() => undefined);
});

describe('GET …/browse/tree', () => {
  it('project 作用域：返回 root_name / entries / total / truncated', async () => {
    const r = await get(`/api/projects/${projectId}/browse/tree?path=`);
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.path).toBe('');
    expect(r.json.root_name).toBe(path.basename(root));
    expect(r.json.truncated).toBe(false);
    const names = (r.json.entries as Array<{ name: string }>).map((e) => e.name);
    expect(names).toContain('docs');
    expect(names).toContain('src');
    expect(names).toContain('.github');
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('evil-link');
  });

  it('session 作用域：同一 handler、同一根解析', async () => {
    const r = await get(`/api/sessions/${sessionId}/browse/tree?path=docs`);
    expect(r.status).toBe(200);
    expect(r.json.path).toBe('docs');
    const entries = r.json.entries as Array<{ name: string; type: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'a.md', type: 'file' });
  });

  it('越界 / 绝对路径 / 根外符号链接 → 400，且错误体不含根绝对路径', async () => {
    const cases = [
      `/api/projects/${projectId}/browse/tree?path=${encodeURIComponent('../etc/passwd')}`,
      `/api/projects/${projectId}/browse/tree?path=${encodeURIComponent('/etc/passwd')}`,
      `/api/projects/${projectId}/browse/tree?path=${encodeURIComponent('C:\\Windows')}`,
      `/api/projects/${projectId}/browse/tree?path=${encodeURIComponent('evil-link')}`,
    ];
    for (const p of cases) {
      const r = await get(p);
      expect(r.status).toBe(400);
      expect(r.json.error).toBe('路径非法或超出根目录范围');
      expect(JSON.stringify(r.json)).not.toContain(root);
    }
  });

  it('不存在的目录 → 404', async () => {
    const r = await get(`/api/projects/${projectId}/browse/tree?path=nope`);
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('文件已不存在，可能已被删除或移动');
  });

  it('未知 session / project → 404 + 契约文案', async () => {
    expect((await get('/api/sessions/nope/browse/tree')).json.error).toBe('session not found');
    expect((await get('/api/projects/nope/browse/tree')).json.error).toBe('project not found');
  });
});

describe('GET …/browse/file', () => {
  it('markdown 预览（snake_case 字段齐全）', async () => {
    const r = await get(`/api/projects/${projectId}/browse/file?path=${encodeURIComponent('docs/a.md')}`);
    expect(r.status).toBe(200);
    expect(r.json.kind).toBe('markdown');
    expect(r.json.name).toBe('a.md');
    expect(r.json.path).toBe('docs/a.md');
    expect(r.json.language).toBe('markdown');
    expect(String(r.json.content)).toContain('# hi');
    expect(typeof r.json.modified_at).toBe('string');
  });

  it('已删除文件 → 404（快照口径不返回半截内容）', async () => {
    const r = await get(`/api/projects/${projectId}/browse/file?path=README.md`);
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('文件已不存在，可能已被删除或移动');
  });

  it('session 作用域同样可读；越界 → 400', async () => {
    const ok = await get(`/api/sessions/${sessionId}/browse/file?path=src/new.ts`);
    expect(ok.status).toBe(200);
    expect(ok.json.kind).toBe('text');
    expect(ok.json.language).toBe('typescript');
    const bad = await get(`/api/sessions/${sessionId}/browse/file?path=${encodeURIComponent('../x')}`);
    expect(bad.status).toBe(400);
  });
});

describe('GET …/browse/changes', () => {
  it('清单含未跟踪 / 修改 / 删除 / 改名（改名取新路径 + 真实增删）', async () => {
    const r = await get(`/api/projects/${projectId}/browse/changes`);
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.is_repo).toBe(true);
    expect(r.json.root_name).toBe(path.basename(root));
    expect(r.json.truncated).toBe(false);

    const files = r.json.files as Array<{
      path: string;
      status: string;
      added: number;
      removed: number;
      binary: boolean;
      orig_path: string | null;
    }>;
    const byPath = new Map(files.map((f) => [f.path, f]));

    // 未跟踪：+N -0，行数来自读盘计数
    expect(byPath.get('src/new.ts')).toMatchObject({ status: 'untracked', added: 3, removed: 0 });
    // 修改：来自 numstat
    expect(byPath.get('docs/a.md')).toMatchObject({ status: 'modified', added: 1, removed: 0 });
    // 删除：真实删除行数
    expect(byPath.get('README.md')).toMatchObject({ status: 'deleted', added: 0, removed: 1 });
    // 改名：以新路径为 key + 保留旧路径
    const renamed = byPath.get('.github/ci2.yml');
    expect(renamed?.status).toBe('renamed');
    expect(renamed?.orig_path).toBe('.github/ci.yml');
    // 二进制：0/0 + binary=true
    expect(byPath.get('bin.dat')).toMatchObject({ added: 0, removed: 0, binary: true });

    // 合计 = 各行加和
    const totals = r.json.totals as { added: number; removed: number };
    expect(totals.added).toBe(files.reduce((n, f) => n + f.added, 0));
    expect(totals.removed).toBe(files.reduce((n, f) => n + f.removed, 0));
    expect(r.json.total_files).toBe(files.length);
  });

  it('同名路径在 session 作用域结果一致', async () => {
    const r = await get(`/api/sessions/${sessionId}/browse/changes`);
    expect(r.status).toBe(200);
    expect((r.json.files as unknown[]).length).toBeGreaterThan(0);
  });

  it('非 git 目录 → 200 + is_repo:false + 中文 reason（不抛错）', async () => {
    const r = await get(`/api/projects/${plainProjectId}/browse/changes`);
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.is_repo).toBe(false);
    expect(r.json.files).toEqual([]);
    expect(r.json.total_files).toBe(0);
    expect(r.json.reason).toBe('当前目录不是 git 仓库，无法查看变更');
  });

  it('300 条上限：files=300 / total_files=305 / truncated=true，totals 仍为全量', async () => {
    // 先取基线（未跟踪/修改/删除/改名/二进制/未跟踪符号链接 共 6 条），再叠加 305 个新文件
    const before = await get(`/api/projects/${projectId}/browse/changes`);
    const baseline = Number(before.json.total_files);
    expect(baseline).toBeGreaterThan(0);

    const bulk = path.join(root, 'bulk');
    await fs.mkdir(bulk);
    await Promise.all(
      Array.from({ length: 305 }, (_, i) =>
        fs.writeFile(path.join(bulk, `f${String(i).padStart(3, '0')}.txt`), 'x\n'),
      ),
    );
    const r = await get(`/api/projects/${projectId}/browse/changes`);
    expect(r.status).toBe(200);
    expect((r.json.files as unknown[]).length).toBe(300);
    expect(r.json.total_files).toBe(baseline + 305);
    expect(r.json.truncated).toBe(true);
    const totals = r.json.totals as { added: number };
    expect(totals.added).toBeGreaterThanOrEqual(305);
  }, 30_000);
});

describe('GET …/browse/diff', () => {
  it('未跟踪文件 → 服务端合成全新增行', async () => {
    const r = await get(`/api/projects/${projectId}/browse/diff?path=${encodeURIComponent('src/new.ts')}`);
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.status).toBe('untracked');
    expect(r.json.added).toBe(3);
    expect(r.json.removed).toBe(0);
    const rows = r.json.rows as Array<{ type: string; old_no: number | null; new_no: number | null; text: string }>;
    expect(rows[0]).toEqual({ type: 'hunk', old_no: null, new_no: null, text: '@@ -0,0 +1,3 @@' });
    expect(rows.slice(1).map((row) => row.text)).toEqual(['a', 'b', 'c']);
    expect(rows.slice(1).every((row) => row.type === 'add')).toBe(true);
  });

  it('已修改文件 → unified diff 行（hunk / add / ctx）', async () => {
    const r = await get(`/api/projects/${projectId}/browse/diff?path=${encodeURIComponent('docs/a.md')}`);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('modified');
    expect(r.json.added).toBe(1);
    const rows = r.json.rows as Array<{ type: string; text: string }>;
    expect(rows[0]?.type).toBe('hunk');
    expect(rows.some((row) => row.type === 'add' && row.text === 'line2')).toBe(true);
  });

  it('已删除文件 → 仍可看 diff（del 行，不被 404 拦截）', async () => {
    const r = await get(`/api/projects/${projectId}/browse/diff?path=README.md`);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('deleted');
    expect(r.json.removed).toBe(1);
    const rows = r.json.rows as Array<{ type: string }>;
    expect(rows.some((row) => row.type === 'del')).toBe(true);
  });

  it('session 作用域 diff：同一 handler，行内容与 project 作用域逐行一致', async () => {
    const viaSession = await get(`/api/sessions/${sessionId}/browse/diff?path=${encodeURIComponent('docs/a.md')}`);
    const viaProject = await get(`/api/projects/${projectId}/browse/diff?path=${encodeURIComponent('docs/a.md')}`);
    expect(viaSession.status).toBe(200);
    expect(viaSession.json.status).toBe('modified');
    expect(viaSession.json.path).toBe('docs/a.md');
    expect(viaSession.json.rows).toEqual(viaProject.json.rows);
  });

  it('二进制文件 → binary:true + rows 空 + 中文 reason', async () => {
    const r = await get(`/api/projects/${projectId}/browse/diff?path=bin.dat`);
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.binary).toBe(true);
    expect(r.json.rows).toEqual([]);
    expect(String(r.json.reason)).toContain('二进制');
  });

  it('文件名含通配符不会被误匹配（:(literal) pathspec）', async () => {
    await fs.writeFile(path.join(root, 'a*.ts'), 'star\n');
    await fs.writeFile(path.join(root, 'a1.ts'), 'star\n');
    const star = await get(`/api/projects/${projectId}/browse/diff?path=${encodeURIComponent('a*.ts')}`);
    expect(star.status).toBe(200);
    expect(star.json.path).toBe('a*.ts');
    // 若 pathspec 未按 literal 处理，git 会把 a1.ts 的内容也带进来
    expect(JSON.stringify(star.json.rows)).not.toContain('a1.ts');
  });

  it('缺少 path / 越界 path → 400', async () => {
    const missing = await get(`/api/projects/${projectId}/browse/diff`);
    expect(missing.status).toBe(400);
    const bad = await get(`/api/projects/${projectId}/browse/diff?path=${encodeURIComponent('../etc/passwd')}`);
    expect(bad.status).toBe(400);
  });
});

describe('POST …/browse/reveal', () => {
  it('省略 path = 打开工作根；指定 path = 打开该目录', async () => {
    const atRoot = await post(`/api/projects/${projectId}/browse/reveal`, {});
    expect(atRoot.status).toBe(200);
    expect(atRoot.json.ok).toBe(true);
    expect(reveals[0]).toEqual({ abs: path.resolve(root), isDir: true });

    const sub = await post(`/api/sessions/${sessionId}/browse/reveal`, { path: 'docs' });
    expect(sub.status).toBe(200);
    expect(reveals[1]).toEqual({ abs: path.join(path.resolve(root), 'docs'), isDir: true });
  });

  it('越界 path → 400，不触发任何 OS 调用', async () => {
    const bad = await post(`/api/projects/${projectId}/browse/reveal`, { path: '../x' });
    expect(bad.status).toBe(400);
    expect(reveals).toEqual([]);
  });
});

describe('既有端点回归（F-38 不得影响 composer）', () => {
  it('GET /api/projects/:id/files 仍跳过点号目录 / 忽略目录（行为不变）', async () => {
    const r = await get(`/api/projects/${projectId}/files`);
    expect(r.status).toBe(200);
    const files = r.json.files as string[];
    expect(files).toContain('docs/a.md');
    expect(files.some((f) => f.startsWith('.github'))).toBe(false);
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(files.some((f) => f.startsWith('evil-link'))).toBe(false);
  });
});
