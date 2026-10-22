/**
 * F-28 Evals —— 套件运行器。
 *
 * 输入基准集 + 单用例执行器（CaseRunner，CLI 侧按 provider/model 接线 headless 内核，
 * 测试可注入伪造），逐用例执行 + 判分 + 汇总为 SuiteRun。
 * 运行器本身不触碰 provider / db / stdio：全部依赖经参数注入，纯编排层。
 */
import { evaluateChecks, validateChecks } from './checks.js';
import type { CaseRunner, CaseResult, EvalSuite, SuiteRun, SuiteSummary } from './types.js';

export interface RunSuiteOptions {
  provider: string;
  model: string;
  /** 每用例回调（CLI 进度输出；抛错被吞掉，不影响主流程） */
  onCaseStart?: (c: EvalSuite['cases'][number], index: number, total: number) => void;
  onCaseDone?: (r: CaseResult, index: number, total: number) => void;
}

/** 加载期校验：ID 非空且不重复 + 正则可编译。返回错误列表（空 = 通过）。 */
export function validateSuite(suite: EvalSuite): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const c of suite.cases) {
    if (!c.id.trim()) errors.push(`用例缺少 id：${c.title}`);
    if (seen.has(c.id)) errors.push(`用例 id 重复：${c.id}`);
    seen.add(c.id);
    if (!c.task.trim()) errors.push(`用例 ${c.id} 缺少 task`);
    if (!Array.isArray(c.checks) || c.checks.length === 0) errors.push(`用例 ${c.id} 缺少 checks`);
    else errors.push(...validateChecks(c.checks, c.id));
  }
  return errors;
}

function summarize(results: CaseResult[]): SuiteSummary {
  const passed = results.filter((r) => r.passed).length;
  const totalTokens = results.reduce(
    (acc, r) => ({ in: acc.in + r.usage.inputTokens, out: acc.out + r.usage.outputTokens, cost: acc.cost + r.usage.costUsd }),
    { in: 0, out: 0, cost: 0 },
  );
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    totalInputTokens: totalTokens.in,
    totalOutputTokens: totalTokens.out,
    totalCostUsd: totalTokens.cost,
    avgTurns: results.length === 0 ? 0 : results.reduce((a, r) => a + r.turns, 0) / results.length,
    avgDurationMs: results.length === 0 ? 0 : results.reduce((a, r) => a + r.durationMs, 0) / results.length,
  };
}

const EXCERPT_LEN = 240;

/** 顺序执行基准集全部用例，产出 SuiteRun（含逐用例判分与汇总）。 */
export async function runEvalSuite(
  suite: EvalSuite,
  runTask: CaseRunner,
  opts: RunSuiteOptions,
): Promise<SuiteRun> {
  const errors = validateSuite(suite);
  if (errors.length > 0) throw new Error(`基准集「${suite.name}」配置错误：\n  ${errors.join('\n  ')}`);

  const startedAt = new Date();
  const t0 = Date.now();
  const results: CaseResult[] = [];

  for (let i = 0; i < suite.cases.length; i++) {
    const c = suite.cases[i]!;
    opts.onCaseStart?.(c, i, suite.cases.length);
    let result: CaseResult;
    try {
      const outcome = await runTask(c.task);
      const checks = evaluateChecks(c.checks, outcome);
      const failures = checks.filter((k) => !k.ok).map((k) => k.detail);
      result = {
        caseId: c.id,
        title: c.title,
        passed: failures.length === 0,
        checks,
        failures,
        status: outcome.status,
        turns: outcome.turns,
        durationMs: outcome.durationMs,
        usage: outcome.usage,
        toolCalls: outcome.toolCalls.length,
        error: outcome.error,
        resultExcerpt: outcome.result.length > EXCERPT_LEN ? `${outcome.result.slice(0, EXCERPT_LEN)}…` : outcome.result,
      };
    } catch (e) {
      // 执行器崩溃（如 provider 断连）：记为失败用例，继续跑剩余用例
      result = {
        caseId: c.id,
        title: c.title,
        passed: false,
        checks: [],
        failures: [`执行器异常：${(e as Error).message}`],
        status: 'failed',
        turns: 0,
        durationMs: 0,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        toolCalls: 0,
        error: (e as Error).message,
        resultExcerpt: '',
      };
    }
    results.push(result);
    opts.onCaseDone?.(result, i, suite.cases.length);
  }

  return {
    suite: suite.name,
    suiteDescription: suite.description,
    provider: opts.provider,
    model: opts.model,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - t0,
    results,
    summary: summarize(results),
  };
}
