/** `@delta/core/market` 公开入口。主桶 `@delta/core` 仍再导出这些符号。 */
export {
  userRegistryConfigPath,
  readMarketSources,
  writeMarketSources,
  validateMarketSources,
  type MarketSourceConfig,
  type MarketSourceKind,
  type MarketSourcesReadResult,
} from './registry.js';
export {
  builtinSkillEntries,
  builtinMcpEntries,
  findBuiltinMarketEntry,
  BUILTIN_MCP_ENTRIES,
  type MarketEntry,
  type MarketScript,
  type McpMarketEntry,
} from './catalog.js';
export {
  listMarketSnapshot,
  findMarketEntry,
  fetchMarketSourceEntries,
  installMarketSkill,
  installMarketMcp,
  testMcpConnectivity,
  removeMarketItem,
  wrapMarketPreview,
  validateScriptName,
  MCP_PROBE_TIMEOUT_MS,
  type MarketOptions,
  type MarketSnapshot,
  type MarketItemView,
  type MarketSourceStatus,
  type InstallSkillResult,
  type InstallMcpResult,
  type McpProbeResult,
} from './install.js';
