/**
 * F-38 工作区变更统计 + 单文件 diff（**git 口径**）
 *
 * ⚠️ 与 `session/changes.ts` 同名不同层：那边是「会话写操作快照口径」（SQLite file_changes），
 * 这边是「工作区 vs HEAD 的 git 口径」（`git status` + `git diff HEAD`），两者无关，勿混用。
 *
 * 设计：docs/design-f38-project-file-panel.md（D7 / D8 / §4.7 / §8.5-8.8）
 * - 变更清单 = `git status --porcelain=v1 -z -uall`（清单与类型）
 *   + `git diff HEAD -M --numstat -z`（行数；一次覆盖已暂存 + 未暂存，无需 --cached 再求和）
 * - 未跟踪文件读盘数行；二进制 `-` → 0 且 binary=true；删除行数取自 numstat 真实值
 * - 单文件 diff = `git diff HEAD -M -- ":(literal)<rel>"`（`:(literal)` 关闭通配）
 *   - 未跟踪 → 服务端合成「全新增」行
 *   - 无 HEAD → 退化为 `git diff --cached`
 *
 * 两个硬约束（violation = bug）：
 * 1. **stdout 绝不 trim**：porcelain `-z` 的 ` M a.txt` 前导空格就是 XY 字段本身，
 *    trim 会把「工作区修改」误判成「index 修改」。
 *    —— 已确认 `engine/shell.ts` 的 `runWithShell` **原样返回** spawn 累积的 stdout（内部无 trim），
 *    故这里直接复用 runWithShell（15s 超时 + ShellAdapter 跨平台），无需绕到 execFile。
 * 2. **porcelain 路径是「仓库根相对」**：工作根是仓库子目录时必须按 `rev-parse --show-prefix`
 *    剥前缀，否则全错一层；不匹配 prefix 的条目属于根外改动，直接丢弃。
 *
 * 本模块**只读**：只调用 git 的读命令（status / diff / rev-parse / ls-files），不出现 add|commit|checkout。
 */
import { promises as fsp } from 'node:fs';
import { runWithShell } from '../engine/shell.js';
import { MAX_SNAPSHOT_BYTES } from '../session/changes.js';
import {
  buildAllAddedRows,
  parseUnifiedDiff,
  type DiffRow,
} from './patch.js';
import { resolveInRoot } from './browse.js';

/** git 调用超时（§8.5：与 WorktreeManager / GitIntegration 同口径）。 */
const GIT_TIMEOUT_MS = 15_000;
/** 超时 → 200 业务态 reason（不返回 500）。 */
export const GIT_TIMEOUT_REASON = 'git 超时（15s）';
/** 非 git 目录 → 200 业务态 reason。 */
export const NOT_A_REPO_REASON = '当前目录不是 git 仓库，无法查看变更';

/** 变更清单文件数上限（PRD §6）。 */
export const MAX_CHANGE_FILES = 300;

/** 二进制探测窗口（沿用 session/changes.ts 的 readSnapshot 口径）。 */
const BINARY_PROBE_BYTES = 8192;

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflict';

export interface ChangeFile {
  /** 工作根相对路径（POSIX）；改名取新路径 */
  path: string;
  status: ChangeStatus;
  added: number;
  removed: number;
  binary: boolean;
  /** 改名前的路径（P0 UI 不展示，留 P1） */
  orig_path: string | null;
}

export interface ChangesResult {
  ok: boolean;
  reason?: string;
  is_repo: boolean;
  files: ChangeFile[];
  /** 全量合计（含被 300 截断的部分） */
  totals: { added: number; removed: number };
  total_files: number;
  /** truncated = total_files > MAX_CHANGE_FILES */
  truncated: boolean;
}

export interface FileDiffResult {
  ok: boolean;
  reason?: string;
  path: string;
  status: ChangeStatus;
  binary: boolean;
  truncated: boolean;
  added: number;
  removed: number;
  rows: DiffRow[];
  /** 无 HEAD 的仓库（首个提交前） */
  head_missing?: boolean;
}

// ── git 调用薄封装 ─────────────────────────────────────────────────────────

