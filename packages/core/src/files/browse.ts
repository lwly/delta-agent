/**
 * F-38 文件浏览原语（只读）
 *
 * 设计：docs/design-f38-project-file-panel.md（D4/D5/D6/D10/§6/§8）
 * - 路径安全唯一实现点 `resolveInRoot`：绝对路径 / Windows driveless / `..` 越界 /
 *   根外符号链接一律拒绝，错误文案固定中文且**不回显任何绝对路径**（PRD §6）
 * - 目录枚举只做**单层**（懒加载逐层请求天然限深），目录优先 → 大小写不敏感字典序，
 *   符号链接条目直接不返回，单层上限 MAX_DIR_ENTRIES
 * - 预览分流五态：markdown / text / image / binary / oversize
 *   1MB 上限复用 session/changes.ts 的 MAX_SNAPSHOT_BYTES，二进制探测沿用「前 8KB 含 NUL」口径
 *   （不复用 readSnapshot：它把 binary 与 oversized 合成一个标记，无法区分两种降级文案）
 *
 * 本模块**只读**：不出现任何 fs.write* / rm / mkdir 调用。
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { MAX_SNAPSHOT_BYTES } from '../session/changes.js';

// ── 忽略清单（D5：单一来源，http.ts 的 IGNORED_DIRS 引用它）─────────────────

/**
 * 面板文件树必忽略的目录（PRD §6 目录显隐规则）。
 * 注意：**不含** `.idea` / `.vscode` —— 点号目录照常展示是面板语义；
 * composer 侧 collectProjectFiles 另有 `name.startsWith('.')` 兜底，行为零变化。
 */
export const BROWSE_IGNORED_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  'bin',
  'obj',
];

const BROWSE_IGNORED_SET: ReadonlySet<string> = new Set(BROWSE_IGNORED_DIRS);

/** 该目录名是否在面板忽略清单内（仅用于目录；文件一律展示）。 */
export function isBrowseIgnored(name: string): boolean {
  return BROWSE_IGNORED_SET.has(name);
}

/** 单层目录条目上限（PRD §6）。 */
export const MAX_DIR_ENTRIES = 500;

/** 二进制探测窗口（与 session/changes.ts 的 readSnapshot 同口径）。 */
const BINARY_PROBE_BYTES = 8192;

// ── 固定错误文案（§4.6：中文、不含路径）──────────────────────────────────────

/** 路径边界类（400）。 */
export const PATH_REJECT_MESSAGE = '路径非法或超出根目录范围';
/** 目标不存在类（404）。 */
export const NOT_FOUND_MESSAGE = '文件已不存在，可能已被删除或移动';
/** 权限不足类（403）。 */
export const DENIED_MESSAGE = '无权限读取该路径';

// ── 路径规范化 / 根内解析 ───────────────────────────────────────────────────

export interface RelPathOk {
  ok: true;
  /** POSIX 分隔符、根为 ''，已折叠 '.' 与多余的 '/' */
  rel: string;
}

export interface RelPathFail {
  ok: false;
  code: 'invalid_path';
  message: string;
}

export type RelPathResult = RelPathOk | RelPathFail;

/**
 * 纯语法层路径规范化（不触发 IO）：
 * - 入参容忍 Windows 反斜杠（先归一化为 '/'，§8.3），归一化后再判绝对路径
 * - 拒绝：POSIX 绝对路径 / `\\server\share` / Windows 盘符或 driveless（`C:foo`）/ NUL 字符
 * - `..` 在栈内折叠，折叠时若无剩余段则判定越界（`../x`、`a/../../b` 均拒绝）
 */
export function normalizeRelPath(relPath?: string | null): RelPathResult {
  const raw = relPath === undefined || relPath === null ? '' : String(relPath);
  if (raw.includes('\u0000')) return { ok: false, code: 'invalid_path', message: PATH_REJECT_MESSAGE };
  const unified = raw.replace(/\\/g, '/');
  if (unified.startsWith('/')) return { ok: false, code: 'invalid_path', message: PATH_REJECT_MESSAGE };
  if (/^[a-zA-Z]:/.test(unified)) return { ok: false, code: 'invalid_path', message: PATH_REJECT_MESSAGE };

  const segments: string[] = [];
  for (const seg of unified.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segments.length === 0) return { ok: false, code: 'invalid_path', message: PATH_REJECT_MESSAGE };
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  return { ok: true, rel: segments.join('/') };
}

export type RootResolveErrorCode = 'invalid_path' | 'outside_root' | 'symlink' | 'not_found' | 'denied';

export type RootResolve =
  | { ok: true; abs: string; rel: string }
  | { ok: false; code: RootResolveErrorCode; message: string };

/** 根内解析失败结果（供上层复用同一形状）。 */
export type RootResolveFailure = Extract<RootResolve, { ok: false }>;

