/**
 * 调试与可观测（prompt-design.md §6）
 * - buildDebugReport：导出最终拼装结果（标注各段来源、token 数、缓存命中状态）
 * - 每轮记录 prompt_sections 日志：静态段 hash、命中与否、动态段 token、裁剪明细
 */
import type { AssembleSplitResult } from './split-assembler.js';
import type { FinalPrompt } from './builder.js';
import type { AssembleWarning, PromptSection } from './types.js';

export interface PromptDebugReport {
  /** 静态段缓存指纹与命中状态 */
  staticCache: {
    fingerprint: string;
    hitCount: number;
    createdAt: string;
    tokens: number;
  };
  /** 逐段明细（含来源层级） */
  sections: Array<{
    id: string;
    title: string;
    kind: 'static' | 'dynamic';
    locked: boolean;
    tokens: number;
    preview: string;
    /** 段内容来源（如 expert:code-architect）；无来源为 null */
    source: string | null;
  }>;
  /** 动态段总 token */
  dynamicTokens: number;
  /** 总 token（静态 + 动态） */
  totalTokens: number;
  /** 覆盖告警（locked 层等） */
  warnings: string[];
  /** Builder 裁剪明细 */
  trimLog: FinalPrompt['trimLog'];
  /** 被去重的记忆条目 */
  dedupedMemoryIds: string[];
}

export interface DebugReportInput {
  split: AssembleSplitResult;
  final?: FinalPrompt;
}

export function buildDebugReport(input: DebugReportInput): PromptDebugReport {
  const { split, final } = input;
  const sectionPreview = (s: PromptSection): string => {
    const text = typeof s.value === 'string' ? s.value : JSON.stringify(s.value);
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  };

  return {
    staticCache: {
      fingerprint: split.staticEntry.fingerprint,
      hitCount: split.staticEntry.hits,
      createdAt: new Date(split.staticEntry.createdAt).toISOString(),
      tokens: split.staticEntry.tokens,
    },
    sections: split.sections.map((s) => ({
      id: s.id,
      title: s.title,
      kind: s.kind,
      locked: s.locked,
      tokens: s.tokens,
      preview: sectionPreview(s),
      source: s.source ?? null,
    })),
    dynamicTokens: split.dynamic.tokens,
    totalTokens: split.staticEntry.tokens + split.dynamic.tokens,
    warnings: split.warnings.map(warnText),
    trimLog: final?.trimLog ?? [],
    dedupedMemoryIds: final?.dedupedMemoryIds ?? [],
  };
}

function warnText(w: AssembleWarning): string {
  return `${w.layer}: ${w.message}`;
}

/** 格式化为 CLI 友好文本（--debug-prompt 输出） */
export function formatDebugReport(r: PromptDebugReport): string {
  const lines: string[] = [];
  lines.push('═══ Prompt 调试报告 ═══');
  lines.push(
    `静态缓存: ${r.staticCache.fingerprint.slice(0, 12)}… 命中 ${r.staticCache.hitCount} 次 · 静态 ${r.staticCache.tokens} tok · 动态 ${r.dynamicTokens} tok · 合计 ${r.totalTokens} tok`,
  );
  lines.push('─── 分段明细 ───');
  for (const s of r.sections) {
    const flags = [s.kind, s.locked ? 'locked' : '', `${s.tokens} tok`, s.source ? `source=${s.source}` : '']
      .filter(Boolean)
      .join(' · ');
    lines.push(`[${s.id}] ${s.title}（${flags}）`);
    if (s.preview) lines.push(`  └ ${s.preview.replace(/\n/g, ' ⏎ ')}`);
  }
  if (r.warnings.length > 0) {
    lines.push('─── 覆盖告警 ───');
    for (const w of r.warnings) lines.push(`⚠ ${w}`);
  }
  if (r.trimLog.length > 0) {
    lines.push('─── 裁剪/去重明细 ───');
    for (const t of r.trimLog) {
      lines.push(
        `${t.action === 'dropped' ? '✂' : t.action === 'kept' ? '·' : '⚠'} [${t.section}] ${t.detail ?? ''}${t.tokens !== undefined ? `（${t.tokens} tok）` : ''}`,
      );
    }
  }
  if (r.dedupedMemoryIds.length > 0) {
    lines.push(`去重记忆条目: ${r.dedupedMemoryIds.join(', ')}`);
  }
  return lines.join('\n');
}

/** prompt_sections 结构化日志条目（每轮记录，供调优预算分配） */
export interface PromptSectionsLogEntry {
  turn: number;
  staticHash: string;
  staticCacheHit: boolean;
  staticTokens: number;
  dynamicTokens: number;
  totalTokens: number;
  dropped: string[];
}

export function promptSectionsLog(turn: number, split: AssembleSplitResult, final?: FinalPrompt): PromptSectionsLogEntry {
  return {
    turn,
    staticHash: split.staticEntry.fingerprint,
    staticCacheHit: split.staticEntry.hits > 0,
    staticTokens: split.staticEntry.tokens,
    dynamicTokens: split.dynamic.tokens,
    totalTokens: (final?.tokens ?? split.staticEntry.tokens + split.dynamic.tokens),
    dropped: (final?.trimLog ?? []).filter((t) => t.action === 'dropped').map((t) => t.section),
  };
}
