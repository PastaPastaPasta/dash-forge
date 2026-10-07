/**
 * FORGE_RULES_V2 — the client rules for forge-v2 repositories (TypeScript port).
 *
 * Ports `crates/forge-core/src/rules/v2.rs` function for function; the conformance vectors
 * with `"rules": "v2"` in `forge-contracts/vectors/` hold the two in parity. See the Rust
 * module and `docs/contracts/forge-v2.md` (§3 events, §4 packs, §5 private repos, §6
 * numbering and approvals) for the normative text.
 *
 * The per-kind event effects live in `./fold`, shared with forge-core's `rules.rs`.
 */

import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

import {
  applyIssueEvent,
  applyPrEvent,
  issueStateOf,
  newIssueAcc,
  newPrAcc,
  prStateOf,
  sorted,
} from './fold'
import { compareKey, compareStrings, isLegalRefName, refNameHashMatches } from './oid'
import { statusOfCode } from './transition'
import type { Event, EventKind, IsAncestor, IssueState, Oid, PrState } from './types'

export * from './review'
export * from './parity'
export * from './moderation'
export * from './transition'
export * from './codeowners'
export * from './ref-collision'
export * from './merge-content'

/** The versioned rules identifier for forge-v2 repositories. */
export const FORGE_RULES_V2 = 'FORGE_RULES_V2' as const

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/**
 * A membership role: a `maintainer` document, or a `writer` document's `role` (RC2 member roles:
 * 1 writer, 2 triage, 3 reader). Ranked best first: maintainer, writer, triage, reader.
 */
export type Role = 'maintainer' | 'writer' | 'triage' | 'reader'

/** One current `maintainer` or `writer` document of a repository, flattened. */
export interface Membership {
  /** `memberId`. */
  readonly identity: string
  readonly role: Role
  /** Consensus `$createdAt` (ms). */
  readonly createdAt: number
}

const ROLE_RANK: Readonly<Record<Role, number>> = { maintainer: 0, writer: 1, triage: 2, reader: 3 }

function betterRole(a: Role | null, b: Role): Role {
  return a !== null && ROLE_RANK[a] <= ROLE_RANK[b] ? a : b
}

/** Whether `role` counts as an approver: a maintainer or a role-1 writer (never triage or reader). */
export function isApprover(role: Role | null | undefined): boolean {
  return role === 'maintainer' || role === 'writer'
}

/**
 * Membership of one repository, from its current membership documents. A revoked member's
 * document is deleted, so they are absent; a re-added member's membership starts at their
 * new document's `createdAt`.
 */
export class RoleOracle {
  constructor(readonly memberships: readonly Membership[]) {}

  /** The best role `identity` held at `at` (a current document with `createdAt <= at`). */
  roleAt(identity: string, at: number): Role | null {
    let role: Role | null = null
    for (const m of this.memberships) {
      if (m.identity === identity && m.createdAt <= at) role = betterRole(role, m.role)
    }
    return role
  }

  /**
   * Whether `identity` held any membership document at `at` (consensus `asMember` admits every
   * `writer` document, triage and reader included).
   */
  memberAt(identity: string, at: number): boolean {
    return this.roleAt(identity, at) !== null
  }

  /**
   * Whether `identity` was an approver at `at`: a maintainer or a role-1 writer. Approvals,
   * `approverRole 0` policies, requested changes and imported provenance count only approvers.
   */
  approverAt(identity: string, at: number): boolean {
    return isApprover(this.roleAt(identity, at))
  }

  /** Whether `identity` is an approver now (any current document). */
  currentApprover(identity: string): boolean {
    return this.approverAt(identity, Number.POSITIVE_INFINITY)
  }

  /** The best role `identity` holds now (any current document). */
  currentRole(identity: string): Role | null {
    return this.roleAt(identity, Number.POSITIVE_INFINITY)
  }
}

// ---------------------------------------------------------------------------
// Issue / PR state (transitions) and metadata fold
// ---------------------------------------------------------------------------

const STATE_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(['close', 'reopen', 'merge', 'draft', 'ready'])

/** A state kind lives only in `transition`; handed one on an `event`, the metadata fold ignores it. */
export function isStateKind(kind: EventKind): boolean {
  return STATE_KINDS.has(kind)
}

function metaLog(events: readonly Event[]): Event[] {
  return events.filter((e) => !isStateKind(e.kind)).sort(compareKey)
}

/** An issue's state: open from its state code, labels and assignees from its member events. */
export function issueStateV2(stateCode: number, events: readonly Event[]): IssueState {
  const s = newIssueAcc()
  for (const e of metaLog(events)) applyIssueEvent(s, e)
  s.open = statusOfCode(stateCode).open
  return issueStateOf(s)
}

