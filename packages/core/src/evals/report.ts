/**
 * F-28 Evals —— 报告与回归对比。
 *
 * - renderSuiteRun：单次运行 → Markdown 报告（逐用例表 + 汇总）
 * - renderComparison：多次运行（多 Provider / 多模型）→ 横向对比表
 * - 基线（saveBaseline / loadBaseline / compareBaseline）：回归保护 ——
 *   逐用例对比 pass→fail 视为回归，任意回归即判不通过（供 CI 退出码）。
 */
import * as fs from 'node:fs';
import type { CaseResult, SuiteRun } from './types.js';

// ── 单次运行报告 ────────────────────────────────────────────────────────────

function fmtCost(usd: number): string {
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

function verdictIcon(r: CaseResult): string {
  return r.passed ? '✅' : '❌';
}

export function renderSuiteRun(run: SuiteRun): string {
  const lines: string[] = [];
  lines.push(`## Evals 报告：${run.suite}`);
  lines.push('');
  lines.push(`- Provider：\`${run.provider}\` · 模型：\`${run.model}\``);
  lines.push(`- 时间：${run.startedAt} · 总耗时 ${(run.durationMs / 1000).toFixed(1)}s`);
  lines.push(
    `- 通过率：**${run.summary.passed}/${run.summary.total}（${(run.summary.passRate * 100).toFixed(0)}%）** · ` +
      `轮次均值 ${run.summary.avgTurns.toFixed(1)} · 费用合计 ${fmtCost(run.summary.totalCostUsd)}`,
  );
  lines.push('');
  lines.push('| 用例 | 判定 | 状态 | 轮次 | 工具 | Tokens | 费用 | 未通过项 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of run.results) {
    lines.push(
      `| ${r.caseId} ${verdictIcon(r)} | ${r.passed ? '通过' : '失败'} | ${r.status} | ${r.turns} | ${r.toolCalls} | ` +
        `${r.usage.inputTokens}/${r.usage.outputTokens} | ${fmtCost(r.usage.costUsd)} | ` +
        `${r.failures.length === 0 ? '—' : r.failures.join('；').replace(/\|/g, '\\|')} |`,
    );
  }
  const failed = run.results.filter((r) => !r.passed);
  if (failed.length > 0) {
    lines.push('');
    lines.push('### 失败用例详情');
    for (const r of failed) {
      lines.push('');
      lines.push(`**${r.caseId}（${r.title}）**`);
      if (r.resultExcerpt) {
        lines.push('');
        lines.push('> 结果摘录：' + r.resultExcerpt.replace(/\n/g, ' '));
      }
    }
  }
  return lines.join('\n');
}

// ── 多 Provider 横向对比 ────────────────────────────────────────────────────

export function renderComparison(runs: SuiteRun[]): string {
  if (runs.length === 0) return '（无运行结果）';
  const suite = runs[0]!.suite;
  const lines: string[] = [];
  lines.push(`## Evals 横向对比：${suite}`);
  lines.push('');
  lines.push('| Provider | 模型 | 通过率 | 轮次均值 | 输入 Tokens | 输出 Tokens | 费用 | 总耗时 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of runs) {
    lines.push(
      `| \`${r.provider}\` | \`${r.model}\` | ${r.summary.passed}/${r.summary.total}（${(r.summary.passRate * 100).toFixed(0)}%） | ` +
        `${r.summary.avgTurns.toFixed(1)} | ${r.summary.totalInputTokens} | ${r.summary.totalOutputTokens} | ` +
        `${fmtCost(r.summary.totalCostUsd)} | ${(r.durationMs / 1000).toFixed(1)}s |`,
    );
  }
  // 最佳维度标注（通过率最高优先，其次费用最低）
  const best = [...runs].sort(
    (a, b) => b.summary.passRate - a.summary.passRate || a.summary.totalCostUsd - b.summary.totalCostUsd,
  )[0]!;
  lines.push('');
  lines.push(`> 综合最优：\`${best.provider}\`（${best.model}）—— 通过率 ${(best.summary.passRate * 100).toFixed(0)}%，费用 ${fmtCost(best.summary.totalCostUsd)}`);
  return lines.join('\n');
}

// ── 基线（回归保护）────────────────────────────────────────────────────────

export interface BaselineFile {
  suite: string;
  provider: string;
  model: string;
  savedAt: string;
  /** 逐用例通过状态（回归对比键：caseId → passed） */
  cases: Record<string, boolean>;
  summary: { passRate: number; totalCostUsd: number; avgTurns: number };
}

export function buildBaseline(run: SuiteRun): BaselineFile {
  return {
    suite: run.suite,
    provider: run.provider,
    model: run.model,
    savedAt: new Date().toISOString(),
    cases: Object.fromEntries(run.results.map((r) => [r.caseId, r.passed])),
    summary: {
      passRate: run.summary.passRate,
      totalCostUsd: run.summary.totalCostUsd,
      avgTurns: run.summary.avgTurns,
    },
  };
}

export function saveBaseline(file: string, run: SuiteRun): void {
  fs.mkdirSync(file.replace(/[/\\][^/\\]+$/, ''), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(buildBaseline(run), null, 2) + '\n', 'utf8');
}

export function loadBaseline(file: string): BaselineFile {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as BaselineFile;
}

export interface BaselineComparison {
  /** true = 无回归（新用例/改进不拦截） */
  ok: boolean;
  /** 基线通过 → 本次失败 */
  regressions: Array<{ caseId: string; title: string; failures: string[] }>;
  /** 基线失败 → 本次通过 */
  improvements: Array<{ caseId: string; title: string }>;
  /** 本次新增（基线没有）与已移除的用例 */
  added: string[];
  removed: string[];
  summaryDelta: { passRate: number; costUsd: number; avgTurns: number };
}

export function compareBaseline(current: SuiteRun, baseline: BaselineFile): BaselineComparison {
  const regressions: BaselineComparison['regressions'] = [];
  const improvements: BaselineComparison['improvements'] = [];
  const currentIds = new Set(current.results.map((r) => r.caseId));
  const added: string[] = [];
  const removed: string[] = [];

  for (const r of current.results) {
    const before = baseline.cases[r.caseId];
    if (before === undefined) {
      added.push(r.caseId);
      continue;
    }
    if (before && !r.passed) regressions.push({ caseId: r.caseId, title: r.title, failures: r.failures });
    else if (!before && r.passed) improvements.push({ caseId: r.caseId, title: r.title });
  }
  for (const id of Object.keys(baseline.cases)) {
    if (!currentIds.has(id)) removed.push(id);
  }

  return {
    ok: regressions.length === 0,
    regressions,
    improvements,
    added,
    removed,
    summaryDelta: {
      passRate: current.summary.passRate - baseline.summary.passRate,
      costUsd: current.summary.totalCostUsd - baseline.summary.totalCostUsd,
      avgTurns: current.summary.avgTurns - baseline.summary.avgTurns,
    },
  };
}

export function renderComparisonText(cmp: BaselineComparison): string {
  const lines: string[] = [];
  lines.push(cmp.ok ? '✅ 回归检查通过：无用例从通过变为失败' : '❌ 检出回归：');
  for (const r of cmp.regressions) lines.push(`  ❌ ${r.caseId}（${r.title}）：${r.failures.join('；')}`);
  if (cmp.improvements.length > 0) lines.push(`  改进 ${cmp.improvements.length} 例：${cmp.improvements.map((i) => i.caseId).join(', ')}`);
  if (cmp.added.length > 0) lines.push(`  新增用例：${cmp.added.join(', ')}`);
  if (cmp.removed.length > 0) lines.push(`  已移除用例：${cmp.removed.join(', ')}`);
  const d = cmp.summaryDelta;
  lines.push(
    `  通过率 ${(d.passRate * 100).toFixed(0)}% · 费用 ${d.costUsd >= 0 ? '+' : ''}${fmtCost(d.costUsd)} · 轮次均值 ${d.avgTurns >= 0 ? '+' : ''}${d.avgTurns.toFixed(1)}`,
  );
  return lines.join('\n');
}