interface GitRawResult {
  ok: boolean;
  /** ⚠️ 原样 stdout（不 trim） */
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * shell 引号包装（与 git/repo.ts、git/worktree.ts 同口径：单引号 + 内部单引号转义）。
 * runWithShell 经 shell 执行命令行，路径必须引号包装（含空格 / 通配符的文件名安全）。
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** git pathspec：`:(literal)` 关闭通配（文件名含 `*` / `?` 不会误匹配）。 */
function literalPathspec(relPath: string): string {
  return shellQuote(`:(literal)${relPath}`);
}

async function gitRaw(args: string, cwd: string, signal: AbortSignal): Promise<GitRawResult> {
  try {
    const r = await runWithShell(`git ${args}`, cwd, GIT_TIMEOUT_MS, signal);
    // ⚠️ 关键：stdout 绝不做 trim —— porcelain -z 的 ' M a.txt' 前导空格是 XY 字段。
    return { ok: r.code === 0 && !r.timedOut, stdout: r.stdout, stderr: r.stderr.trim(), timedOut: r.timedOut };
  } catch (e) {
    // runWithShell 自身不 throw，此处仅防御性兜底（spawn 异常已被内部捕获）
    return { ok: false, stdout: '', stderr: (e as Error).message, timedOut: false };
  }
}

// ── porcelain / numstat 解析（§4.7 伪代码）─────────────────────────────────

interface StatusEntry {
  xy: string;
  path: string;
  origPath: string | null;
}

interface NumStat {
  added: number;
  removed: number;
  binary: boolean;
}

/** `rev-parse --show-prefix` 输出 → 统一带尾部 '/' 的前缀（根为 ''）。 */
function normalizePrefix(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

/** porcelain 路径（仓库根相对）→ 工作根相对；不在根内返回 null（属于根外改动）。 */
function stripPrefix(repoRelative: string, prefix: string): string | null {
  if (!prefix) return repoRelative;
  if (repoRelative === prefix.replace(/\/$/, '')) return '';
  if (repoRelative.startsWith(prefix)) return repoRelative.slice(prefix.length);
  return null;
}

/**
 * 解析 `git status --porcelain=v1 -z`：
 * - token 形如 `XY <path>`（两位 XY + 空格 + 路径）；**首字符可能是空格**
 * - `-z` 下改名/复制是 **新路径在前、旧路径在后**（与 numstat 相反），旧路径占紧随的一个 token
 */
export function parseStatusEntries(stdout: string, prefix = ''): StatusEntry[] {
  const tokens = stdout.split('\u0000');
  const out: StatusEntry[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (token.length < 4) continue; // 末尾空串 / 残缺 token
    if (token[2] !== ' ') continue;
    const xy = token.slice(0, 2);
    const rawPath = token.slice(3);
    const isRename = xy[0] === 'R' || xy[1] === 'R' || xy[0] === 'C' || xy[1] === 'C';
    let rawOrig: string | null = null;
    if (isRename) {
      rawOrig = tokens[i + 1] ?? null;
      i += 1;
    }
    const rel = stripPrefix(rawPath, prefix);
    if (rel === null) continue; // 根外改动
    const origRel = rawOrig === null ? null : stripPrefix(rawOrig, prefix);
    out.push({ xy, path: rel, origPath: origRel });
  }
  return out;
}

/**
 * 解析 `git diff … --numstat -z`：
 * - token 命中 `add\tdel\tpath`；add/del 为 `-` → binary（0/0 + binary=true）
 * - 第三段为空串 = 改名/复制记录：紧随两个 token = **旧路径、新路径**（与 status 顺序相反）
 * - key 统一取**新路径**（剥 prefix 后）
 */
export function parseNumstat(stdout: string, prefix = ''): Map<string, NumStat> {
  const tokens = stdout.split('\u0000');
  const map = new Map<string, NumStat>();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(token);
    if (!m) continue;
    const binary = m[1] === '-' || m[2] === '-';
    const added = binary ? 0 : Number(m[1]);
    const removed = binary ? 0 : Number(m[2]);
    let rawTarget = m[3] ?? '';
    if (rawTarget === '') {
      rawTarget = tokens[i + 2] ?? ''; // 旧路径在前、新路径在后
      i += 2;
    }
    if (!rawTarget) continue;
    const key = stripPrefix(rawTarget, prefix);
    if (key === null) continue;
    map.set(key, { added, removed, binary });
  }
  return map;
}

/** porcelain XY → 面板 ChangeStatus（优先级：未跟踪 > 冲突 > 改名 > 删除 > 新增 > 修改）。 */
export function normalizeStatus(xy: string): ChangeStatus {
  if (xy === '??') return 'untracked';
  const x = xy[0] ?? ' ';
  const y = xy[1] ?? ' ';
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'conflict';
  if (x === 'R' || y === 'R' || x === 'C' || y === 'C') return 'renamed';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'A') return 'added';
  return 'modified';
}

