/**
 * F-28 Evals 评测体系 —— 类型定义。
 *
 * 三层能力：
 * 1. 本地任务基准集（EvalSuite：JSON 用例 + 确定性判分 checks）
 * 2. 多 Provider 横向对比（SuiteRun 按维度汇总，report.ts 产出对比报告）
 * 3. 回归保护（baseline.ts：基线快照 + 逐用例通过/失败对比）
 *
 * 判分全部确定性（正则 / 工具调用统计 / 轮次与费用上限），
 * 不依赖 LLM 评审，保证回归对比本身稳定可复现。
 */
import type { HeadlessOutcome } from '../headless.js';

// ── 判分规则 ────────────────────────────────────────────────────────────────

export type EvalCheck =
  /** 任务以 completed 状态结束（未失败/未超轮次/未耗尽预算） */
  | { kind: 'completed' }
  /** 最终结果文本命中正则（flags 可传 'i' 等） */
  | { kind: 'result_contains'; pattern: string; flags?: string }
  /** 最终结果文本不得命中正则 */
  | { kind: 'result_not_contains'; pattern: string; flags?: string }
  /** 指定工具被调用 ≥ min 次（默认 1） */
  | { kind: 'tool_used'; name: string; min?: number }
  /** 至少调用过一个工具（不限定名字） */
  | { kind: 'tool_used_any'; min?: number }
  /** 全程零工具调用（纯文本任务，防工具滥用） */
  | { kind: 'no_tools' }
  /** 指定工具一次都不许被调用 */
  | { kind: 'tool_not_used'; name: string }
  /** 总轮次 ≤ value（防绕圈） */
  | { kind: 'max_turns'; value: number }
  /** 总费用 ≤ value（USD） */
  | { kind: 'max_cost_usd'; value: number };

export interface CheckResult {
  check: EvalCheck;
  ok: boolean;
  /** 人类可读判定说明（报告与调试用） */
  detail: string;
}

// ── 基准集 ──────────────────────────────────────────────────────────────────

export interface EvalCase {
  /** 稳定 ID（回归对比的关联键，跨版本不变） */
  id: string;
  title: string;
  /** 发给 agent 的任务原文 */
  task: string;
  tags?: string[];
  checks: EvalCheck[];
}

export interface EvalSuite {
  name: string;
  description?: string;
  cases: EvalCase[];
}

// ── 运行结果 ────────────────────────────────────────────────────────────────

export interface CaseResult {
  caseId: string;
  title: string;
  passed: boolean;
  checks: CheckResult[];
  /** 未通过check 的简述（汇总用） */
  failures: string[];
  status: HeadlessOutcome['status'];
  turns: number;
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  toolCalls: number;
  error: string | null;
  /** 结果文本片段（调试；报告截断展示） */
  resultExcerpt: string;
}

export interface SuiteSummary {
  total: number;
  passed: number;
  failed: number;
  /** 0~1 */
  passRate: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  avgTurns: number;
  avgDurationMs: number;
}

export interface SuiteRun {
  suite: string;
  suiteDescription?: string;
  provider: string;
  model: string;
  startedAt: string;
  durationMs: number;
  results: CaseResult[];
  summary: SuiteSummary;
}

/** 单用例执行器：给定任务原文，产出 headless 结果（CLI 侧接线，测试可伪造）。 */
export type CaseRunner = (task: string) => Promise<HeadlessOutcome>;
