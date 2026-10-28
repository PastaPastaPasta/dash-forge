/**
 * The RC1 layout (`forge-contracts/schema/build.py`, `forge-contracts/contracts/*.json`): which
 * forge-v2 contract holds each document type, and which types carry the `vis` stamp.
 *
 * Dependency-free on purpose: the write engine (`lib/sdk/write.ts`) checks every create against
 * it ({@link rc1WriteProblem}), below the repo layer that builds the documents, so no writer can
 * route a type to the wrong contract or forget its stamp. Parity: forge-core `layout`
 * (`stamp_vis_for`, the contract check in `Collab::write`).
 *
 * DESIGN rev 4.1 D44 adds a fourth contract, forge-meta: `repoKey`, `ban`, `label`, `topic`,
 * `packMirror`, `profile` and `follow` ({@link META_TYPES}) move there, and `vaultEntry` (UPDATE-2,
 * the passkey vault), `board` and `card` (UPDATE-3, boards) exist there only ({@link META_ONLY_TYPES}). The deployment record
 * says which layout a network has (`v2.forgeMeta`, `ForgeIds.meta`), so one build serves
 * sakura's three-contract set and four-contract sets: pass the network's ids to
 * {@link contractKindOfType}; without them it answers the three-contract home.
 */

import { contractKind, type ForgeContractKind, type ForgeIds } from './deployments'

/** Each forge-v2 document type's contract. */
const CONTRACT_OF_TYPE: Readonly<Record<string, ForgeContractKind>> = {
  // forge-core: code, membership and consent, releases, labels, topics
  repo: 'core',
  maintainer: 'core',
  writer: 'core',
  consent: 'core',
  refUpdate: 'core',
  protectedRefUpdate: 'core',
  config: 'core',
  packManifest: 'core',
  chunk: 'core',
  release: 'core',
  label: 'core',
  topic: 'core',
  // UPDATE-1 (roadmap D4): a copy of a listed pack that anyone records
  packMirror: 'core',
  // B1 (DESIGN D42, the mainnet set only): a maintainer's push grant to a bot
  pushGrant: 'core',
  // forge-collab: issues, PRs and their threads; repo keys (O-03)
  issue: 'collab',
  patch: 'collab',
  transition: 'collab',
  comment: 'collab',
  review: 'collab',
  repoKey: 'collab',
  // UPDATE-1: a maintainer's per-repo ban list (readers apply it)
  ban: 'collab',
  // forge-community: member and author events, milestones (O-01), runners (O-02), social, CI
  event: 'community',
  authorEvent: 'community',
  milestone: 'community',
  runner: 'community',
  checkRun: 'community',
  policy: 'community',
  webhook: 'community',
  profile: 'community',
  star: 'community',
  watch: 'community',
  follow: 'community',
  starBeat: 'community',
}

const typesOf = (kind: ForgeContractKind): ReadonlySet<string> =>
  new Set(Object.entries(CONTRACT_OF_TYPE).flatMap(([t, k]) => (k === kind ? [t] : [])))

/** The three-contract homes (sakura's layout); a four-contract set moves {@link META_TYPES} out of them. */
export const CORE_TYPES: ReadonlySet<string> = typesOf('core')
export const COLLAB_TYPES: ReadonlySet<string> = typesOf('collab')
export const COMMUNITY_TYPES: ReadonlySet<string> = typesOf('community')

/**
 * The types forge-meta holds on a four-contract set (D44). None is read by a rule, total or
 * derived index of its old contract, so the move changes no consensus rule. {@link META_ONLY_TYPES}
 * are the exception: they have no three-contract home (`build.py` builds them with the
 * four-contract layout only), so on a network without forge-meta no contract holds them. Parity:
 * forge-core `layout::META_TYPES`.
 */
export const META_TYPES: ReadonlySet<string> = new Set([
  'repoKey',
  'ban',
  'label',
  'topic',
  'packMirror',
  'profile',
  'follow',
  'vaultEntry',
  'board',
  'card',
])

/**
 * The {@link META_TYPES} no three-contract set has: `vaultEntry` (UPDATE-2, the passkey vault),
 * `board` and `card` (UPDATE-3, `docs/design/boards.md` §3). On a network without forge-meta
 * {@link contractKindOfType} answers null for them. Parity: forge-core `layout::META_ONLY_TYPES`.
 */
