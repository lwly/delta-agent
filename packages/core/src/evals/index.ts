/** `@delta/core/evals` 公开入口。主桶 `@delta/core` 仍再导出这些符号。 */
export { evaluateChecks, validateChecks } from './checks.js';
export { runEvalSuite, validateSuite, type RunSuiteOptions } from './runner.js';
export { BUILTIN_SUITE, BUILTIN_SUITE_NAME, loadEvalSuite, filterCases } from './suites.js';
export {
  renderSuiteRun,
  renderComparison,
  renderComparisonText,
  buildBaseline,
  saveBaseline,
  loadBaseline,
  compareBaseline,
  type BaselineFile,
  type BaselineComparison,
} from './report.js';
export type {
  EvalCheck,
  EvalCase,
  EvalSuite,
  CheckResult,
  CaseResult,
  SuiteSummary,
  SuiteRun,
  CaseRunner,
} from './types.js';
