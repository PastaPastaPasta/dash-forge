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
export { parseMarkdown, type Block, type Inline, type TableAlignment } from './markdown'
export {
  compactDiffLines,
  diffStat,
  diffTextLines,
  type CompactDiffLine,
  type DiffGap,
  type TextDiffLine,
} from './text-diff'
export {
  INLINE_BLOB_MAX_BYTES,
  loadFilePatch,
  modeString,
  type FilePatch,
  type PatchPlaceholder,
} from './file-diff'
export {
  findMergeBase,
  loadPullComparison,
  type PullComparison,
  type PullComparisonInput,
} from './pull-diff'
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
  PackUnavailableError,
  type BrowseContext,
  type BrowseState,
  type UnavailablePack,
} from './browse-source'
export {
  cachedFallback,
  restoreFallback,
  startFallback,
  type FallbackProgress,
} from './browse-fallback'
export {
  contentChecks,
  NO_CONTENT_CHECKS,
  subscribeContentChecks,
  type ContentChecks,
} from './content-checks'
export {
  connectionTrust,
  deriveConnectionTrust,
  deriveTrust,
  worstOf,
  type ConnectionTrust,
  type TrustInputs,
  type TrustLink,
  type TrustReport,
  type TrustState,
} from './trust'
export { pullActions, type PullActionInputs, type PullActions } from './pull-actions'
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
  readCommit,
  readTree,
  treeAtPath,
  type ObjectReader,
} from './tree-nav'
export {
  findBranch,
  isDiverged,
  isLive,
  refParamFor,
  selectRef,
  tipOidOf,
  type SelectedRef,
} from './refs'
export {
  diffTrees,
  loadCommitChanges,
  walkLog,
  type CommitChanges,
  type DiffSides,
  type FileChange,
  type LogEntry,
  type TreeDiff,
} from './commit-log'
export { mapPooled } from './pool'
export {
  loadIssueThread,
  loadPullThread,
  readComments,
  readThread,
  type CommentView,
  type IssueThread,
  type PullApprovals,
  type PullThread,
  type TimelineItem,
} from './issues-view'
