/**
 * View-model glue barrel — presentation-layer composition over the rules/sdk/repo/browse core.
 *
 * Nothing here changes core behavior: these modules only compose reads, format values, and
 * parse artifact bytes for rendering. The pages import from here rather than reaching into the
 * core services directly.
 */

export {
  balanceToDash,
  branchName,
  creditsAsDash,
  dashToUsd,
  dashValueNote,
  formatBytes,
  formatDash,
  formatDate,
  modeKind,
  plural,
  priceLabel,
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
export { headingSlug, isRelativeHref, MARKDOWN_MAX_CHARS, parseMarkdown, splitRefs, type Block, type Inline, type RefPiece, type TableAlignment } from './markdown'
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
  diffTotals,
  loadFilePatch,
  modeString,
  uncountedReasons,
  type DiffTotals,
  type FilePatch,
  type PatchPlaceholder,
} from './file-diff'
export {
  findMergeBase,
  loadPullComparison,
  MergeBaseCancelledError,
  type MergeBaseOptions,
  type PullComparison,
  type PullComparisonInput,
} from './pull-diff'
export { highlightBlob, highlightFence, type HighlightedBlob } from './highlight'
export {
  listRecentRepos,
  listReposByOwner,
  rankedRepos,
  recentReposPage,
  searchRepos,
  type DiscoveredRepo,
  type Keyset,
  type RepoPage,
} from './discovery'
export {
  artifactRangeFetch,
  browseGeneration,
  buildPackSource,
  clearChunkCache,
  subscribeBrowseGeneration,
  forgetDeadMirrors,
  invalidateBrowseContext,
  loadArtifactBytes,
  loadArtifactBytesProgress,
  loadBrowseContext,
  loadBrowseContextCached,
  loadFlatIndex,
  peekBrowseState,
  PackUnavailableError,
  StorageUnreachableError,
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
  beginView,
  contentChecks,
  NO_CONTENT_CHECKS,
  subscribeContentChecks,
  type ContentChecks,
} from './content-checks'
export {
  connectionTrust,
  deriveConnectionTrust,
  deriveTrust,
  failedRows,
  TRUST_LABEL,
  TRUST_ROW_TITLE,
  worstOf,
  type ConnectionTrust,
  type TipLink,
  type TrustFailure,
  type TrustInputs,
  type TrustLink,
  type TrustReport,
  type TrustRow,
  type TrustState,
} from './trust'
export { QUORUM_CHECK_MAX_AGE_MS, crossCheckQuorumKeysCached, lastQuorumCheck, quorumCheckDueInMs, type QuorumCrossCheck } from './quorum-check'
export {
  describeUnavailable,
  onlyGatewaysFailed,
  onlyUnfollowed,
  normalizeGateway,
  readGateways,
  readGatewaysFor,
  setUserGateways,
  userGateways,
} from './storage-status'
export { ACL_NAME, ARCHIVED_REASON, policyOf, pullActions, verdictSummary, type PullActionInputs, type PullActions, type VerdictSummary } from './pull-actions'
export {
  backendInfo,
  loadPrivateHome,
  loadRepoHome,
  type BackendInfo,
  type PrivateAccess,
  type RepoHome,
  type RepoHomeRefs,
} from './repo-view'
export { namesFromDomains, prefetchDpnsNames, resolveDpnsId, resolveDpnsName, resolveDpnsNames, seedDpnsNames } from './dpns'
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
  matchesRefQuery,
  pinnedAt,
  refParamFor,
  selectedTip,
  selectRef,
  splitRefPath,
  tipOidOf,
  type SelectedRef,
} from './refs'
export {
  CommitIdError,
  diffTrees,
  loadCommitChanges,
  resolveCommitOid,
  type CommitChanges,
  type DiffSides,
  type FileChange,
  type LogEntry,
  type TreeDiff,
} from './commit-log'
export { mapPooled } from './pool'
export {
  blobDisplay,
  lineHash,
  parseLineHash,
  selectLine,
  visibleRows,
  VIRTUALIZE_LINES,
  type BlobDisplay,
  type LineRange,
} from './blob-view'
export {
  issueWriteShows,
  loadIssueThread,
  loadPullThread,
  readComments,
  readThread,
  type CommentView,
  type IssueThread,
  type IssueWrite,
  type PullApprovals,
  type PullThread,
  type TimelineItem,
} from './issues-view'