/**
 * A PR's state: open, merged and draft from its state code; labels, assignees and base ref
 * from its member events. `mergeOnBase` (merged PRs whose merge oid is known) says whether the
 * merge named a valid base tip; a merge that did not is still merged, and labelled.
 * Parity: forge-core `pr_state_v2`.
 */
export function prStateV2(
  stateCode: number,
  mergeOid: string | null | undefined,
  events: readonly Event[],
  baseTip: string | undefined,
  isAncestor: IsAncestor,
): PrState {
  const s = newPrAcc()
  for (const e of metaLog(events)) applyPrEvent(s, e)
  const status = statusOfCode(stateCode)
  s.open = status.open
  s.merged = status.merged
  s.draft = status.draft
  const mergeOnBase =
    !status.merged || mergeOid == null || mergeOid === '' ? null : baseTip === undefined ? false : isAncestor(mergeOid, baseTip)
  return { ...prStateOf(s), mergeOnBase }
}

/**
 * The base a PR merges into and is judged against (Rust `MergeBase`): a ref name and the time
 * from which it must have been a branch (`prBaseTips`' `openedAt`).
 */
export interface MergeBase {
  readonly refName: string
  /** The patch's `$createdAt`, or the counted retarget's (D-501). */
  readonly since: number
  /** Whether a retarget (event kind 8) chose it. */
  readonly retargeted: boolean
}

/**
 * The newest retarget (event kind 8) with a legal ref name, in `($createdAt, $id)` order, else
 * the base the patch was opened with. A retarget after the merge (`mergedAt`, the merge
 * transition's `$createdAt`) does not count; a reader without the merge transition passes
 * `null` (every retarget counts). Parity: forge-core `pr_merge_base`.
 */
export function prMergeBase(
  openedBase: string,
  openedAt: number,
  events: readonly Event[],
  mergedAt: number | null,
): MergeBase {
  let base: MergeBase = { refName: openedBase, since: openedAt, retargeted: false }
  for (const e of metaLog(events)) {
    if (e.kind !== 'retarget' || (mergedAt !== null && e.createdAt > mergedAt)) continue
    if (e.value != null && isLegalRefName(e.value)) base = { refName: e.value, since: e.createdAt, retargeted: true }
  }
  return base
}

/**
 * The upstream number to show and resolve through (`#12 · upstream #7761`): trusted only from
 * the repo owner (the mirror signer) or a current approver (a maintainer or role-1 writer; triage
 * and readers are not trusted). Parity: forge-core `trusted_upstream_number`.
 */
export function trustedUpstreamNumber(
  upstreamNumber: number | null | undefined,
  author: string,
  repoOwner: string,
  oracle: RoleOracle,
): number | null {
  if (upstreamNumber == null || upstreamNumber <= 0) return null
  return author === repoOwner || oracle.currentApprover(author) ? upstreamNumber : null
}

// ---------------------------------------------------------------------------
// Pack copies
// ---------------------------------------------------------------------------

/** One writer's `packManifest` for a pack, with whether its bytes verified (caller-checked). */
export interface PackCopy {
  readonly id: string
  readonly packHash: string
  /** The uploader's current role ({@link RoleOracle.currentRole}); null once revoked. */
  readonly ownerRole?: Role | null
  readonly createdAt: number
  readonly verified?: boolean
  readonly supersedes?: readonly string[]
}

/** Maintainers' copies, then other current members' (any `writer` document), then everyone else's. */
function roleRank(role: Role | null | undefined): number {
  return role === 'maintainer' ? 0 : role == null ? 2 : 1
}

function compareCopies(a: PackCopy, b: PackCopy): number {
  return roleRank(a.ownerRole) - roleRank(b.ownerRole) || compareKey(a, b)
}

/** The order a reader tries a pack's copies in: role, then `createdAt`, then `id`. */
export function orderPackCopies(copies: readonly PackCopy[]): PackCopy[] {
  return [...copies].sort(compareCopies)
}

/** The first verified copy in {@link orderPackCopies} order, or null. */
export function selectPackCopy(copies: readonly PackCopy[]): PackCopy | null {
  return orderPackCopies(copies).find((c) => c.verified === true) ?? null
}

/** One readable pack in {@link packReadOrder}. */
export interface PackPick {
  readonly packHash: string
  readonly copyId: string
  readonly superseded: boolean
}

/**
 * Every readable pack of a repo, in fetch order: per pack hash the selected copy (packs with
 * no verified copy left out); packs a selected copy of another pack supersedes go last, not
 * dropped; then `createdAt`, then `packHash`.
 */
