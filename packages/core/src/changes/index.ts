/** `@delta/core/changes` 公开入口。主桶 `@delta/core` 仍再导出这些符号。 */
export {
  FileChangeStore,
  readSnapshot,
  countLineDelta,
  renderSummary,
  MAX_SNAPSHOT_BYTES,
  type FileChangeRow,
  type RecordChangeInput,
  type ChangeSummaryItem,
  type RollbackResult,
} from '../session/changes.js';
