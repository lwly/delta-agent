/**
 * F-38 T01：文件原语 + unified diff 纯函数单测
 * - resolveInRoot：`..` 越界 / 绝对路径 / Windows driveless / 根外与根内符号链接全部拒绝，且错误文案不含绝对路径
 * - listDir：点号目录可见、忽略清单可见性、目录优先 + 大小写不敏感排序、符号链接条目不返回、500 截断
 * - readFileForPreview：markdown / text / image / binary / oversize 五分流
 * - parseUnifiedDiff：hunk/add/del/ctx 行号、2000 行与 256KB 截断
 * - buildAllAddedRows：未跟踪文件「全新增」合成（含 PNG 类二进制不参与）
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BROWSE_IGNORED_DIRS,
  MAX_DIR_ENTRIES,
  PATH_REJECT_MESSAGE,
  isBrowseIgnored,
  listDir,
  normalizeRelPath,
  readFileForPreview,
  resolveInRoot,
} from '../src/files/browse.js';
import {
  DIFF_MAX_ROWS,
  buildAllAddedRows,
  parseUnifiedDiff,
} from '../src/files/patch.js';

let root = '';
let outside = '';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-f38-browse-'));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-f38-outside-'));
  await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret');

  // 目录树：普通目录 / 点号目录 / 忽略目录 / 混合大小写文件
  await fs.mkdir(path.join(root, 'docs', 'assets'), { recursive: true });
  await fs.mkdir(path.join(root, '.github'), { recursive: true });
  await fs.mkdir(path.join(root, '.workbuddy'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'a.md'), '# 标题\n\n正文\n');
  await fs.writeFile(path.join(root, 'docs', 'assets', 'logo.png'), 'PNG');
  await fs.writeFile(path.join(root, '.github', 'ci.yml'), 'on: push\n');
  await fs.writeFile(path.join(root, '.workbuddy', 'note.md'), '# note\n');
  await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'x');
  await fs.writeFile(path.join(root, '.git', 'config'), '');
  await fs.writeFile(path.join(root, 'README.md'), '# init\n');
  await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 1;\n');
  await fs.writeFile(path.join(root, 'B.ts'), 'export const b = 1;\n');
});

afterEach(async () => {
  // 清理失败不影响断言（部分受限环境会拒绝删除临时目录，残留目录无害）
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(outside, { recursive: true, force: true }).catch(() => undefined);
});

describe('normalizeRelPath / resolveInRoot —— 路径安全唯一实现点', () => {
  it('normalizeRelPath 折叠 ./ 与多余 /，根为 空串', () => {
    expect(normalizeRelPath('')).toEqual({ ok: true, rel: '' });
    expect(normalizeRelPath(undefined)).toEqual({ ok: true, rel: '' });
    expect(normalizeRelPath('./docs//a.md')).toEqual({ ok: true, rel: 'docs/a.md' });
    expect(normalizeRelPath('docs\\assets')).toEqual({ ok: true, rel: 'docs/assets' });
    expect(normalizeRelPath('docs/../a.ts')).toEqual({ ok: true, rel: 'a.ts' });
  });

  it('四类越界输入全部拒绝，且文案固定中文不含绝对路径', () => {
    for (const bad of ['../etc/passwd', '/etc/passwd', 'C:\\x', '..\\..\\x', 'docs/../../etc', 'C:foo']) {
      const r = normalizeRelPath(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('invalid_path');
        expect(r.message).toBe(PATH_REJECT_MESSAGE);
        expect(r.message).not.toContain(root);
      }
    }
  });

  it('根内路径解析为绝对路径 + POSIX 相对路径', async () => {
    const r = await resolveInRoot(root, 'docs/a.md');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rel).toBe('docs/a.md');
      expect(r.abs).toBe(path.join(root, 'docs', 'a.md'));
    }
    const atRoot = await resolveInRoot(root, '');
    expect(atRoot.ok).toBe(true);
    if (atRoot.ok) expect(atRoot.rel).toBe('');
  });

  it('根外与根内符号链接均拒绝（任何符号链接不跟随）', async () => {
    await fs.symlink(outside, path.join(root, 'out-link'), 'dir');
    await fs.symlink(path.join(root, 'docs'), path.join(root, 'in-link'), 'dir');
    for (const rel of ['out-link', 'in-link', 'out-link/secret.txt']) {
      const r = await resolveInRoot(root, rel);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toBe(PATH_REJECT_MESSAGE);
    }
  });

  it('不存在的路径 → not_found 语义文案', async () => {
    const r = await resolveInRoot(root, 'nope.md');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('not_found');
      expect(r.message).toBe('文件已不存在，可能已被删除或移动');
    }
  });
});

describe('listDir —— 单层枚举', () => {
  it('忽略清单 14 项且不含 .idea/.vscode', () => {
    expect(BROWSE_IGNORED_DIRS).toHaveLength(14);
    expect(BROWSE_IGNORED_DIRS).toContain('.git');
    expect(BROWSE_IGNORED_DIRS).toContain('node_modules');
    expect(BROWSE_IGNORED_DIRS).not.toContain('.idea');
    expect(BROWSE_IGNORED_DIRS).not.toContain('.vscode');
    expect(isBrowseIgnored('.git')).toBe(true);
    expect(isBrowseIgnored('.github')).toBe(false);
  });

  it('点号目录照常展示、忽略目录不出现、符号链接条目被过滤、目录优先 + 大小写不敏感排序', async () => {
    await fs.symlink(outside, path.join(root, 'evil-link'), 'dir');
    const listing = await listDir(root, '');
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    const names = listing.entries.map((e) => e.name);
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('.git');
    expect(names).not.toContain('evil-link');
    expect(names).toContain('.github');
    expect(names).toContain('.workbuddy');
    // 目录优先：前三个是目录（.github / .workbuddy / docs），其后是文件
    expect(listing.entries.slice(0, 3).map((e) => e.type)).toEqual(['dir', 'dir', 'dir']);
    expect(names.slice(0, 3)).toEqual(['.github', '.workbuddy', 'docs']);
    // 文件按 toLowerCase 字典序：a.ts < B.ts < README.md
    expect(names.slice(3)).toEqual(['a.ts', 'B.ts', 'README.md']);
    expect(listing.truncated).toBe(false);
    expect(listing.total).toBe(6);
  });

  it('文件条目带 size，目录条目不带', async () => {
    const listing = await listDir(root, 'docs');
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    const dirEntry = listing.entries.find((e) => e.name === 'assets');
    const fileEntry = listing.entries.find((e) => e.name === 'a.md');
    expect(dirEntry).toEqual({ name: 'assets', type: 'dir' });
    expect(fileEntry?.type).toBe('file');
    expect(fileEntry?.size).toBe(Buffer.byteLength('# 标题\n\n正文\n'));
  });

  it('单层 500 条上限：entries=500 / total=505 / truncated=true', async () => {
    const bulk = path.join(root, 'bulk');
    await fs.mkdir(bulk);
    await Promise.all(
      Array.from({ length: 505 }, (_, i) =>
        fs.writeFile(path.join(bulk, `f${String(i).padStart(3, '0')}.txt`), 'x'),
      ),
    );
    const listing = await listDir(root, 'bulk');
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    expect(listing.entries).toHaveLength(MAX_DIR_ENTRIES);
    expect(listing.total).toBe(505);
    expect(listing.truncated).toBe(true);
  }, 30_000);

  it('越界路径与「不是目录」分别返回 400/404 语义', async () => {
    const bad = await listDir(root, '../x');
    expect(bad.ok).toBe(false);
    const notDir = await listDir(root, 'README.md');
    expect(notDir.ok).toBe(false);
    if (!notDir.ok) {
      expect(notDir.code).toBe('invalid_path');
      expect(notDir.message).toBe('该路径不是目录');
    }
  });
});

describe('readFileForPreview —— 五分流', () => {
  it('markdown：原文 + language=markdown + 元信息', async () => {
    const r = await readFileForPreview(root, 'docs/a.md');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('markdown');
    expect(r.content).toBe('# 标题\n\n正文\n');
    expect(r.language).toBe('markdown');
    expect(r.path).toBe('docs/a.md');
    expect(r.name).toBe('a.md');
    expect(Number.isNaN(Date.parse(r.modified_at))).toBe(false);
  });

  it('代码：text + hljs 语言标识（未知扩展名回落 plaintext）', async () => {
    const ts = await readFileForPreview(root, 'a.ts');
    expect(ts.ok).toBe(true);
    if (ts.ok) {
      expect(ts.kind).toBe('text');
      expect(ts.language).toBe('typescript');
      expect(ts.content).toContain('export const a = 1;');
    }
    await fs.writeFile(path.join(root, 'weird.zzz'), 'plain');
    const unknown = await readFileForPreview(root, 'weird.zzz');
    expect(unknown.ok).toBe(true);
    if (unknown.ok) expect(unknown.language).toBe('plaintext');
  });

  it('图片：kind=image + mime + data_url（PNG 头部含 NUL 也不得被判成 binary）', async () => {
    // 真实 PNG 头：IHDR 长度字段为 0x0000000D，必然含 0x00
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    await fs.writeFile(path.join(root, 'docs', 'real.png'), png);
    const r = await readFileForPreview(root, 'docs/real.png');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('image');
    expect(r.mime).toBe('image/png');
    expect(r.data_url).toBe(`data:image/png;base64,${png.toString('base64')}`);
    expect(r.content).toBeUndefined();
  });

  it('二进制（前 8KB 含 NUL）→ kind=binary + 中文降级 reason，无 content', async () => {
    await fs.writeFile(path.join(root, 'blob.dat'), Buffer.from([1, 2, 0, 4, 5]));
    const r = await readFileForPreview(root, 'blob.dat');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('binary');
    expect(r.content).toBeUndefined();
    expect(r.reason).toContain('二进制');
  });

  it('超过 1MB → kind=oversize，不返回 content（图片同样受限）', async () => {
    await fs.writeFile(path.join(root, 'big.txt'), Buffer.alloc(1_000_001, 0x61));
    const txt = await readFileForPreview(root, 'big.txt');
    expect(txt.ok).toBe(true);
    if (txt.ok) {
      expect(txt.kind).toBe('oversize');
      expect(txt.content).toBeUndefined();
      expect(txt.size).toBe(1_000_001);
      expect(txt.reason).toContain('1MB');
    }
    await fs.writeFile(path.join(root, 'big.png'), Buffer.alloc(1_000_001, 0x61));
    const img = await readFileForPreview(root, 'big.png');
    expect(img.ok).toBe(true);
    if (img.ok) {
      expect(img.kind).toBe('oversize');
      expect(img.data_url).toBeUndefined();
    }
  });

  it('越界 / 不存在 / 目录 → 结构化失败', async () => {
    const bad = await readFileForPreview(root, '../etc/passwd');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toBe(PATH_REJECT_MESSAGE);
    const missing = await readFileForPreview(root, 'nope.md');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('not_found');
    const dir = await readFileForPreview(root, 'docs');
    expect(dir.ok).toBe(false);
    if (!dir.ok) expect(dir.message).toBe('该路径不是文件');
  });
});

const SAMPLE_PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' }',
  '\\ No newline at end of file',
  '',
].join('\n');

describe('parseUnifiedDiff —— 结构化行与行号', () => {
  it('丢弃文件级头部，hunk/add/del/ctx 行号正确', () => {
    const parsed = parseUnifiedDiff(SAMPLE_PATCH);
    expect(parsed.truncated).toBe(false);
    expect(parsed.added).toBe(2);
    expect(parsed.removed).toBe(1);
    expect(parsed.rows.map((r) => r.type)).toEqual(['hunk', 'ctx', 'del', 'add', 'add', 'ctx']);
    expect(parsed.rows[0]).toEqual({ type: 'hunk', old_no: null, new_no: null, text: '@@ -1,3 +1,4 @@' });
    expect(parsed.rows[1]).toEqual({ type: 'ctx', old_no: 1, new_no: 1, text: 'const a = 1;' });
    expect(parsed.rows[2]).toEqual({ type: 'del', old_no: 2, new_no: null, text: 'const b = 2;' });
    expect(parsed.rows[3]).toEqual({ type: 'add', old_no: null, new_no: 2, text: 'const b = 3;' });
    expect(parsed.rows[4]).toEqual({ type: 'add', old_no: null, new_no: 3, text: 'const c = 4;' });
    expect(parsed.rows[5]).toEqual({ type: 'ctx', old_no: 3, new_no: 4, text: '}' });
  });

  it('多 hunk 各自重新起算行号', () => {
    const raw = ['@@ -1,1 +1,1 @@', '-a', '+b', '@@ -10,1 +10,2 @@', ' ctx', '+new'].join('\n');
    const parsed = parseUnifiedDiff(raw);
    expect(parsed.rows.map((r) => [r.type, r.old_no, r.new_no])).toEqual([
      ['hunk', null, null],
      ['del', 1, null],
      ['add', null, 1],
      ['hunk', null, null],
      ['ctx', 10, 10],
      ['add', null, 11],
    ]);
  });

  it('超 2000 行 → rows=2000 且 truncated=true', () => {
    const lines = ['@@ -1,3000 +1,3000 @@'];
    for (let i = 0; i < 3000; i += 1) lines.push(`+line ${i}`);
    const parsed = parseUnifiedDiff(lines.join('\n'));
    expect(parsed.rows).toHaveLength(DIFF_MAX_ROWS);
    expect(parsed.truncated).toBe(true);
  });

  it('超 256KB → 同样截断', () => {
    const lines = ['@@ -1,1 +1,1 @@'];
    const big = 'x'.repeat(4096);
    for (let i = 0; i < 200; i += 1) lines.push(`+${big}`);
    const parsed = parseUnifiedDiff(lines.join('\n'));
    expect(parsed.truncated).toBe(true);
    expect(parsed.rows.length).toBeLessThan(200);
  });

  it('空输入 → 空结果', () => {
    expect(parseUnifiedDiff('')).toEqual({ rows: [], truncated: false, added: 0, removed: 0 });
  });
});

describe('buildAllAddedRows —— 未跟踪文件合成「全新增」', () => {
  it('三行文件 → hunk @@ -0,0 +1,3 @@ + 三行 add', () => {
    const parsed = buildAllAddedRows('a\nb\nc\n');
    expect(parsed.truncated).toBe(false);
    expect(parsed.added).toBe(3);
    expect(parsed.removed).toBe(0);
    expect(parsed.rows[0]).toEqual({ type: 'hunk', old_no: null, new_no: null, text: '@@ -0,0 +1,3 @@' });
    expect(parsed.rows.slice(1)).toEqual([
      { type: 'add', old_no: null, new_no: 1, text: 'a' },
      { type: 'add', old_no: null, new_no: 2, text: 'b' },
      { type: 'add', old_no: null, new_no: 3, text: 'c' },
    ]);
  });

  it('结尾无换行时同样按行计数', () => {
    const parsed = buildAllAddedRows('a\nb');
    expect(parsed.added).toBe(2);
    expect(parsed.rows).toHaveLength(3);
  });

  it('空文件 → 空 rows', () => {
    expect(buildAllAddedRows('')).toEqual({ rows: [], truncated: false, added: 0, removed: 0 });
  });

  it('超 2000 行 → 截断但 added 仍为整文件行数', () => {
    const text = `${Array.from({ length: 2500 }, (_, i) => `line ${i}`).join('\n')}\n`;
    const parsed = buildAllAddedRows(text);
    expect(parsed.rows).toHaveLength(DIFF_MAX_ROWS);
    expect(parsed.truncated).toBe(true);
    expect(parsed.added).toBe(2500);
  });
});
