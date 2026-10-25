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
  ModelRouter,
  KNOWN_TASK_KINDS,
  type RoutingTaskKind,
  type RoutedTarget,
} from './llm/router.js';
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
  type RoutingRule,
  type RoutingConfig,
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
// F-37 git 分支切换 + worktree 会话级隔离：git 原语层 + 切换注入消息（两端一致文案）
export {
  WorktreeManager,
  branchSwitchMessage,
  worktreeOnMessage,
  worktreeOffMessage,
  type GitOutcomeLike,
  type BranchInfo,
  type WorktreeInfo,
} from './git/worktree.js';
export { resolveInSandbox, COMMAND_WHITELIST, isWhitelistedCommand } from './tools/sandbox.js';
// F-30 容器级沙箱：配置 / 探测 / 参数组装 / 执行器 / 降级编排（详见 docs/design-f30-container-sandbox.md）
export * from './sandbox/index.js';
// 与 '@y-zero/shared' 的 star 导出在 SandboxBadge 上歧义（两处为结构完全一致的同名接口，
// shared 注释亦说明）：显式 re-export 消除 TS2308，消费端按结构类型兼容
export type { SandboxBadge } from './sandbox/index.js';
// F-33 桌面通知：配置（两级文件）+ DesktopNotifier（macOS/Windows/Linux 后端，fire-and-forget）
// 详见 docs/design-f33-desktop-notify.md；三端入口注入，引擎零改动
export {
  DEFAULT_NOTIFY_CONFIG,
  NOTIFY_MERGE_FIELDS,
  noopNotifier,
  type Notifier,
  type NotifyConfig,
  type NotifyConfigSource,
  type NotifyConfigWarning,
  type NotifyMergeField,
  type NotifyTrigger,
} from './notify/types.js';
export {
  loadNotifyConfig,
  normalizeNotifyLayer,
  projectNotifyConfigPath,
  updateUserNotifyEnabled,
  userNotifyConfigPath,
  type LoadNotifyConfigOptions,
  type NotifyConfigLayer,
  type ResolvedNotifyConfig,
  type UpdateUserNotifyEnabledResult,
} from './notify/config.js';
export {
  buildNotifyCommand,
  createDesktopNotifier,
  DesktopNotifier,
  sanitizeBody,
  type DesktopNotifierOptions,
  type NotifyCommand,
} from './notify/notifier.js';
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
  resolveWorkRoot,
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

export {
  SessionHub,
  createSkillRuntime,
  type HubEvent,
  type SessionHubDeps,
  type SessionGitState,
  type BranchSwitchResult,
} from './server/hub.js';
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
// Skill Hub：远端搜索 / 安装（skillhub.cn 兼容协议，hub 地址可配置）
export {
  DEFAULT_SKILL_HUB_BASE,
  SKILL_HUB_ENV,
  MAX_EXTRACT_BYTES,
  searchHubSkills,
  installHubSkill,
  extractZipEntries,
  resolveSkillHubBase,
  readSkillHubUrl,
  writeSkillHubUrl,
  userSkillHubConfigPath,
  type HubSkillInfo,
  type SkillHubSource,
  type SearchHubSkillsOptions,
  type InstallHubSkillOptions,
  type InstallHubSkillResult,
} from './skills/hub.js';
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

// F-34 项目 onboarding：自动扫描生成项目摘要与静态记忆草案
export {
  scanProjectLayout,
  SCAN_SKIP_DIRS,
  autoOnboardProject,
  runOnboardingScan,
  confirmOnboarding,
  skipOnboarding,
  loadOnboardingState,
  saveOnboardingState,
  shouldAutoOnboard,
  onboardingStatePath,
  agentMdDraftPath,
  memoryMdDraftPath,
  agentMdTargetPath,
  memoryMdTargetPath,
  type OnboardingState,
  type OnboardingStatus,
  type ProjectScan,
  type ScanOptions,
  type RunOnboardingOptions,
  type RunOnboardingResult,
  type ConfirmOnboardingResult,
  type AutoOnboardOptions,
} from './onboarding/index.js';

// F-36 CLI TUI 细节：行级 diff 生成（edit/write 快照 → 彩色渲染）
export {
  diffLines,
  compactDiff,
  DIFF_MAX_LINES,
  DIFF_MAX_RENDER_LINES,
  type DiffLine,
  type DiffLineType,
} from './diff/lines.js';

// F-22 定时任务/自动化：cron 表达式解析 + 调度存储 + 到期执行器 + 常驻调度循环
export {
  parseCron,
  nextRun,
  type CronFields,
} from './cron/parse.js';
export {
  userCronConfigPath,
  loadCronJobs,
  saveCronJobs,
  addCronJob,
  updateCronJob,
  removeCronJob,
  findCronJob,
  isInValidWindow,
  MAX_RUN_HISTORY,
  STALE_RUNNING_MS,
  CRON_PERMISSIONS,
  type CronJob,
  type CronRunRecord,
  type CronStoreFile,
  type CronStoreWarning,
  type LoadedCronStore,
  type AddCronJobInput,
  type CronJobPatch,
} from './cron/store.js';
export {
  runDueCronJobs,
  type CronExecutor,
  type CronExecutorResult,
  type RunDueOptions,
  type RunDueResult,
} from './cron/runner.js';
export {
  startCronScheduler,
  type StartCronSchedulerOptions,
  type CronSchedulerHandle,
} from './cron/scheduler.js';

// F-38 项目文件浏览器 + 变更文件面板：只读文件原语 + unified diff 解析 + git 变更统计 + 只读路由
// 详见 docs/design-f38-project-file-panel.md（browse 无 SessionService 依赖，可直接单测）
export {
  BROWSE_IGNORED_DIRS,
  isBrowseIgnored,
  MAX_DIR_ENTRIES,
  PATH_REJECT_MESSAGE,
  NOT_FOUND_MESSAGE,
  DENIED_MESSAGE,
  OVERSIZE_REASON,
  BINARY_REASON,
  normalizeRelPath,
  resolveInRoot,
  mapFsError,
  listDir,
  readFileForPreview,
  type RelPathOk,
  type RelPathFail,
  type RelPathResult,
  type RootResolve,
  type RootResolveFailure,
  type RootResolveErrorCode,
  type BrowseEntry,
  type DirListing,
  type PreviewKind,
  type FilePreview,
} from './files/browse.js';
export {
  parseUnifiedDiff,
  buildAllAddedRows,
  DIFF_MAX_ROWS,
  DIFF_MAX_BYTES,
  type DiffRow,
  type DiffRowType,
  type ParsedPatch,
} from './files/patch.js';
export {
  listWorkspaceChanges,
  readFileDiff,
  parseStatusEntries,
  parseNumstat,
  normalizeStatus,
  MAX_CHANGE_FILES,
  GIT_TIMEOUT_REASON,
  NOT_A_REPO_REASON,
  type ChangeStatus,
  type ChangeFile,
  type ChangesResult,
  type FileDiffResult,
} from './files/changes.js';
export {
  handleBrowseRoute,
  type BrowseDeps,
  type BrowseRouteInput,
  type BrowseRouteOutcome,
} from './server/browse-routes.js';