export function packReadOrder(copies: readonly PackCopy[]): PackPick[] {
  const hashes = [...new Set(copies.map((c) => c.packHash))].sort(compareStrings)
  const selected: PackCopy[] = []
  for (const hash of hashes) {
    const pick = selectPackCopy(copies.filter((c) => c.packHash === hash))
    if (pick !== null) selected.push(pick)
  }
  const superseded = new Set<string>()
  for (const c of selected) {
    for (const s of c.supersedes ?? []) if (s !== c.packHash) superseded.add(s)
  }
  const isSuperseded = (c: PackCopy) => superseded.has(c.packHash)
  selected.sort(
    (a, b) =>
      Number(isSuperseded(a)) - Number(isSuperseded(b)) ||
      a.createdAt - b.createdAt ||
      compareStrings(a.packHash, b.packHash),
  )
  return selected.map((c) => ({ packHash: c.packHash, copyId: c.id, superseded: isSuperseded(c) }))
}

// ---------------------------------------------------------------------------
// The pack list (packRef space)
// ---------------------------------------------------------------------------

/** A document's position in the platform total order: `($createdAt, $id)`. */
export interface CopyKey {
  readonly createdAt: number
  readonly id: string
}

/** One `packManifest` document of a repository, flattened for {@link v2PackList}. */
export interface PackCopyRow {
  readonly id: string
  readonly packHash: string
  /** 0 git pack, 1 objectLocator, 2 flatIndex. */
  readonly kind: number
  readonly createdAt: number
  /** The uploader's current role; null/absent for anyone else. */
  readonly ownerRole?: Role | null
  readonly sizeBytes?: number
  readonly objectCount?: number
  readonly chunkCount?: number
  readonly supersedes?: readonly string[]
  /** true: hash-checked OK; false: failed; absent: not checked. */
  readonly verified?: boolean | null
}

/** One pack of {@link v2PackList}. */
export interface V2Pack {
  /** The pack's position among the packs of its `kind` (a locator's `packRef`). */
  readonly packRef: number
  readonly packHash: string
  readonly kind: number
  readonly sizeBytes: number
  readonly objectCount: number
  readonly chunkCount: number
  readonly supersedes: readonly string[]
  /** The earliest `($createdAt, $id)` among every copy of the hash. */
  readonly first: CopyKey
  /** Usable copies in reader order; the representative first. */
  readonly copies: readonly string[]
  readonly superseded: boolean
}

/**
 * Whether a `supersedes` entry naming `claimed` counts (forge-v2.md §4): a pack never
 * supersedes itself, and a manifest supersedes only packs of its own kind.
 */
function claimCounts(claimantHash: string, claimantKind: number, claimedHash: string, claimedKind: number): boolean {
  return claimedHash !== claimantHash && claimedKind === claimantKind
}

/**
 * Every pack of a repository with its `packRef`, from all its `packManifest` copies
 * (forge-v2.md §4; the Rust `v2_pack_list`; vectors `v2_pack_list__*`). Kind-agnostic:
 * pass every copy and select a kind from the output.
 *
 * `asOf` (inclusive) drops later copies. Per hash, copies are ranked like
 * {@link orderPackCopies}; failed copies are dropped and the first remaining one is the
 * representative (a hash with none is left out), whose kind and metadata are the pack's;
 * copies of another kind leave `copies`. `first` is the earliest key among ALL the hash's
 * copies; `packRef` is the index by `first` among packs of the same kind. A pack is
 * superseded only by a listed pack of the same kind whose representative verified (`true`).
 * Output order: kind, then packRef.
 */
