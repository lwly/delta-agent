/** `@delta/core/prompt` 公开入口。主桶 `@delta/core` 仍再导出这些符号。 */
export {
  PromptAssembler,
  ASSEMBLER_VERSION,
  formatPrompt,
  renderValue,
} from './assembler.js';
export {
  IdentityLayer,
  EnvironmentLayer,
  ProjectLayer,
  ToolsLayer,
  SkillsLayer,
  MemoryLayer,
  SessionLayer,
  createDefaultLayers,
} from './layers.js';
export { applyOverrides, deepMerge, unionDedupe } from './merge.js';
export {
  NullMemoryProvider,
  StaticMemoryProvider,
  type MemoryProvider,
  type RecallQuery,
} from './memory-provider.js';
export {
  PromptBuilder,
  DEFAULT_PROMPT_BUDGET,
  type BuilderOptions,
  type FinalPrompt,
  type PromptBudget,
  type TrimAction,
} from './builder.js';
export {
  buildDebugReport,
  formatDebugReport,
  promptSectionsLog,
  type DebugReportInput,
  type PromptDebugReport,
  type PromptSectionsLogEntry,
} from './debug.js';
export {
  SplitPromptAssembler,
  composeSystemPrompt,
  type AssembleSplitResult,
  type DynamicPromptResult,
  type SplitAssemblerOptions,
  type StaticPromptEntry,
} from './split-assembler.js';
export type {
  AssembleContext,
  AssembleResult,
  AssembleWarning,
  ExpertSegmentInput,
  LayerId,
  LayerOverride,
  LayerValue,
  OverrideSet,
  PromptLayer,
  PromptSection,
  SystemPrompt,
} from './types.js';
