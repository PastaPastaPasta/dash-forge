/**
 * Repo read services — the TS mirror of forge-core's RepoService read API.
 *
 * Composes the evo-sdk query layer + FORGE_RULES_V1 into the reads a repo view needs:
 * resolve a repo from the registry, enumerate + resolve refs (skip-scan → resolveRef),
 * read config / default branch, locate browse-plane pack manifests, fold issue/PR state,
 * and derive the collaborator list from token balances.
 *
 * WRITE paths (issues, comments, events, stars, follows, releases, collaborator token admin,
 * repo creation, minimal ref push) sign + broadcast via the `./writes` WriteEngine.
 */

export {
  DOC,
  REGISTRY_DOC,
  TOKEN_POSITION,
  asIdentifierString,
  parseJsonList,
  toEvent,
  toRefUpdate,
  type RepoRef,
} from './contract'
export {
  fetchContractOwner,
  resolveRepo,
  resolveRepoByContractId,
  resolveRepoListing,
  resolveRepoWithListing,
  type RepoListing,
} from './resolveRepo'
export {
  readConfig,
  readConfigHistory,
  readDefaultBranch,
  type RepoConfig,
} from './config'
export {
  branchesOf,
  enumerateRefHashes,
  readRefUpdates,
  readRefs,
  resolveRefByHash,
  tagsOf,
  type ResolvedRef,
} from './refs'
export {
  liveGitPackManifests,
  readNewestFlatIndexManifest,
  readNewestLocatorManifest,
  readNewestManifestOfKind,
  readPackManifests,
  type PackManifest,
} from './packs'
export {
  readTokenHistory,
  resolveAuthz,
} from './tokens'
export {
  emptyAuthz,
  historicalTipsPredicate,
  listIssues,
  listPulls,
  readEvents,
  readIssue,
  readPull,
  type IssueView,
  type PullView,
} from './issues'
export {
  balanceIsNonzero,
  candidateCollaborators,
  readCollaborators,
  readFollowerCount,
  readFollowingCount,
  readStarCount,
  repoTokenIds,
  type Collaborator,
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
