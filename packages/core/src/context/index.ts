/** `@delta/core/context` 公开入口。主桶 `@delta/core` 仍再导出这些符号。 */
export { estimateTextTokens, estimateMessagesTokens } from './tokens.js';
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
} from './compressor.js';
