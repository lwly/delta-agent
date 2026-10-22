export * from '@y-zero/shared';

export { estimateTextTokens, estimateMessagesTokens } from './context/tokens.js';
export {
  BudgetManager,
  DEFAULT_SESSION_BUDGET,
  type BudgetGuardResult,
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
export { ToolCallAccumulator, parseLenientJson } from './llm/accumulator.js';
export { AnthropicProvider } from './llm/providers/anthropic.js';

export { ToolRegistry } from './tools/registry.js';
export type { AgentTool, ToolContext, ToolDanger } from './tools/types.js';
export { ok as toolOk, fail as toolFail } from './tools/types.js';
export { resolveInSandbox, COMMAND_WHITELIST, isWhitelistedCommand } from './tools/sandbox.js';

export { runReAct, type RunContext } from './engine/react.js';

export { SessionStore, type SessionRow } from './session/store.js';
export { SessionService, defaultDbPath, resolveProviderFromEnv } from './session/service.js';