/** 未跟踪文件读盘数行（≤1MB；前 8KB 含 NUL → binary；结尾换行不计行）。 */
async function countUntrackedLines(root: string, relPath: string): Promise<NumStat> {
  const zero: NumStat = { added: 0, removed: 0, binary: false };
  const resolved = await resolveInRoot(root, relPath);
  if (!resolved.ok) return zero;
  let stat;
  try {
    stat = await fsp.stat(resolved.abs);
  } catch {
    return zero;
  }
  if (!stat.isFile()) return zero;
  if (stat.size > MAX_SNAPSHOT_BYTES) return { added: 0, removed: 0, binary: true };
  let buf: Buffer;
  try {
    buf = await fsp.readFile(resolved.abs);
  } catch {
    return zero;
  }
  if (buf.subarray(0, BINARY_PROBE_BYTES).includes(0)) return { added: 0, removed: 0, binary: true };
  const text = buf.toString('utf8');
  if (text === '') return zero;
  const lines = text.split('\n');
  const added = text.endsWith('\n') ? lines.length - 1 : lines.length;
  return { added, removed: 0, binary: false };
}

/** 稳定排序：path 小写字典序 → 原串兜底。 */
function compareChangeFile(a: ChangeFile, b: ChangeFile): number {
  const al = a.path.toLowerCase();
  const bl = b.path.toLowerCase();
  if (al !== bl) return al < bl ? -1 : 1;
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}

// ── 对外接口 ───────────────────────────────────────────────────────────────

/**
 * 工作区变更清单（`git status` 口径，含未跟踪）：
 * - 非 git 目录 → `{ ok: true, is_repo: false, reason }`（业务态，HTTP 仍 200）
 * - git 失败 / 超时 → `{ ok: false, is_repo: true, reason }`（业务态）
 * - 行数合并：status 提供清单与类型，numstat 提供真实增删（改名取 numstat 真实值而非 0/0）
 */
export async function listWorkspaceChanges(root: string, signal?: AbortSignal): Promise<ChangesResult> {
  const ac = signal ?? new AbortController().signal;
  const empty: ChangesResult = {
    ok: true,
    is_repo: true,
    files: [],
    totals: { added: 0, removed: 0 },
    total_files: 0,
    truncated: false,
  };

  const repoProbe = await gitRaw('rev-parse --is-inside-work-tree', root, ac);
  if (repoProbe.timedOut) return { ...empty, ok: false, reason: GIT_TIMEOUT_REASON };
  if (!repoProbe.ok || repoProbe.stdout.trim() !== 'true') {
    return { ...empty, is_repo: false, reason: NOT_A_REPO_REASON };
  }

  // 工作根可能是仓库子目录：porcelain 路径是仓库根相对，必须剥前缀
  const prefixProbe = await gitRaw('rev-parse --show-prefix', root, ac);
  const prefix = prefixProbe.ok ? normalizePrefix(prefixProbe.stdout) : '';
  // 无 HEAD（首个提交前）：改用 --cached 覆盖 index 与 HEAD 的差异
  const hasHead = (await gitRaw('rev-parse --verify HEAD', root, ac)).ok;

  const statusResult = await gitRaw('status --porcelain=v1 -z -uall', root, ac);
  if (statusResult.timedOut) return { ...empty, ok: false, reason: GIT_TIMEOUT_REASON };
  if (!statusResult.ok) {
    return { ...empty, ok: false, reason: statusResult.stderr || 'git status 失败' };
  }

  const numstatCmd = hasHead ? 'diff HEAD -M --numstat -z' : 'diff --cached -M --numstat -z';
  const numstatResult = await gitRaw(numstatCmd, root, ac);
  if (numstatResult.timedOut) return { ...empty, ok: false, reason: GIT_TIMEOUT_REASON };
  const stats = numstatResult.ok ? parseNumstat(numstatResult.stdout, prefix) : new Map<string, NumStat>();

  const entries = parseStatusEntries(statusResult.stdout, prefix);
  // 未跟踪文件需要读盘数行：并发处理（顺序 await 在数百个未跟踪文件时会拖到秒级）
  const files = await Promise.all(
    entries.map(async (entry): Promise<ChangeFile> => {
      const status = normalizeStatus(entry.xy);
      const hit = stats.get(entry.path);
      if (hit) {
        return {
          path: entry.path,
          status,
          added: hit.added,
          removed: hit.removed,
          binary: hit.binary,
          orig_path: entry.origPath,
        };
      }
      if (status !== 'untracked') {
        return { path: entry.path, status, added: 0, removed: 0, binary: false, orig_path: entry.origPath };
      }
      const counted = await countUntrackedLines(root, entry.path);
      return {
        path: entry.path,
        status,
        added: counted.added,
        removed: 0,
        binary: counted.binary,
        orig_path: entry.origPath,
      };
    }),
  );
  files.sort(compareChangeFile);

  const totals = files.reduce(
    (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }),
    { added: 0, removed: 0 },
  );

  return {
    ok: true,
    is_repo: true,
    files: files.slice(0, MAX_CHANGE_FILES),
    totals,
    total_files: files.length,
    truncated: files.length > MAX_CHANGE_FILES,
  };
}

