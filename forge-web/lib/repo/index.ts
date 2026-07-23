/**
 * Repo read services — the TS mirror of forge-core's RepoService read API.
 *
 * Composes the evo-sdk query layer + FORGE_RULES_V1 into the reads a repo view needs:
 * resolve a repo from the registry, enumerate + resolve refs (skip-scan → resolveRef),
 * read config / default branch, locate browse-plane pack manifests, fold issue/PR state,
 * and derive the collaborator list from token balances.
 *
 * WRITE paths are stubbed (see `./writes`) — M3 is read/rules/browse.
 */

export {
  DOC,
  REGISTRY_DOC,
  TOKEN_POSITION,
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
  readNewestFlatIndexManifest,
  readNewestLocatorManifest,
  readNewestManifestOfKind,
  readPackManifests,
  type PackManifest,
} from './packs'
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
  createComment,
  createIssue,
  grantCollaborator,
  pushRefUpdate,
  starRepo,
  suspendCollaborator,
} from './writes'
