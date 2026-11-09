/** `@delta/core/engine` 公开入口。主桶 `@delta/core` 仍再导出这些符号。 */
export { runReAct, type RunContext, type PlanOptions } from './react.js';
export { runExternalAgent } from './external.js';
export { runPlanExecute, summarize } from './plan-execute.js';
export { runMultiAgent, requeueFailed, DEFAULT_MAX_REVIEW_RETRIES } from './orchestrator.js';
export {
  validatePlan,
  topoLayers,
  skipDownstream,
  isReady,
  maxParallelism,
  PlanValidationError,
} from './plan.js';
export {
  detectSimpleTask,
  classifyByRules,
  classifyComplexity,
  resolveSimpleTask,
  buildPlan,
  extractJson,
  normalizeNodes,
} from './planner.js';
export {
  TaskQueue,
  runPlanWithPool,
  workerLoop,
  upstreamOf,
  EXEC_RETRY_CAP,
} from './worker-pool.js';
export {
  review,
  verify,
  mergeVerdicts,
  REVIEWER_SYSTEM,
} from './reviewer.js';
export {
  ROLE_TEMPLATES,
  roleSystemPrompt,
  RestrictedRegistry,
  type RegistryLike,
  type RoleTemplate,
} from './roles.js';
export {
  runSubTask,
  recordToolResult,
  resumeNote,
  type SubTaskResult,
} from './subtask.js';
export { createEventPump, type EventPump } from './pump.js';
export { modeSegment, type EngineMode } from './mode-prompt.js';
export { detectShell, cmdAdapter, runWithShell, type ShellAdapter } from './shell.js';
