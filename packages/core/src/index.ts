export * from '@y-zero/shared';

export { estimateTextTokens, estimateMessagesTokens } from './context/tokens.js';
export {
  BudgetManager,
  DEFAULT_SESSION_BUDGET,
  BUDGET_ALERT_LEVELS,
  type BudgetGuardResult,
  type BudgetAlert,
  type BudgetAlertLevel,
} from './context/budget.js';
export {
  compact,
  partition,
  foldToolResults,
  shouldCompact,
  KEEP_TURNS,
  TOOL_RESULT_FOLD_LIMIT,
  SAFETY_RESERVE_TOKENS,
  type CompactionResult,
  type CompressorDeps,
} from './context/compressor.js';

export { parseSse, parseDataFrames } from './llm/sse.js';

export {
  PromptAssembler,
  ASSEMBLER_VERSION,
  formatPrompt,
  renderValue,
} from './prompt/assembler.js';
export {
  IdentityLayer,
  EnvironmentLayer,
  ProjectLayer,
  ToolsLayer,
  SkillsLayer,
  MemoryLayer,
  SessionLayer,
  createDefaultLayers,
} from './prompt/layers.js';
export { applyOverrides, deepMerge, unionDedupe } from './prompt/merge.js';
export {
  NullMemoryProvider,
  StaticMemoryProvider,
  type MemoryProvider,
  type RecallQuery,
} from './prompt/memory-provider.js';
export {
  PromptBuilder,
  DEFAULT_PROMPT_BUDGET,
  type BuilderOptions,
  type FinalPrompt,
  type PromptBudget,
  type TrimAction,
} from './prompt/builder.js';
export {
  buildDebugReport,
  formatDebugReport,
  promptSectionsLog,
  type DebugReportInput,
  type PromptDebugReport,
  type PromptSectionsLogEntry,
} from './prompt/debug.js';
export {
  SplitPromptAssembler,
  composeSystemPrompt,
  type AssembleSplitResult,
  type DynamicPromptResult,
  type SplitAssemblerOptions,
  type StaticPromptEntry,
} from './prompt/split-assembler.js';
export type {
  AssembleContext,
  AssembleResult,
  AssembleWarning,
  LayerId,
  LayerOverride,
  LayerValue,
  OverrideSet,
  PromptLayer,
  PromptSection,
  SystemPrompt,
} from './prompt/types.js';
export { ToolCallAccumulator, parseLenientJson } from './llm/accumulator.js';
export { AnthropicProvider } from './llm/providers/anthropic.js';
export { OpenAICompatibleProvider } from './llm/providers/openai-compatible.js';
export { OpenAIProvider } from './llm/providers/openai.js';
export { DeepSeekProvider } from './llm/providers/deepseek.js';
export { QwenProvider } from './llm/providers/qwen.js';
export { ProviderManager, type ProviderView } from './llm/manager.js';
export {
  encryptKey,
  decryptKey,
  decryptKeyDetailed,
  maskKey,
  loadModelsFile,
  saveModelsFile,
  modelsConfigPath,
  type StoredProvider,
  type ModelsFile,
} from './llm/keychain.js';

export { ToolRegistry } from './tools/registry.js';
export type { AgentTool, ToolContext, ToolDanger, SubagentRuntime } from './tools/types.js';
export {
  taskTool,
  SUBAGENT_TOOLS,
  MAX_SUBAGENT_DEPTH,
  DEFAULT_SUBAGENT_TURNS,
  MAX_SUBAGENT_TURNS,
} from './tools/builtin/task.js';
export { ok as toolOk, fail as toolFail } from './tools/types.js';
export {
  GitIntegration,
  type GitPolicy,
  type GitPolicyMode,
  type GitOutcome,
} from './git/repo.js';
export { resolveInSandbox, COMMAND_WHITELIST, isWhitelistedCommand } from './tools/sandbox.js';
// F-30 容器级沙箱：配置 / 探测 / 参数组装 / 执行器 / 降级编排（详见 docs/design-f30-container-sandbox.md）
export * from './sandbox/index.js';
export {
  PermissionState,
  toolCapability,
  type PermissionMode,
  type PermissionPolicy,
  type PermissionCheck,
  type ToolCapability,
} from './tools/permissions.js';

