/**
 * Repo read services — the TS mirror of forge-core's RepoService read API.
 *
 * Composes the evo-sdk query layer + FORGE_RULES_V1/V2 into the reads a repo view needs:
 * resolve a repo (forge-v2 `repo` document, else the v1 registry), enumerate + resolve refs,
 * read config / default branch, locate browse-plane pack manifests, fold issue/PR state,
 * and derive the collaborators (v2 membership documents, v1 token balances). Every query is
 * built by a {@link RepoSource}, the one place the two data models differ.
 *
 * WRITE paths (issues, comments, events, stars, follows, releases, collaborator token admin,
 * repo creation, minimal ref push) sign + broadcast via the `./writes` WriteEngine.
 */

export {
  DOC,
  REGISTRY_DOC,
  TOKEN_POSITION,
  V2_DOC,
  asIdentifierString,
  parseJsonList,
  repoContractIds,
  repoKey,
  toEvent,
  toRefUpdate,
  wellFormed,
  type RepoRef,
  type V1RepoRef,
  type V2RepoRef,
} from './contract'
export { repoSource, type QueryShape, type RepoSource } from './source'
export {
  fetchContractOwner,
  isIdentifier,
  readV2RepoById,
  readV2RepoByName,
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
  readV2Profile,
  readV2StarCount,
  readV2StarCounts,
  readV2StarredRepoIds,
  readV2Stargazers,
  type V2Profile,
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
  readRepoPackManifests,
  selectPackCopies,
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
  readRepoFeed,
  readTargetLog,
  readIssue,
  readPull,
  readReviews,
  verdictFromCode,
  VERDICT_LABEL,
  type IssueView,
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
  WriteNotImplementedError,
  addEvent,
  closeTarget,
  createComment,
  createIssue,
  createLabel,
  createRelease,
  createRepo,
  followIdentity,
  grantCollaborator,
  hasStarred,
  isFollowing,
  labelTarget,
  normalizeRepoName,
  pushRefUpdate,
  reopenTarget,
  revokeCollaborator,
  starRepo,
  suspendCollaborator,
  unfollowIdentity,
  unstarRepo,
  type CreateIssueResult,
  type CreateRepoOptions,
  type CreateRepoResult,
  type EventKindName,
  type ReleaseAsset,
} from './writes'
