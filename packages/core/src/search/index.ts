/** `@delta/core/search` 公开入口。主桶 `@delta/core` 仍再导出这些符号。 */
export {
  SearchStore,
  ftsTokenize,
  buildFtsQuery,
  makeSnippet,
  formatSearchHits,
  type SearchMode,
  type SearchOptions,
  type SearchHit,
} from '../session/search.js';
