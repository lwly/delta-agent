/** `@delta/core/hooks` 公开入口。主桶 `@delta/core` 仍再导出这些符号。 */
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
} from './manager.js';