/** fs 异常 → 统一失败结构（ENOENT → 404 语义；EACCES/EPERM → 403；其余按不存在处理）。 */
export function mapFsError(e: unknown): RootResolveFailure {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM') return { ok: false, code: 'denied', message: DENIED_MESSAGE };
  if (code === 'ELOOP' || code === 'ENOTDIR') return { ok: false, code: 'invalid_path', message: PATH_REJECT_MESSAGE };
  return { ok: false, code: 'not_found', message: NOT_FOUND_MESSAGE };
}

/** realpath 的安全包装（失败返回 null，由调用方按 not_found 处理）。 */
async function safeRealpath(target: string): Promise<string | null> {
  try {
    return await fsp.realpath(target);
  } catch {
    return null;
  }
}

/**
 * 路径安全唯一实现点（PRD §6 / design §6）：
 * 1. `normalizeRelPath` 做纯语法校验（绝对路径 / driveless / `..` 越界 / NUL）
 * 2. `path.resolve` 拼接后二次根内判定
 * 3. `lstat` 末端符号链接拒绝（任何符号链接都不跟随）
 * 4. `realpath` 二次根内判定（中间层符号链接逃逸在此暴露）
 */
export async function resolveInRoot(root: string, relPath?: string | null): Promise<RootResolve> {
  const norm = normalizeRelPath(relPath);
  if (!norm.ok) return norm;
  const rel = norm.rel;

  const rootAbs = path.resolve(root);
  const abs = rel === '' ? rootAbs : path.join(rootAbs, ...rel.split('/'));
  // 拼接后二次判定（normalize 已折叠 '..'，此处挡「拼接异常 / 大小写敏感盘符」等边界）
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    return { ok: false, code: 'outside_root', message: PATH_REJECT_MESSAGE };
  }

  let linkStat;
  try {
    linkStat = await fsp.lstat(abs);
  } catch (e) {
    return mapFsError(e);
  }
  if (linkStat.isSymbolicLink()) return { ok: false, code: 'symlink', message: PATH_REJECT_MESSAGE };

  const [realRoot, realAbs] = await Promise.all([safeRealpath(rootAbs), safeRealpath(abs)]);
  if (!realRoot || !realAbs) return { ok: false, code: 'not_found', message: NOT_FOUND_MESSAGE };
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) {
    return { ok: false, code: 'symlink', message: PATH_REJECT_MESSAGE };
  }
  return { ok: true, abs, rel };
}

// ── 单层目录枚举（D6）─────────────────────────────────────────────────────

export interface BrowseEntry {
  name: string;
  type: 'dir' | 'file';
  /** 仅 file：字节数（stat 失败时缺省） */
  size?: number;
}

export interface DirListing {
  ok: true;
  /** 请求的相对路径（根为 ''） */
  path: string;
  /** 目录优先 + 大小写不敏感字典序排序后的条目（最多 MAX_DIR_ENTRIES 项） */
  entries: BrowseEntry[];
  /** 过滤（忽略清单 / 符号链接）后的条目总数 */
  total: number;
  /** total > MAX_DIR_ENTRIES */
  truncated: boolean;
}

/** 条目比较：目录优先 → `toLowerCase()` 字典序（跨环境稳定，避免 localeCompare 差异）→ 原串兜底。 */
function compareEntry(a: { name: string; type: 'dir' | 'file' }, b: { name: string; type: 'dir' | 'file' }): number {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  const al = a.name.toLowerCase();
  const bl = b.name.toLowerCase();
  if (al !== bl) return al < bl ? -1 : 1;
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

/**
 * 枚举单层目录：
 * - 符号链接条目**不返回**（沿用既有 collectProjectFiles 的 isSymbolicLink 跳过策略）
 * - 忽略清单只作用于目录；点号目录 / 点号文件照常返回
 * - 排序后截断到前 MAX_DIR_ENTRIES 项，total 仍是过滤后的全量计数
 */
export async function listDir(root: string, relPath = ''): Promise<DirListing | RootResolveFailure> {
  const resolved = await resolveInRoot(root, relPath);
  if (!resolved.ok) return resolved;

  let stat;
  try {
    stat = await fsp.stat(resolved.abs);
  } catch (e) {
    return mapFsError(e);
  }
  if (!stat.isDirectory()) return { ok: false, code: 'invalid_path', message: '该路径不是目录' };

  let dirents;
  try {
    dirents = await fsp.readdir(resolved.abs, { withFileTypes: true });
  } catch (e) {
    return mapFsError(e);
  }

  const items: Array<{ name: string; type: 'dir' | 'file'; abs: string }> = [];
  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) continue;
    if (dirent.isDirectory()) {
      if (isBrowseIgnored(dirent.name)) continue;
      items.push({ name: dirent.name, type: 'dir', abs: path.join(resolved.abs, dirent.name) });
      continue;
    }
    if (!dirent.isFile()) continue;
    items.push({ name: dirent.name, type: 'file', abs: path.join(resolved.abs, dirent.name) });
  }
  items.sort(compareEntry);

  const total = items.length;
  const limited = items.slice(0, MAX_DIR_ENTRIES);
  const entries: BrowseEntry[] = [];
  for (const item of limited) {
    if (item.type === 'dir') {
      entries.push({ name: item.name, type: 'dir' });
      continue;
    }
    const size = await fsp
      .stat(item.abs)
      .then((s) => s.size)
      .catch(() => undefined);
    entries.push(size === undefined ? { name: item.name, type: 'file' } : { name: item.name, type: 'file', size });
  }

  return { ok: true, path: resolved.rel, entries, total, truncated: total > MAX_DIR_ENTRIES };
}