export const META_ONLY_TYPES: ReadonlySet<string> = new Set(['vaultEntry', 'board', 'card'])

/**
 * The contract that holds `type` on the network `forge` describes: forge-meta for
 * {@link META_TYPES} when it has one, else the three-contract home (also the answer without
 * `forge`). Null for a type no forge-v2 contract has (e.g. the retired `manifestPart`). Parity:
 * forge-core `ForgeIds::contract_of`.
 */
export function contractKindOfType(type: string, forge?: Pick<ForgeIds, 'meta'> | null): ForgeContractKind | null {
  if (forge?.meta !== undefined && META_TYPES.has(type)) return 'meta'
  return CONTRACT_OF_TYPE[type] ?? null
}

/**
 * The contract kind a write of `type` goes to on `forge` (the write guard's grant check). A type
 * no contract holds is a developer error, caught by tests; it falls back to forge-core.
 */
export function writeContractKind(forge: Pick<ForgeIds, 'meta'> | null | undefined, type: string): ForgeContractKind {
  return contractKindOfType(type, forge) ?? 'core'
}

/**
 * The types RC1 stamps with their repo's visibility (`vis`, required): consensus proves it
 * against the repo (or the signer's member document) and refuses plaintext under `private`
 * (R-02, R-03, R-18, R-19).
 */
export const VIS_TYPES: ReadonlySet<string> = new Set([
  'maintainer',
  'writer',
  'refUpdate',
  'protectedRefUpdate',
  'config',
  'release',
  'issue',
  'patch',
  'comment',
  'review',
  'checkRun',
  'webhook',
])

/** The types whose `vis` may only be `"public"` (a topic or a trending beat of a private repo is refused). */
export const PUBLIC_ONLY_TYPES: ReadonlySet<string> = new Set(['topic', 'starBeat'])

/**
 * The stamped types whose `vis` the mainnet contract drops (R-11: a public repo is proved by the
 * reference alone, and a document carrying `vis` is refused): their writer leaves it out where the
 * registered contract no longer declares it, so a missing stamp is not a layout error here.
 */
export const VIS_DROPPED_TYPES: ReadonlySet<string> = new Set(['topic', 'webhook'])

/**
 * `data` with the `vis` stamp a create of `documentType` in a repo of `visibility` carries, or
 * `data` itself for a type that has none. A stamp already set is kept.
 */
export function withVis(visibility: 'public' | 'private', documentType: string, data: Record<string, unknown>): Record<string, unknown> {
  if (data['vis'] !== undefined) return data
  if (PUBLIC_ONLY_TYPES.has(documentType)) return { ...data, vis: 'public' }
  return VIS_TYPES.has(documentType) ? { ...data, vis: visibility } : data
}

/**
 * Why a create of `documentType` with `data` to `contractId` breaks the RC1 layout, or null.
 * Judged only for a write to one of `forge`'s contracts (any other contract, such as DPNS, is
 * not Forge's to judge): the type must be one that contract holds, and a stamped type must
 * carry a valid `vis`.
 */
export function rc1WriteProblem(forge: ForgeIds | null, contractId: string, documentType: string, data: Readonly<Record<string, unknown>>): string | null {
  if (forge === null || contractKind(forge, contractId) === null) return null
  const kind = contractKindOfType(documentType, forge)
  // copy-lint-ignore: a developer error naming a schema type, caught by tests before release
  if (kind === null) return `no Forge contract holds the document type ${JSON.stringify(documentType)}`
  if (forge[kind] !== contractId) return `a ${documentType} belongs in forge-${kind}, not the contract it was sent to`
  const vis = data['vis']
  if (vis === undefined && VIS_DROPPED_TYPES.has(documentType)) return null
  if (PUBLIC_ONLY_TYPES.has(documentType) && vis !== 'public') return `a ${documentType} must carry vis "public"`
  if (VIS_TYPES.has(documentType) && vis !== 'public' && vis !== 'private') return `a ${documentType} must carry its repo's visibility (vis)`
  return null
}
