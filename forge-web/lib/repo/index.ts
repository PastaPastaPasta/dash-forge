/**
 * Repo read services — the TS mirror of forge-core's RepoService read API.
 *
 * Composes the evo-sdk query layer + FORGE_RULES_V1/V2 into the reads a repo view needs:
 * resolve a repo (forge-v2 `repo` document, else the v1 registry), enumerate + resolve refs,
 * read config / default branch, locate browse-plane pack manifests, fold issue/PR state,
 * and derive the collaborators (v2 membership documents, v1 token balances). Every query is
 * built by a {@link RepoSource}, the one place the two data models differ.
 *
 * WRITE paths (forge-v2 repo creation and membership, issues, comments, events, author events,
 * reviews, releases, stars, follows; v1 issue/comment/event/star/follow and token admin) sign
 * + broadcast via the `./writes` WriteEngine.
 */

export {
  DOC,
  REGISTRY_DOC,
  TOKEN_POSITION,
  V2_DOC,
  asIdentifierString,
  num,
  parseJsonList,
  str,
  stringArray,
  repoContractIds,
  repoKey,
  toEvent,
  toRefUpdate,
  wellFormed,
  type RepoRef,
  type V1RepoRef,
  type V2RepoRef,
} from './contract'
export { CHUNK_QUERY_MAX, repoSource } from './source'
export {
  fetchContractOwner,
  readV2RepoById,
  resolveAnyRepo,
  resolveAnyRepoWith,
  resolveOwner,
  resolveRepo,
  resolveRepoByContractId,
  resolveRepoListing,
  resolveRepoWithListing,
  toV2RepoDoc,
  v2RefOf,
  type RepoAddressParams,
  type RepoListing,
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
} from './social'
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
  liveGitPackManifests,
  liveLocatorManifests,
  readNewestFlatIndexManifest,
  readNewestLocatorManifest,
  readNewestManifestOfKind,
  readPackManifests,
  isV2Copies,
  readRepoPackManifests,
  readV2PackCopies,
  v2PacksOfKind,
  type AsOf,
  type PackManifest,
} from './packs'
export {
  currentHoldings,
  invalidateAuthz,
  readTokenHistory,
  readViewerHoldings,
  resolveAuthz,
} from './tokens'
export {
  emptyAuthz,
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
  balanceIsNonzero,
  candidateCollaborators,
  readCollaborators,
  readFollowerCount,
  readFollowingCount,
  readStarCount,
  readStargazers,
  repoTokenIds,
  type Collaborator,
  type Stargazer,
} from './collab'
export {
  addAuthorEvent,
  addEvent,
  adminCollaborator,
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
