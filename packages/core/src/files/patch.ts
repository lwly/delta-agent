/**
 * F-38 unified diff 解析 / 截断（纯函数，零 IO）
 *
 * 设计：docs/design-f38-project-file-panel.md（D9 / §3.1）
 * - 解析与截断都在 core 完成：浏览器不会先拿到 300KB 原文再丢掉；行号由服务端一次算好
 *   （多 hunk 非连续，前端用 CSS counter 会算错）
 * - 截断口径：行数 DIFF_MAX_ROWS / 字节 DIFF_MAX_BYTES，先到者生效
 * - 本模块不依赖任何 node 内置模块，可直接单测、后续 CLI 复用
 */

export type DiffRowType = 'hunk' | 'add' | 'del' | 'ctx';

export interface DiffRow {
  type: DiffRowType;
  /** 旧文件行号（hunk / add 为 null） */
  old_no: number | null;
  /** 新文件行号（hunk / del 为 null） */
  new_no: number | null;
  /** 不含行首标记（' ' / '+' / '-'）的正文；hunk 行为完整 `@@ … @@` 头 */
  text: string;
}

export interface ParsedPatch {
  rows: DiffRow[];
  truncated: boolean;
  /** 输出行中新增行数（buildAllAddedRows 为整文件新增行数） */
  added: number;
  /** 输出行中删除行数 */
  removed: number;
}

/** diff 输出行上限。 */
export const DIFF_MAX_ROWS = 2000;
/** diff 原文字节上限（256KB）。 */
export const DIFF_MAX_BYTES = 256 * 1024;

/** unified diff 的无意义头部（diff --git / index / --- / +++ / mode / rename / binary 提示行）。 */
const HEADER_PREFIXES: readonly string[] = [
  'diff --git ',
  'index ',
  'old mode ',
  'new mode ',
  'deleted file mode ',
  'new file mode ',
  'similarity index ',
  'dissimilarity index ',
  'rename from ',
  'rename to ',
  'copy from ',
  'copy to ',
  'Binary files ',
  'GIT binary patch',
];

/** 字节长度（不依赖 Buffer：纯函数保持零依赖）。 */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x7f) bytes += 1;
    else if (cp <= 0x7ff) bytes += 2;
    else if (cp <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/** 解析 hunk 头 `@@ -a,b +c,d @@`（b/d 省略视为 1）→ 起始行号。 */
function parseHunkStart(line: string): { oldStart: number; newStart: number } | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) return null;
  return { oldStart: Number(m[1]), newStart: Number(m[3]) };
}

/**
 * unified diff 原文 → 结构化行。
 * - 丢弃文件级头部（diff --git / index / --- / +++ / mode / rename / binary 提示）
 * - 只保留第一个文件之前？**不**：多文件 patch 也照常解析（调用方按单文件取用）
 * - hunk 头保留原样文本（前端直接展示）；`\ No newline at end of file` 丢弃
 * - 超 DIFF_MAX_ROWS 或 DIFF_MAX_BYTES → truncated=true，返回前 N 行
 */
export function parseUnifiedDiff(raw: string): ParsedPatch {
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let truncated = false;

  if (!raw) return { rows, truncated: false, added: 0, removed: 0 };

  const lines = raw.split('\n');
  let bytes = 0;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (const line of lines) {
    const lineBytes = utf8Length(line) + 1; // +1 = 换行符（估算口径，稳定即可）
    if (rows.length >= DIFF_MAX_ROWS || bytes + lineBytes > DIFF_MAX_BYTES) {
      truncated = true;
      break;
    }
    if (line === '') continue; // 尾部空行 / 文件间空行

    if (line.startsWith('@@')) {
      const start = parseHunkStart(line);
      if (!start) continue;
      oldNo = start.oldStart;
      newNo = start.newStart;
      inHunk = true;
      bytes += lineBytes;
      rows.push({ type: 'hunk', old_no: null, new_no: null, text: line });
      continue;
    }

    if (!inHunk) {
      // hunk 之前的文件级头部：丢弃
      if (HEADER_PREFIXES.some((p) => line.startsWith(p))) continue;
      if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
      if (line.startsWith('\\')) continue;
      // 未识别的行（极端 patch 形态）静默忽略，避免污染行号
      continue;
    }

    if (line.startsWith('\\')) continue; // \ No newline at end of file
    if (line.startsWith('--- ')) continue; // 多文件 patch 的下一个文件头
    if (line.startsWith('+++ ')) continue;
    if (HEADER_PREFIXES.some((p) => line.startsWith(p))) {
      inHunk = false;
      continue;
    }

    const marker = line[0];
    const text = line.slice(1);
    if (marker === '+') {
      bytes += lineBytes;
      rows.push({ type: 'add', old_no: null, new_no: newNo, text });
      newNo += 1;
      added += 1;
      continue;
    }
    if (marker === '-') {
      bytes += lineBytes;
      rows.push({ type: 'del', old_no: oldNo, new_no: null, text });
      oldNo += 1;
      removed += 1;
      continue;
    }
    if (marker === ' ') {
      bytes += lineBytes;
      rows.push({ type: 'ctx', old_no: oldNo, new_no: newNo, text });
      oldNo += 1;
      newNo += 1;
      continue;
    }
    // 其它（例如 hunk 内容里的空行未带前缀）：按上下文行处理，保持行号连续
    bytes += lineBytes;
    rows.push({ type: 'ctx', old_no: oldNo, new_no: newNo, text: line });
    oldNo += 1;
    newNo += 1;
  }

  return { rows, truncated, added, removed };
}

/**
 * 未跟踪文件 → 「全新增」结构化行（D8：未跟踪文件由服务端合成，复用同一套上限与解析）。
 * - 空文件 → rows 为空
 * - 首行 hunk 头固定 `@@ -0,0 +1,N @@`
 * - 二进制判定由调用方用「前 8KB 含 NUL」完成（本函数纯文本，不做探测）
 * - `added` 恒为整文件行数（不受截断影响），`removed` 恒 0
 */
export function buildAllAddedRows(text: string): ParsedPatch {
  if (!text) return { rows: [], truncated: false, added: 0, removed: 0 };

  const lines = text.split('\n');
  // 结尾换行不算一行（与 `wc -l` 口径一致）
  if (text.endsWith('\n')) lines.pop();
  const total = lines.length;
  if (total === 0) return { rows: [], truncated: false, added: 0, removed: 0 };

  const rows: DiffRow[] = [{ type: 'hunk', old_no: null, new_no: null, text: `@@ -0,0 +1,${total} @@` }];
  let bytes = utf8Length(rows[0]!.text) + 1;
  let truncated = false;
  for (let i = 0; i < total; i += 1) {
    const text = lines[i]!;
    const lineBytes = utf8Length(text) + 1;
    if (rows.length >= DIFF_MAX_ROWS || bytes + lineBytes > DIFF_MAX_BYTES) {
      truncated = true;
      break;
    }
    bytes += lineBytes;
    rows.push({ type: 'add', old_no: null, new_no: i + 1, text });
  }
  return { rows, truncated, added: total, removed: 0 };
}