export { runReAct, type RunContext, type PlanOptions } from './engine/react.js';
export {
  runHeadless,
  headlessExitCode,
  buildHeadlessReport,
  type HeadlessStatus,
  type HeadlessOutcome,
  type HeadlessDeps,
  type HeadlessService,
  type HeadlessJsonReport,
  type HeadlessDeniedConfirmation,
  type HeadlessToolCallSummary,
} from './headless.js';
// F-28 Evals 评测体系：基准集 + 确定性判分 + 运行器 + 报告/回归基线
export {
  evaluateChecks,
  validateChecks,
} from './evals/checks.js';
export { runEvalSuite, validateSuite, type RunSuiteOptions } from './evals/runner.js';
export {
  BUILTIN_SUITE,
  BUILTIN_SUITE_NAME,
  loadEvalSuite,
  filterCases,
} from './evals/suites.js';
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
} from './evals/report.js';
export type {
  EvalCheck,
  EvalCase,
  EvalSuite,
  CheckResult,
  CaseResult,
  SuiteSummary,
  SuiteRun,
  CaseRunner,
} from './evals/types.js';
export {
  runPlanExecute,
  summarize,
} from './engine/plan-execute.js';
export { runMultiAgent, requeueFailed, DEFAULT_MAX_REVIEW_RETRIES } from './engine/orchestrator.js';
export {
  validatePlan,
  topoLayers,
  skipDownstream,
  isReady,
  maxParallelism,
  PlanValidationError,
} from './engine/plan.js';
export {
  detectSimpleTask,
  classifyByRules,
  classifyComplexity,
  resolveSimpleTask,
  buildPlan,
  extractJson,
  normalizeNodes,
} from './engine/planner.js';
export {
  TaskQueue,
  runPlanWithPool,
  workerLoop,
  upstreamOf,
  EXEC_RETRY_CAP,
} from './engine/worker-pool.js';
export {
  review,
  verify,
  mergeVerdicts,
  REVIEWER_SYSTEM,
} from './engine/reviewer.js';
export {
  ROLE_TEMPLATES,
  roleSystemPrompt,
  RestrictedRegistry,
  type RegistryLike,
  type RoleTemplate,
} from './engine/roles.js';
export {
  runSubTask,
  recordToolResult,
  resumeNote,
  type SubTaskResult,
} from './engine/subtask.js';
export { createEventPump, type EventPump } from './engine/pump.js';
export { modeSegment, type EngineMode } from './engine/mode-prompt.js';
export { detectShell, cmdAdapter, runWithShell, type ShellAdapter } from './engine/shell.js';

export { SessionStore, type SessionRow, type ProjectRow, type TrashItem } from './session/store.js';
export {
  MIGRATIONS,
  LATEST_SCHEMA_VERSION,
  currentSchemaVersion,
  migrate,
  type Migration,
  type MigrateResult,
} from './session/migrations.js';
export {
  SessionService,
  defaultDbPath,
  resolveProviderFromEnv,
  TRASH_RETENTION_DAYS,
  type ProviderId,
  type RunSummary,
  type RunTimeline,
} from './session/service.js';
export {
  TaskStore,
  taskId,
  LEASE_MS,
  HEARTBEAT_MS,
  emptyCheckpoint,
  type TaskRow,
  type TaskStatus,
  type TaskCheckpoint,
} from './session/tasks.js';
export {
  FileChangeStore,
  readSnapshot,
  countLineDelta,
  renderSummary,
  MAX_SNAPSHOT_BYTES,
  type FileChangeRow,
  type RecordChangeInput,
  type ChangeSummaryItem,
  type RollbackResult,
} from './session/changes.js';
export {
  MemoryStore,
  memoryTokenize,
  estimateTokens as estimateMemoryTokens,
  coverageOf,
  MEMORY_QUOTA,
  MEMORY_DECAY_HALF_LIFE_DAYS,
  RECALL_THRESHOLD,
  type MemoryItem,
  type MemoryHit,
  type MemoryKind,
  type MemoryStatus,
  type SaveInput,
  type SaveResult,
} from './session/memory.js';
export {
  distillMemories,
  createMemoryProvider,
  type DistillResult,
} from './session/distill.js';

export {
  SearchStore,
  ftsTokenize,
  buildFtsQuery,
  makeSnippet,
  formatSearchHits,
  type SearchMode,
  type SearchOptions,
  type SearchHit,
} from './session/search.js';
export {
  UsageStore,
  normalizeRange,
  rangeCutoff,
  usageReportToJson,
  type UsageRange,
  type UsageFilter,
  type UsageTotals,
  type UsageProjectRow,
  type UsageModelRow,
  type UsageSessionRow,
  type UsageReport,
  type UsageReportJson,
} from './session/usage.js';
export {
  EmbeddingClient,
  resolveEmbedding,
  VENDOR_EMBEDDING,
  type EmbeddingOptions,
} from './llm/embeddings.js';

export { McpManager, loadMcpConfig, type McpServerConfig } from './mcp/client.js';

export {
  HookManager,
  loadHookFiles,
  hookMatches,
  HOOK_EVENTS,
  type HookEvent,
  type HookDef,
  type HookPayload,
  type HookOutcome,
  type HookFiles,
  type PreToolUseVerdict,
} from './hooks/manager.js';

export { SessionHub, createSkillRuntime, type HubEvent, type SessionHubDeps } from './server/hub.js';
export { createWebServer, type ServeOptions } from './server/http.js';

export {
  discoverSkills,
  defaultBuiltinSkillsDir,
  readSkillDir,
  parseFrontmatter,
  type DiscoverOptions,
  type SkillLayer,
  type SkillMeta,
} from './skills/loader.js';
export {
  tokenize,
  scoreSkill,
  matchSkills,
  suggestSkill,
  MATCH_THRESHOLD,
  type SkillScore,
} from './skills/matcher.js';
export { SkillBuffer, renderSkillContent, type LoadedSkill } from './skills/buffer.js';
export { loadSkillTool, unloadSkillTool } from './tools/builtin/skill.js';
export type { SkillRuntime } from './tools/types.js';
// F-25 多模态：图片附件加载/校验/计价
export {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_DIM,
  ImageError,
  sniffImageMediaType,
  imageDimensions,
  estimateImageTokens,
  prepareImageFromBase64,
  prepareImageFromFile,
  prepareImages,
  normalizeIncomingImages,
  describeImage,
  type PreparedImage,
} from './media/images.js';
