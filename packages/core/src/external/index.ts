/** `@delta/core/external` 公开入口。主桶 `@delta/core` 仍再导出这些符号。 */
export type {
  ExternalTier,
  ExternalAgentSpec,
  ExternalEvent,
  ExternalAgentAdapter,
} from './types.js';
export {
  spawnExternal,
  MAX_LINE_BYTES,
  STDERR_RING_LINES,
  ABORT_KILL_DELAY_MS,
} from './spawn.js';
export type { SpawnOptions, ProcEvent, SpawnedProcess } from './spawn.js';
export {
  registerExternalAdapter,
  registerExternalAdapterFactory,
  resolveExternalAdapter,
  isExternalModel,
} from './registry.js';
export {
  trackExternalRun,
  untrackExternalRun,
  cancelAllExternalRuns,
} from './lifecycle.js';
export type { ExternalRunHandle } from './lifecycle.js';
export { ScriptedExternalAdapter } from './scripted.js';
export { AcpExternalAdapter } from './acp.js';
export { ReservedExternalAdapter } from './reserved.js';
export {
  ManualRegisterError,
  upsertManualEntry,
  removeManualEntry,
  setExternalAgentModel,
  findKnownAgent,
  resolveAgentModels,
} from './detect.js';
export type { ManualRegisterInput } from './detect.js';
export { StreamJsonExternalAdapter } from './stream-json.js';
export { CodexExternalAdapter } from './codex.js';
export { buildDeltaMcpFile } from './mcp-passthrough.js';
export {
  KNOWN_AGENTS,
  PROBE_TIMEOUT_MS,
  detectExternalAgents,
  ensureExternalAdapters,
  probeAgent,
  detectedToSpec,
  registerDetected,
  checkLoginState,
  externalEnvPathName,
  readExternalAgentsCache,
  writeExternalAgentsCache,
} from './detect.js';
export type {
  KnownAgentDef,
  DetectedAgent,
  DetectSource,
  DetectOptions,
  ExternalAgentCacheEntry,
} from './detect.js';