// ── 文件预览读取（D10 / D14 / §9.3）────────────────────────────────────────

export type PreviewKind = 'markdown' | 'text' | 'image' | 'binary' | 'oversize';

export interface FilePreview {
  ok: true;
  /** 工作根相对路径（POSIX） */
  path: string;
  name: string;
  size: number;
  kind: PreviewKind;
  /** ISO 8601 */
  modified_at: string;
  /** markdown | text 的原文 */
  content?: string;
  /** text 的 hljs 语言标识（扩展名映射，未知 → 'plaintext'） */
  language?: string;
  /** image */
  mime?: string;
  data_url?: string;
  /** binary | oversize 的中文降级文案（前端原样展示，避免两端文案漂移） */
  reason?: string;
}

/** 降级文案（§4.2 / D14）。 */
export const OVERSIZE_REASON = '该文件为二进制或超过 1MB 上限，无法预览';
export const BINARY_REASON = '二进制文件，无法预览';

/** 图片扩展名 → MIME（PRD F-38-5：png/jpg/svg/webp/gif）。 */
const IMAGE_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
};

const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown', '.mdx']);

/** 扩展名 → hljs 语言标识（未知 → plaintext）。 */
const LANGUAGE_BY_EXT: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'xml',
  '.htm': 'xml',
  '.vue': 'xml',
  '.xml': 'xml',
  '.svg': 'xml',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.rb': 'ruby',
  '.php': 'php',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.env': 'ini',
  '.sql': 'sql',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdx': 'markdown',
  '.txt': 'plaintext',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.swift': 'swift',
  '.lua': 'lua',
  '.dart': 'dart',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.graphql': 'graphql',
  '.proto': 'protobuf',
  '.dockerfile': 'dockerfile',
  '.log': 'plaintext',
};

/**
 * 读取文件用于面板预览（五分流）：
 * 1. size > 1MB（MAX_SNAPSHOT_BYTES）→ `oversize`（**不读内容**，§9.3：图片同样受限）
 * 2. 图片扩展名 → `image` + base64 data_url（D10：不上二进制流端点）
 *    ⚠️ 必须先于 NUL 探测：PNG/JPEG 头部含 0x00，先探测会把所有真实图片判成 binary
 * 3. 前 8KB 含 NUL → `binary`
 * 4. markdown 扩展名 → `markdown` + 原文
 * 5. 其余文本 → `text` + 原文 + hljs 语言标识
 */
export async function readFileForPreview(
  root: string,
  relPath?: string | null,
): Promise<FilePreview | RootResolveFailure> {
  const resolved = await resolveInRoot(root, relPath);
  if (!resolved.ok) return resolved;

  let stat;
  try {
    stat = await fsp.stat(resolved.abs);
  } catch (e) {
    return mapFsError(e);
  }
  if (stat.isDirectory()) return { ok: false, code: 'invalid_path', message: '该路径不是文件' };

  const name = path.basename(resolved.abs);
  const ext = path.extname(name).toLowerCase();
  const base: FilePreview = {
    ok: true,
    path: resolved.rel,
    name,
    size: stat.size,
    kind: 'text',
    modified_at: stat.mtime.toISOString(),
  };

  if (stat.size > MAX_SNAPSHOT_BYTES) {
    return { ...base, kind: 'oversize', reason: OVERSIZE_REASON };
  }

  let buf: Buffer;
  try {
    buf = await fsp.readFile(resolved.abs);
  } catch (e) {
    return mapFsError(e);
  }

  // 图片判定**必须在 NUL 探测之前**：PNG/JPEG 头部（如 PNG 的 IHDR 长度字段）天然含 0x00 字节，
  // 若按 design §5.2 伪时序「先 NUL 后图片」，任何真实图片都会被误判成 binary（F-38-5 图片直接渲染失效）。
  const mime = IMAGE_MIME[ext];
  if (mime) {
    return { ...base, kind: 'image', mime, data_url: `data:${mime};base64,${buf.toString('base64')}` };
  }

  if (buf.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
    return { ...base, kind: 'binary', reason: BINARY_REASON };
  }

  const content = buf.toString('utf8');
  if (MARKDOWN_EXTENSIONS.has(ext)) {
    return { ...base, kind: 'markdown', language: 'markdown', content };
  }
  return { ...base, kind: 'text', language: LANGUAGE_BY_EXT[ext] ?? 'plaintext', content };
}