/**
 * 单文件 unified diff：
 * - 已跟踪：`git diff HEAD -M -- ":(literal)<rel>"`；无 HEAD → `git diff --cached`
 * - 未跟踪：读盘（≤1MB）→ `buildAllAddedRows` 合成「全新增」行
 * - 二进制：rows 空 + binary=true + reason
 * - 截断：rows 前 2000 行 / 256KB + truncated=true + reason
 * 失败一律 `{ ok: false, reason }`（HTTP 层仍返回 200 业务态，不抛 500）。
 */
export async function readFileDiff(
  root: string,
  relPath: string,
  signal?: AbortSignal,
): Promise<FileDiffResult> {
  const ac = signal ?? new AbortController().signal;
  const target = String(relPath ?? '');
  const base: FileDiffResult = {
    ok: false,
    path: target,
    status: 'modified',
    binary: false,
    truncated: false,
    added: 0,
    removed: 0,
    rows: [],
  };
  if (!target) return { ...base, reason: '缺少 path 参数' };

  const hasHead = (await gitRaw('rev-parse --verify HEAD', root, ac)).ok;

  // 单文件状态（literal pathspec 关闭通配；同时可以判定未跟踪）
  const statusResult = await gitRaw(`status --porcelain=v1 -z -- ${literalPathspec(target)}`, root, ac);
  if (statusResult.timedOut) return { ...base, reason: GIT_TIMEOUT_REASON };

  let status: ChangeStatus = 'modified';
  let untracked = false;
  if (statusResult.ok) {
    const first = statusResult.stdout.split('\u0000')[0] ?? '';
    if (first.length >= 4 && first[2] === ' ') {
      status = normalizeStatus(first.slice(0, 2));
      untracked = first.slice(0, 2) === '??';
    }
  }

  if (untracked) {
    const resolved = await resolveInRoot(root, target);
    if (!resolved.ok) return { ...base, status: 'untracked', reason: resolved.message };
    let stat;
    try {
      stat = await fsp.stat(resolved.abs);
    } catch {
      return { ...base, status: 'untracked', reason: '文件已不存在，可能已被删除或移动' };
    }
    if (!stat.isFile()) return { ...base, status: 'untracked', reason: '该路径不是文件' };
    // 1MB 上限与预览同口径（§9.3）：超大未跟踪文件不整文件读入内存
    if (stat.size > MAX_SNAPSHOT_BYTES) {
      return {
        ...base,
        ok: true,
        status: 'untracked',
        truncated: true,
        reason: '文件超过 1MB 上限，未生成 diff（请在终端查看）',
      };
    }
    let buf: Buffer;
    try {
      buf = await fsp.readFile(resolved.abs);
    } catch {
      return { ...base, status: 'untracked', reason: '文件已不存在，可能已被删除或移动' };
    }
    if (buf.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
      return {
        ...base,
        ok: true,
        status: 'untracked',
        binary: true,
        reason: '二进制文件无法显示 diff',
      };
    }
    const parsed = buildAllAddedRows(buf.toString('utf8'));
    const out: FileDiffResult = {
      ok: true,
      path: target,
      status: 'untracked',
      binary: false,
      truncated: parsed.truncated,
      added: parsed.added,
      removed: 0,
      rows: parsed.rows,
    };
    if (parsed.truncated) out.reason = 'diff 过大已截断，建议在终端查看';
    if (!hasHead) out.head_missing = true;
    return out;
  }

  const diffCmd = hasHead
    ? `diff HEAD -M -- ${literalPathspec(target)}`
    : `diff --cached -M -- ${literalPathspec(target)}`;
  const diffResult = await gitRaw(diffCmd, root, ac);
  if (diffResult.timedOut) return { ...base, status, reason: GIT_TIMEOUT_REASON };
  if (!diffResult.ok) return { ...base, status, reason: diffResult.stderr || 'git diff 失败' };

  const raw = diffResult.stdout;
  // 二进制：git 只给 "Binary files … differ"，没有任何 hunk
  if (/^Binary files .+ differ$/m.test(raw) && !/^@@ /m.test(raw)) {
    return {
      ...base,
      ok: true,
      status,
      binary: true,
      reason: '二进制文件无法显示 diff',
    };
  }

  const parsed = parseUnifiedDiff(raw);
  const out: FileDiffResult = {
    ok: true,
    path: target,
    status,
    binary: false,
    truncated: parsed.truncated,
    added: parsed.added,
    removed: parsed.removed,
    rows: parsed.rows,
  };
  if (parsed.truncated) out.reason = 'diff 过大已截断，建议在终端查看';
  if (!hasHead) out.head_missing = true;
  return out;
}
