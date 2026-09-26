/**
 * Repo read services — the TS mirror of forge-core's RepoService read API.
 *
 * Composes the evo-sdk query layer + FORGE_RULES / FORGE_RULES_V2 into the reads a repo view
 * needs: resolve a repo (its forge-core `repo` document), enumerate + resolve refs, read
 * config / default branch, locate browse-plane pack manifests, fold issue/PR state, and read
 * the membership documents. Every query is scoped to the repo by a {@link RepoSource}.
 *
 * WRITE paths (repo creation and membership, issues, comments, events, author events,
 * reviews, releases, stars, follows) sign + broadcast via the `./writes` WriteEngine.
 */

export {
  DOC,
  V2_DOC,
  asIdentifierString,
  num,
  str,
  stringArray,
  repoContractIds,
  repoKey,
  toEvent,
  toRefUpdate,
  wellFormed,
  type RepoRef,
  type V2RepoRef,
} from './contract'
export { CHUNK_QUERY_MAX, repoSource } from './source'
export {
  readV2RepoById,
  resolveAnyRepo,
  resolveAnyRepoWith,
  resolveOwner,
  toV2RepoDoc,
  v2RefOf,
  type RepoAddressParams,
  type ResolvedRepo,
  type V2RepoDoc,
} from './resolveRepo'
export {
  holdingsOfRole,
  invalidateMembers,
  readMemberRepoIds,
  readMemberships,
  readMembershipsCached,
  readRoleOracle,
  readViewerPermissions,
} from './members'
export {
  readV2FollowCounts,
  readV2StarCount,
  readV2Stargazers,
  readV2TargetCounts,
  readPublicRepoFacts,
} from './social'
export {
  newestPerTag,
  parseReleaseAssets,
  readReleases,
  type ReleaseAssetView,
  type ReleaseList,
  type ReleaseView,
} from './releases'
export {
  readConfig,
  readConfigBundle,
  readConfigHistory,
  readDefaultBranch,
  type ConfigBundle,
  type RepoConfig,
} from './config'
export {
  branchesOf,
  hasMissingParent,
  readAllRefUpdates,
  readRefUpdates,
  readRefs,
  resolveRefByHash,
  tagsOf,
  type ResolvedRef,
} from './refs'
export {
  readNewestFlatIndexManifest,
  readNewestLocatorManifest,
  readNewestManifestOfKind,
  readPackManifests,
  readRepoPackManifests,
  readV2PackCopies,
  v2PacksOfKind,
  type AsOf,
  type PackManifest,
} from './packs'
export {
  historicalTipsPredicate,
  listIssues,
  listPulls,
  readEvents,
  invalidateRepoFeed,
  readTargetLog,
  readIssue,
  readPull,
  readReviews,
  verdictFromCode,
  VERDICT_LABEL,
  type IssueView,
  type Listed,
  type PullView,
  type ReviewView,
  type TargetLog,
  type VerdictName,
} from './issues'
export {
  addAuthorEvent,
  addEvent,
  checkRepoInput,
  createComment,
  createIssue,
  createRelease,
  createRepoV2,
  createReview,
  discardRepoCreation,
  followRelation,
  grantMember,
  nextNumberV2,
  normalizeRepoName,
  pendingRepoCreations,
  revokeMember,
  setTargetState,
  starRelation,
  stateEventRoute,
  type CreateRepoInput,
  type CreateRepoStep,
  type Relation,
  type RepoCreationJournal,
  type VerdictInput,
} from './writes'
