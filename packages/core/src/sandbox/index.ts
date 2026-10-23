/**
 * F-30 容器级沙箱 —— barrel 导出。
 *
 * 目录命名刻意与 `tools/sandbox.ts`（路径沙箱/逻辑边界）分开：
 * 这里是「容器沙箱（物理边界）」，`src/sandbox/` 目录，避免 `./sandbox.js` vs `./sandbox/` 歧义。
 */
export * from './types.js';
export {
  normalizeSandboxLayer,
  mergeSandboxLayers,
  loadSandboxConfig,
  checkEnforce,
  assertSafeWorkspaceRoot,
  userSandboxConfigPath,
  projectSandboxConfigPath,
  type LoadSandboxConfigOptions,
  type EnforceViolation,
} from './config.js';
export {
  realDockerCli,
  localDockerEnv,
  realDockerCliStats,
  realDockerCliCallCount,
  resetRealDockerCliStats,
  type DockerCli,
  type DockerResult,
  type DockerInvokeOptions,
} from './docker-cli.js';
export { probeDocker, probeArgv, classifyProbeResult, DockerProbe } from './probe.js';
export {
  buildDockerRunArgs,
  containerWorkdir,
  relativeCwdOf,
  normalizeMountSource,
  containerName,
  redactArgv,
  passthroughEnvNames,
  resolveTimezone,
  type DockerRunSpec,
} from './args.js';
export { resolveExecutionPlan, buildUnavailableMessage, type ResolvePlanInput, type UnavailableMessageInput } from './plan.js';
export {
  SEATBELT_EXEC,
  buildSeatbeltProfile,
  seatbeltArgv,
  classifySeatbeltProbe,
  SeatbeltProbe,
  realSeatbeltCli,
  SeatbeltExecutor,
  buildSeatbeltHints,
  type SeatbeltProfileSpec,
  type SeatbeltPlatformInfo,
  type SeatbeltExecutorOptions,
} from './seatbelt.js';
export {
  LocalExecutor,
  DockerExecutor,
  buildHints,
  type DockerExecutorOptions,
  type RunOptions,
  type SandboxExecResult,
  type SandboxExecutor,
} from './executor.js';
export { SandboxRuntime, createSandboxRuntime, type SandboxRuntimeDeps } from './runtime.js';
export { realpathOr } from './config.js';