export function v2PackList(copies: readonly PackCopyRow[], asOf?: CopyKey | null): V2Pack[] {
  const groups = new Map<string, PackCopyRow[]>()
  for (const c of copies) {
    if (asOf && compareKey(c, asOf) > 0) continue
    const g = groups.get(c.packHash)
    if (g) g.push(c)
    else groups.set(c.packHash, [c])
  }
  const packs: { pack: Omit<V2Pack, 'packRef' | 'superseded'>; verified: boolean }[] = []
  for (const hash of [...groups.keys()].sort(compareStrings)) {
    const group = groups.get(hash) as PackCopyRow[]
    const firstCopy = [...group].sort(compareKey)[0] as PackCopyRow
    const ranked = [...group].sort(
      (a, b) => roleRank(a.ownerRole) - roleRank(b.ownerRole) || compareKey(a, b),
    )
    const usable = ranked.filter((c) => c.verified !== false)
    const rep = usable[0]
    if (!rep) continue
    packs.push({
      pack: {
        packHash: hash,
        kind: rep.kind,
        sizeBytes: rep.sizeBytes ?? 0,
        objectCount: rep.objectCount ?? 0,
        chunkCount: rep.chunkCount ?? 0,
        supersedes: [...(rep.supersedes ?? [])],
        first: { createdAt: firstCopy.createdAt, id: firstCopy.id },
        copies: usable.filter((c) => c.kind === rep.kind).map((c) => c.id),
      },
      verified: rep.verified === true,
    })
  }
  const kindOf = new Map(packs.map(({ pack }) => [pack.packHash, pack.kind]))
  const superseded = new Set<string>()
  for (const { pack, verified } of packs) {
    if (!verified) continue
    for (const s of pack.supersedes) {
      const kind = kindOf.get(s)
      if (kind !== undefined && claimCounts(pack.packHash, pack.kind, s, kind)) superseded.add(s)
    }
  }
  const sorted = packs
    .map((p) => p.pack)
    .sort((a, b) => a.kind - b.kind || compareKey(a.first, b.first))
  const out: V2Pack[] = []
  let kind: number | null = null
  let index = 0
  for (const p of sorted) {
    if (p.kind !== kind) {
      kind = p.kind
      index = 0
    }
    out.push({ packRef: index++, ...p, superseded: superseded.has(p.packHash) })
  }
  return out
}

/**
 * The `kind` artifacts write-side planning treats as superseded (the Rust
 * `planning_superseded`; vectors `planning_superseded__*`), sorted: hashes named by a
 * manifest of that kind whose uploader is currently a maintainer or writer. The web plans no
 * repack or reindex; this port keeps the shared rule checked from both sides.
 */
