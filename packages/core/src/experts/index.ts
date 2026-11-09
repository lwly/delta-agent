/** `@delta/core/experts` 公开入口。主桶 `@delta/core` 仍再导出这些符号。 */
export {
  AGENT_ID_PATTERN,
  EXPERT_NAME_PATTERN,
  EXPERT_BODY_MAX_CHARS,
  MAX_TEAM_MEMBERS,
  displayOf,
  type ExpertPackage,
  type ExpertAgent,
  type ExpertMember,
  type ExpertRecord,
  type ExpertLayer,
  type ExpertType,
  type ExpertDiscoverResult,
  type ExpertListItem,
  type ExpertLayers,
  type LocalizedText,
} from './types.js';
export {
  parseExpertPackage,
  parseAgentMarkdown,
  validateExpertName,
  escapeReservedMarkers,
  resolveInPackage,
  EXPERT_JSON_MAX_BYTES,
  AGENT_MD_MAX_BYTES,
  type ParseInput,
} from './parser.js';
export {
  ExpertStore,
  defaultBuiltinExpertsDir,
  toExpertListItem,
  MAX_EXPERTS_PER_LAYER,
  AVATAR_MAX_BYTES,
  type ExpertStoreOptions,
} from './store.js';
export {
  prepareExpertSegment,
  EXPERT_MEMBERS_LINE_MAX,
  TRUNCATE_SUFFIX,
} from './prompt.js';
export {
  BUILTIN_TOOL_COUNT,
  EXPERT_SKILLS_MAX_COUNT,
  EXPERT_SKILLS_MAX_TOKENS,
  resolveToolAllow,
  restrictRegistry,
  seedExpertSkills,
  type ToolAllowResolution,
} from './policy.js';
export { resolveBinding, type BindingInput, type SessionBinding } from './session-binding.js';
export {
  MAX_DELEGATIONS_PER_RUN,
  MEMBER_BODY_MAX_CHARS,
  buildMemberSystemPrompt,
  delegationPrefix,
  toTeamRuntime,
} from './team.js';
export { buildAssembleContext, type BuildAssembleContextInput } from './assemble-context.js';
export {
  expertsConfigPath,
  readExpertsConfig,
  writeExpertsConfig,
  toolsHashOf,
  isTrusted,
  recordTrust,
  revokeTrust,
  setDisabled,
  type TrustedEntry,
  type ExpertsConfig,
} from './trust.js';
export {
  installExpertFromBytes,
  exportExpertToBytes,
  scaffoldExpert,
  expertsLayerDir,
  type ImportResult,
  type ScaffoldOptions,
} from './io.js';
