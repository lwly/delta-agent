import { describe, expect, it } from 'vitest';
import { diffLines, compactDiff, DIFF_MAX_LINES } from '../src/diff/lines.js';

describe('diffLines', () => {
  it('marks adds / dels / context', () => {
    const d = diffLines('a\nb\nc', 'a\nB\nc\nd');
    expect(d).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'ctx', text: 'c' },
      { type: 'add', text: 'd' },
    ]);
  });

  it('pure insertion and pure deletion', () => {
    expect(diffLines('a\nb', 'a\nb\nc').filter((l) => l.type === 'add')).toEqual([{ type: 'add', text: 'c' }]);
    expect(diffLines('a\nb\nc', 'a\nc').filter((l) => l.type === 'del')).toEqual([{ type: 'del', text: 'b' }]);
  });

  it('handles empty inputs', () => {
    expect(diffLines('', 'x')).toEqual([{ type: 'add', text: 'x' }]);
    expect(diffLines('x', '')).toEqual([{ type: 'del', text: 'x' }]);
    expect(diffLines('', '')).toEqual([]);
  });

  it('degrades to placeholder for oversized files', () => {
    const big = Array.from({ length: DIFF_MAX_LINES + 1 }, (_, i) => `line${i}`).join('\n');
    const d = diffLines(big, 'new');
    expect(d).toHaveLength(1);
    expect(d[0]!.type).toBe('ctx');
    expect(d[0]!.text).toContain('省略');
  });

  it('prefers contiguous hunks (edit in middle)', () => {
    const d = diffLines('1\n2\n3\n4\n5', '1\n2\nX\n4\n5');
    const changed = d.filter((l) => l.type !== 'ctx');
    expect(changed).toEqual([{ type: 'del', text: '3' }, { type: 'add', text: 'X' }]);
  });
});

describe('compactDiff', () => {
  it('keeps changed lines with ±2 context lines', () => {
    const lines = diffLines('1\n2\n3\n4\n5\n6\n7\n8\n9\n10', '1\n2\n3\n4\n5\n6\n7\n8\n9\nX');
    const c = compactDiff(lines, 40);
    expect(c.some((l) => l.type === 'add' && l.text === 'X')).toBe(true);
    // 上下文行不超过变更行附近 2 行：首行 '1' 不应出现
    expect(c.some((l) => l.type === 'ctx' && l.text === '1')).toBe(false);
    expect(c.some((l) => l.type === 'ctx' && l.text === '8')).toBe(true);
  });

  it('collapses skipped runs into single ellipsis and truncates to maxLines', () => {
    const lines: Array<{ type: 'ctx'; text: string }> = Array.from({ length: 100 }, (_, i) => ({
      type: 'ctx' as const,
      text: `c${i}`,
    }));
    lines[50] = { type: 'add', text: 'NEW' };
    const c = compactDiff(lines, 10);
    expect(c.length).toBeLessThanOrEqual(10);
    // 变更行前后各有一段被省略 → 两个省略占位
    expect(c.filter((l) => l.text === '…')).toHaveLength(2);
    expect(c.some((l) => l.type === 'add')).toBe(true);
  });

  it('returns everything when under budget', () => {
    const lines = diffLines('a', 'a\nb');
    expect(compactDiff(lines, 40)).toEqual(lines);
  });
});
