/**
 * F-36 CLI TUI 细节 —— 行级 diff 生成：
 * 对 edit_file/write_file 落库的 before/after 快照做 LCS 行对比，
 * 产出带类型的行序列供 UI 彩色渲染（- 红 / + 绿 / 上下文暗色）。
 * 零依赖（不引 diff npm 包）；输入侧有行数上限保护，防止超大文件拖垮 UI。
 */

export type DiffLineType = 'add' | 'del' | 'ctx';

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/** 单侧输入的最大行数（超过则整体降级为占位提示，避免 O(n·m) 爆内存） */
export const DIFF_MAX_LINES = 2000;

/** 渲染侧建议的最大输出行数（由调用方截断，超出部分标记省略） */
export const DIFF_MAX_RENDER_LINES = 40;

/**
 * 行级 diff（LCS）。任一侧超过 DIFF_MAX_LINES 行时返回单行占位，
 * 保证超大文件（如 minified js）不会把 TUI 卡死。
 */
export function diffLines(before: string, after: string): DiffLine[] {
  // 空串视为 0 行（'' 与 'x' 的 diff 是纯新增，而不是「删掉一个空行」）
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
    return [{ type: 'ctx', text: `（文件超过 ${DIFF_MAX_LINES} 行，省略逐行 diff）` }];
  }

  // LCS 长度表（滚动数组省内存）
  const m = a.length;
  const n = b.length;
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: 'ctx', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: 'del', text: a[i]! });
      i++;
    } else {
      out.push({ type: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < m) out.push({ type: 'del', text: a[i++]! });
  while (j < n) out.push({ type: 'add', text: b[j++]! });
  return out;
}

/** 合并相邻同类行为 unified 风格片段，并把输出截断到 maxLines（默认 DIFF_MAX_RENDER_LINES）。 */
export function compactDiff(lines: DiffLine[], maxLines: number = DIFF_MAX_RENDER_LINES): DiffLine[] {
  const changed = lines.filter((l) => l.type !== 'ctx');
  const ctxBudget = Math.max(0, maxLines - changed.length);
  // 上下文行只保留变更行附近各 2 行
  const keep = new Set<number>();
  let ctxUsed = 0;
  lines.forEach((l, idx) => {
    if (l.type !== 'ctx') {
      keep.add(idx);
      for (const d of [-2, -1, 1, 2]) {
        const k = idx + d;
        if (k >= 0 && k < lines.length && lines[k]!.type === 'ctx' && ctxUsed < ctxBudget) {
          if (!keep.has(k)) {
            keep.add(k);
            ctxUsed++;
          }
        }
      }
    }
  });
  const out: DiffLine[] = [];
  let skipped = false;
  lines.forEach((l, idx) => {
    if (keep.has(idx)) {
      out.push(l);
      skipped = false;
    } else if (!skipped) {
      out.push({ type: 'ctx', text: '…' });
      skipped = true; // 连续省略只留一个占位
    }
  });
  if (out.length > maxLines) {
    return [...out.slice(0, maxLines - 1), { type: 'ctx', text: `…（其余 ${out.length - maxLines + 1} 行省略）` }];
  }
  return out;
}
