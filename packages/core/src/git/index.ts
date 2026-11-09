/** `@delta/core/git` 公开入口。主桶 `@delta/core` 仍再导出这些符号。 */
export {
  GitIntegration,
  type GitPolicy,
  type GitPolicyMode,
  type GitOutcome,
} from './repo.js';
export {
  WorktreeManager,
  branchSwitchMessage,
  worktreeOnMessage,
  worktreeOffMessage,
  type GitOutcomeLike,
  type BranchInfo,
  type WorktreeInfo,
} from './worktree.js';
