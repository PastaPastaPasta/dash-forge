/**
 * View-model glue barrel — presentation-layer composition over the rules/sdk/repo/browse core.
 *
 * Nothing here changes core behavior: these modules only compose reads, format values, and
 * parse artifact bytes for rendering. The pages import from here rather than reaching into the
 * core services directly.
 */

export {
  balanceToDash,
  creditsAsDash,
  dashToUsd,
  formatBytes,
  formatDash,
  formatDate,
  modeKind,
  shortIdentity,
  shortOid,
  timeAgo,
} from './format'
export {
  commitSubject,
  decodeTextBlob,
  parseCommit,
  parseTree,
  type CommitObject,
  type GitIdent,
  type TreeEntry,
} from './git-objects'
export { parseMarkdown, type Block, type Inline } from './markdown'
export { highlightBlob, type HighlightedBlob } from './highlight'
export {
  listRecentRepos,
  listReposByOwner,
  type DiscoveredRepo,
} from './discovery'
export {
  artifactRangeFetch,
  buildPackSource,
  clearChunkCache,
  invalidateBrowseContext,
  loadArtifactBytes,
  loadArtifactBytesProgress,
  loadBrowseContext,
  loadBrowseContextCached,
  loadFlatIndex,
  orderGitPacks,
  peekBrowseState,
  type BrowseContext,
  type BrowseState,
} from './browse-source'
export {
  cachedFallback,
  startFallback,
  type FallbackProgress,
} from './browse-fallback'
export {
  backendInfo,
  loadRepoHome,
  type BackendInfo,
  type RepoHome,
} from './repo-view'
export { resolveDpnsName, resolveDpnsNames } from './dpns'
export {
  commitRootTree,
  findEntry,
  pickReadme,
  readBlob,
  readTree,
  treeAtPath,
} from './tree-nav'
export { findBranch, isDiverged, refParamFor, selectRef, tipOidOf, type SelectedRef } from './refs'
export {
  diffTrees,
  walkLog,
  type FileChange,
  type LogEntry,
} from './commit-log'
export {
  loadIssueThread,
  loadPullThread,
  readComments,
  readThread,
  type CommentView,
  type IssueThread,
  type PullThread,
  type TimelineItem,
} from './issues-view'