export function planningSuperseded(copies: readonly PackCopyRow[], kind: number): string[] {
  const out = new Set<string>()
  for (const c of copies) {
    if (c.kind !== kind || (c.ownerRole !== 'maintainer' && c.ownerRole !== 'writer')) continue
    for (const s of c.supersedes ?? []) if (claimCounts(c.packHash, c.kind, s, kind)) out.add(s)
  }
  return [...out].sort(compareStrings)
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/** A `review` document, flattened. */
export interface Review {
  readonly id: string
  readonly reviewer: string
  /** 1 approve, 2 request changes, 3 comment. */
  readonly verdict: number
  readonly commitOid: Oid
  readonly createdAt: number
}

/** The reviewers whose verdict stands on a PR's current head (each sorted). */
export interface Approvals {
  readonly approvers: readonly string[]
  readonly changesRequested: readonly string[]
}

/**
 * Count a PR's approvals, `forge-v2.md` §6: only reviews on `headOid` (the folded head) by a
 * reviewer who was an approver (a maintainer or role-1 writer) at the review's `createdAt`
 * (consensus admits a triage member's or reader's member verdict; it is shown, never counted); a reviewer's newest approve /
 * request-changes review by `(createdAt, id)` stands; comment and unknown verdicts, and
 * reviews in `dismissed` (the ids a `reviewDismiss` names), are ignored.
 *
 * The PR's own author (`prAuthor`, the patch's owner) never counts: as on GitHub, an author
 * cannot approve (or request changes on) their own PR, so one person alone never meets a branch
 * policy. Consensus admits the review (it carries no PR author); this is the clients' rule, and
 * they show such a review as "author, not counted".
 */
export function countApprovals(
  reviews: readonly Review[],
  oracle: RoleOracle,
  headOid: string,
  dismissed: ReadonlySet<string>,
  prAuthor: string,
): Approvals {
  const approvers = new Set<string>()
  const changesRequested = new Set<string>()
  const counting = reviews
    .filter(
      (r) =>
        (r.verdict === 1 || r.verdict === 2) &&
        r.reviewer !== prAuthor &&
        !dismissed.has(r.id) &&
        r.commitOid === headOid &&
        oracle.approverAt(r.reviewer, r.createdAt),
    )
    .sort(compareKey)
  for (const r of counting) {
    const [add, clear] = r.verdict === 1 ? [approvers, changesRequested] : [changesRequested, approvers]
    clear.delete(r.reviewer)
    add.add(r.reviewer)
  }
  return { approvers: sorted(approvers), changesRequested: sorted(changesRequested) }
}

// ---------------------------------------------------------------------------
// Well-formedness
// ---------------------------------------------------------------------------

export type Visibility = 'public' | 'private'

export type ContentKind = 'issue' | 'patch' | 'comment' | 'review' | 'refUpdate' | 'config'

/**
 * A document's content fields. An absent field, an empty string and an empty
 * `protectedPatterns` list are the same.
 */
export interface ContentDoc {
  readonly kind: ContentKind
  readonly title?: string | null
  readonly body?: string | null
  readonly refName?: string | null
  readonly baseRefName?: string | null
  readonly sourceRefName?: string | null
  /** `refNameHash` (ref updates), hex: the indexed key `refName` must hash to. */
  readonly refNameHash?: string | null
  /** `baseRefNameHash` (patches), hex. */
  readonly baseRefNameHash?: string | null
  /** `sourceRefNameHash` (patches), hex. */
  readonly sourceRefNameHash?: string | null
  /** `config.defaultBranch`. */
  readonly defaultBranch?: string | null
  /** `config.protectedPatterns`. */
  readonly protectedPatterns?: readonly string[] | null
  /** `comment.path` (an inline review comment's file); a content field (private-repos.md §8.1). */
  readonly path?: string | null
  /** `enc`, hex. */
  readonly enc?: string | null
  readonly epoch?: number | null
}

type Field = string | readonly string[] | null | undefined

function present(f: Field): boolean {
  return f != null && f.length > 0
}

/** A kind's required plaintext field (null: none) and all of its plaintext fields. */
function contentFields(doc: ContentDoc): [Field | null, Field[]] {
  switch (doc.kind) {
    case 'issue':
      return [doc.title, [doc.title, doc.body]]
    case 'patch':
      return [doc.title, [doc.title, doc.body, doc.baseRefName, doc.sourceRefName]]
    case 'comment':
      return [doc.body, [doc.body, doc.path]]
    case 'review':
      return [null, [doc.body]]
    case 'refUpdate':
      return [doc.refName, [doc.refName]]
    case 'config':
      return [null, [doc.defaultBranch, doc.protectedPatterns]]
  }
}

/**
 * Plaintext xor `enc`, and the visibility says which (`forge-v2.md` §5): a public repo's
 * document has no `enc`, its kind's required plaintext field, if the kind has one, and ref
 * names that hash (sha256) to their indexed keys ({@link refNameHashesAgree}); a private
 * repo's has a non-empty `enc`, an `epoch`, and none of its kind's plaintext fields (its
 * names are checked after decryption).
 */
export function isWellFormed(doc: ContentDoc, visibility: Visibility): boolean {
  const [required, plaintext] = contentFields(doc)
  const encrypted = present(doc.enc)
  if (visibility === 'public') {
    return !encrypted && (required === null || present(required)) && refNameHashesAgree(doc, null)
  }
  return encrypted && doc.epoch != null && !plaintext.some(present)
}

/**
 * Whether every ref name a document carries hashes to the key it is indexed under
 * (`refName`/`refNameHash`, `baseRefName`/`baseRefNameHash`, `sourceRefName`/
 * `sourceRefNameHash`); ports `ref_name_hashes_agree` (vectors `ref_name_hashes__*`).
 * `refKey` null: public, `sha256(name)`. Otherwise the epoch's `K_ref` (hex) and `doc` the
 * decrypted content: `HMAC-SHA256(K_ref, name)` (`docs/security/private-repos.md` §4.5). A
 * present name needs its hash, and they must agree (hex, case-insensitive); a hash with no
 * name has nothing to check.
 */
export function refNameHashesAgree(doc: ContentDoc, refKey: string | null): boolean {
  const key = refKey === null ? null : hexToBytes(refKey)
  const matches = (name: string, hash: string): boolean =>
    key === null
      ? refNameHashMatches(name, hash)
      : bytesToHex(hmac(sha256, key, new TextEncoder().encode(name))) === hash.toLowerCase()
  const agrees = (name: string | null | undefined, hash: string | null | undefined): boolean =>
    name == null || name.length === 0 || (hash != null && hash.length > 0 && matches(name, hash))
  switch (doc.kind) {
    case 'refUpdate':
      return agrees(doc.refName, doc.refNameHash)
    case 'patch':
      return agrees(doc.baseRefName, doc.baseRefNameHash) && agrees(doc.sourceRefName, doc.sourceRefNameHash)
    default:
      return true
  }
}

// ---------------------------------------------------------------------------
// Repository names
// ---------------------------------------------------------------------------

const REPO_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/

/** Whether `name` is a valid `repo.name` (the contract's pattern). */
export function isValidRepoName(name: string): boolean {
  return REPO_NAME.test(name)
}

/** ASCII letters lowercased, nothing else changed; null when the result is not valid. */
export function normalizeRepoName(input: string): string | null {
  const lowered = input.replace(/[A-Z]/g, (c) => c.toLowerCase())
  return isValidRepoName(lowered) ? lowered : null
}
