/** `@delta/core/skills` 公开入口。主桶 `@delta/core` 仍再导出这些符号。 */
export {
  discoverSkills,
  defaultBuiltinSkillsDir,
  readSkillDir,
  parseFrontmatter,
  type DiscoverOptions,
  type SkillLayer,
  type SkillMeta,
} from './loader.js';
export {
  discoverLayered,
  DEFAULT_MAX_PER_LAYER,
  type LayerName,
  type LayeredDir,
  type LayeredOutcome,
} from './layered.js';
export {
  tokenize,
  scoreSkill,
  matchSkills,
  suggestSkill,
  MATCH_THRESHOLD,
  type SkillScore,
} from './matcher.js';
export { SkillBuffer, renderSkillContent, type LoadedSkill } from './buffer.js';
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
} from './hub.js';
export type { SkillRuntime } from '../tools/types.js';
