/**
 * Membership changes of a private repo (`docs/security/private-repos.md` §5.5, §5.6): adding a
 * member (membership document, then a wrap of the current epoch), removing one (delete, then
 * rotate), and the repair check a maintainer's client runs on every visit.
 *
 * Rotation, in the normative order: delete the membership → wait until a member-list read no
 * longer shows the removed identity → re-read the anchors (a fresh session), `n` = the current
 * epoch, which must be readable → a new key for `n+1` → wraps to every remaining member, SELF
 * FIRST, explicitly excluding the removed identity even if a stale read still lists it → the
 * anchor `config` for `n+1` (current `defaultBranch` / `protectedPatterns`, `prevEpoch = n`,
 * `prevEpochKey = K_n`) → poll until `resolveEpochs` shows the anchor of `n+1` is this
 * identity's; if another current maintainer's won, stop and say so.
 *
 * No epoch key is ever stored (not in IndexedDB, not in memory past the call). The self-wrap,
 * posted first, is the journal: a rotation that stopped after it is resumed by unwrapping that
 * self-wrap and reusing its key and epoch ({@link planRotation}).
 */

import type { EvoSDK, IdentityPublicKey } from '@dashevo/evo-sdk'

import { base58Encode, decodeIdentifier } from '../auth/base58'
import type { EncKeyLike, EncryptionOps } from '../auth/encryption-key'
import { fetchIdentityKeys, heldKeysText, usableEncryptionKey } from '../auth/encryption-key'
import type { Network } from '../constants'
import {
  EpochKeys,
  IdSet,
  selectAnchors,
  bytesEqual,
  compareBytes,
  generateEpochKey,
  WrapError,
  bytesToHex,
  openContent,
  openWithKey,
  sealDoc,
  type Anchor,
} from '../private'
import type { Membership, Role } from '../rules/v2'
import {
  ConsensusRefusal,
  DUPLICATE_UNIQUE_CODE,
  GATE_REFUSED_CODE,
  createDocumentIdempotent,
  previewCreate,
  previewDelete,
  queryDocumentsWithProof,
  sumPreviews,
  type CostPreview,
  type WriteAuth,
} from '../sdk'
import { sleep } from '../sdk/facade'
import { DOC, withVis, type RepoRef } from './contract'
import { anchorContent, type AnchorContent, type ChainLink } from './members-anchor'
import { noteMembersKey } from './members-writes'
import { holdsMembersKey } from '../rules/roles'
import { invalidateMembers, memberDocOf, readMemberships } from './members'
import {
  isMaintainer,
  loadPrivateSessionUncached,
  shortBranch,
  parseWrapDoc,
  sdkSessionSource,
  sessionUnwrapper,
  type PrivateSession,
  type WrapDoc,
} from './private-session'
import { contractOf, repoSource } from './source'
import { CONSENT_LAG_RETRIES, ConsentMissingError, assertNoPlaintext, findConsent, grantMembershipDoc, revokeMembershipDoc } from './writes'
import { retryWhileMissing } from '../view/retry'
import { shortId } from '../utils'


/** An identity as the messages name it: its first 7 and last 5 characters. */
const short = shortId

/** Whether the current epoch is burned (§5.3): chain-only, nothing is written under it. */
export function currentBurned(r: PrivateSession['resolution']): boolean {
  return r.currentEpoch !== null && r.burned.has(r.currentEpoch)
}

/** A private-repo membership change that cannot go ahead, with the message to show. */
export class PrivateMembersError extends Error {
  constructor(
    message: string,
    /** The CLI's error code for the same condition (E306–E310). */
    readonly code?: string,
    /** A rotation that ended without its anchor in effect: another maintainer's key is the repo's. */
    readonly outcome?: 'lost' | 'preempted' | 'mismatch',
    /** The key epochs the change would hand to another key (kept out of the message). */
    readonly epochs?: readonly number[],
  ) {
    super(message)
    this.name = 'PrivateMembersError'
  }
}

/** One recipient of a rotation's wraps. */
export interface RotationRecipient {
  /** base58 identity. */
  readonly identity: string
  /** The key the wrap goes to (the member's highest usable ENCRYPTION key). */
  readonly keyId: number
  /** A wrap by this identity to this member for the rotation's epoch already exists (resume). */
  readonly done: boolean
}

/** What a rotation will write (§5.5), before anything is signed. */
export interface RotationPlan {
  /** The current epoch `n`. */
  readonly from: number
  /** The new epoch. */
  readonly epoch: number
  /** Resume an interrupted rotation: its key comes from this self-wrap (never from storage). */
  readonly resume: WrapDoc | null
  /**
   * The pending epoch's key reached someone outside the remaining members: it is anchored burned
   * (chain-only) and the rotation goes on to `epoch + 1` (§5.3).
   */
  readonly burn: boolean
  /** Self first, then the rest in byte order. */
  readonly recipients: readonly RotationRecipient[]
  /** Remaining members with no usable encryption key: they cannot be wrapped (they read nothing new). */
  readonly unreachable: readonly string[]
  /** Identities explicitly excluded (removed, or wrapped without being members). */
  readonly excluded: readonly string[]
}

/**
 * Plan a rotation for `self` over `session` (pure). `exclude`: identities that must not receive
 * the new key, whatever a (possibly stale) member list says. Throws {@link PrivateMembersError}
 * when the current epoch is not readable by `self` or `self` is not a current maintainer.
 */
export function planRotation(
  session: PrivateSession,
  self: string,
  exclude: readonly string[],
  coreId: string,
  /**
   * The ids of the encryption keys this browser holds (one id: that key alone): only a self-wrap
   * to one of them can be resumed, and the rotator's newest usable key must be among them.
   */
  held: number | readonly number[],
  /** The epoch the rotation chains from: the current one, or the one a maintainer's removal keeps. */
  from: number | null = session.resolution.currentEpoch,
): RotationPlan {
  const r = session.resolution
  const heldIds = typeof held === 'number' ? [held] : held
  const n = from
  if (n === null) throw new PrivateMembersError('this repo has no key epoch yet')
  // The current key must be readable to chain from (a burned current epoch still chains).
  if (!r.keys.has(n)) {
    throw new PrivateMembersError(`you can't read the current key (epoch ${n}); ask another maintainer to rotate`, 'E310')
  }
  if (!isMaintainer(session, self)) {
    throw new PrivateMembersError('only a current maintainer can rotate the repo key')
  }
  const selfId = decodeIdentifier(self)
  const excluded = new Set(exclude)
  // Who holds the key (`holdsMembersKey`): every member of a private repo; a public repo's roles that hold its members key.
  const visibility = session.gate.visibility
  const remaining = [...new Set(session.members.filter((m) => holdsMembersKey(m.role, visibility)).map((m) => m.identity))].filter((id) => !excluded.has(id))
  if (!remaining.includes(self)) throw new PrivateMembersError('you cannot remove yourself this way')

  // Epochs are contiguous (§5.3): the new one is always n + 1. A rotation that stopped after its
  // self-wrap left a pending n + 1 (the unique index keeps that wrap): its key is the one n + 1
  // must use, unless it must be burned ({@link mustBurn}): anchored chain-only, then n + 2.
  const epoch = n + 1
  if (epoch > 0xffff_ffff) throw new PrivateMembersError('no key epoch number is left')
  const resume = pendingSelfWrap(session, self, epoch)
  if (resume !== null && !heldIds.includes(resume.row.recipientKeyId)) {
    throw notHeldKey(epoch, resume.row.recipientKeyId)
  }
  const mine = ownWraps(session, selfId, epoch)
  const wrappedBySelf = new Set(mine.map((w) => base58Encode(w.row.memberId)))
  const ordered = [self, ...remaining.filter((id) => id !== self).sort((a, b) => compareBytes(decodeIdentifier(a), decodeIdentifier(b)))]
  const recipients: RotationRecipient[] = []
  const unreachable: string[] = []
  for (const id of ordered) {
    const key = usableEncryptionKey(session.memberKeys.get(id) ?? [], coreId)
    if (key === null) {
      if (id === self) throw new PrivateMembersError('your identity has no usable encryption key', 'E306')
      unreachable.push(id)
      continue
    }
    // §5.2: the new key goes to each member's newest usable key, the rotator's own included. If
    // this browser holds an older one, the rotator would lose the epoch it creates: refused.
    if (id === self && !heldIds.includes(key.keyId)) throw staleHeldKey(heldIds, key.keyId)
    recipients.push({ identity: id, keyId: key.keyId, done: wrappedBySelf.has(id) })
  }
  const burn = mustBurn(exclude.length > 0, resume !== null, mine, recipients, remaining)
  return { from: n, epoch, resume, burn, recipients, unreachable, excluded: [...excluded] }
}

/** This browser holds encryption keys `held`, but not the identity's newest usable key `current`. */
function staleHeldKey(held: readonly number[], current: number): PrivateMembersError {
  return new PrivateMembersError(
    `this browser holds ${heldKeysText(held)}, but your identity's current key is ${current}: the new repo key would go to key ${current}, which you couldn't read here. Import key ${current} (Settings → Private repos), or rotate from the CLI with it.`,
    'E306',
  )
}

/** A pending self-wrap of `epoch` to a key of ours this browser does not hold: it cannot be resumed here. */
function notHeldKey(epoch: number, keyId: number): PrivateMembersError {
  return new PrivateMembersError(
    `your pending key wrap of epoch ${epoch} went to your key ${keyId}, which this browser does not hold; add it here, or ask another maintainer to rotate`,
    'E310',
  )
}

/** This signer's wraps at `epoch` in `session`. */
function ownWraps(session: PrivateSession, selfId: Uint8Array, epoch: number): WrapDoc[] {
  return session.wraps.filter((w) => bytesEqual(w.row.owner, selfId) && w.row.epoch === epoch)
}

/** This signer's standing self-wrap at `epoch` (an earlier run's journal), or null. */
function pendingSelfWrap(session: PrivateSession, self: string, epoch: number): WrapDoc | null {
  const selfId = decodeIdentifier(self)
  return ownWraps(session, selfId, epoch).find((w) => bytesEqual(w.row.memberId, selfId)) ?? null
}

/**
 * Whether a pending epoch must be burned rather than finished (§5.3, §5.5; parity: forge-core
 * `keyring::rotate`): a removal never finishes a resumed epoch (a lagging read may hide the
 * earlier run's wrap to the member being removed); any run burns one whose wraps reached someone
 * outside the remaining members, or hold a key a remaining member no longer uses (a wrap cannot
 * be replaced within an epoch).
 */
function mustBurn(
  removing: boolean,
  resumed: boolean,
  mine: readonly WrapDoc[],
  recipients: readonly RotationRecipient[],
  remaining: readonly string[],
): boolean {
  if (removing && resumed) return true
  return mine.some((w) => {
    const id = base58Encode(w.row.memberId)
    if (!remaining.includes(id)) return true
    const r = recipients.find((x) => x.identity === id)
    return r !== undefined && r.keyId !== w.row.recipientKeyId
  })
}

/** The cost shown before a public repo's role change `from` → `to`: the old document's delete, then the new one. */
export function roleChangeCost(from: Role, to: Role): CostPreview {
  return sumPreviews([previewDelete(memberDocOf(from)), previewCreate(memberDocOf(to))])
}

/** The cost shown before a rotation: its wraps plus the anchor (§5.5: members + 1). */
export function rotationCost(plan: RotationPlan): CostPreview {
  // A burn: the burned key to every remaining member without one (so anyone can finish it), the
  // burned anchor, then every remaining member wrapped at the next epoch, then its anchor.
  const missing = plan.recipients.filter((x) => !x.done).length
  const wraps = plan.burn ? missing + plan.recipients.length : missing
  return sumPreviews([...Array.from({ length: wraps }, () => previewCreate('repoKey')), previewCreate('config'), ...(plan.burn ? [previewCreate('config')] : [])])
}

/** The cost shown before adding a member: the membership document and one wrap (~0.0006 DASH). */
export function addMemberCost(role: Role): CostPreview {
  return sumPreviews([previewCreate(memberDocOf(role)), previewCreate('repoKey')])
}

/** What a maintainer's client should do on this visit (§5.6), or null when nothing. */
export interface RepairPlan {
  /** Wrapped identities that are not members: the key must rotate. */
  readonly rotate: readonly string[]
  /** Members with no wrap to an enabled key for the current epoch, who have a usable key. */
  readonly wrap: readonly string[]
  /** Members with no wrap who have no usable key yet (nothing to do until they add one). */
  readonly waiting: readonly string[]
  /**
   * The current epoch is burned (§5.3): nothing can be written under it, so the key must rotate
   * even when no non-member holds it. Any maintainer finishes a burn.
   */
  readonly burned: boolean
}

/** The repair plan of `session` for `self` (pure); null when the check passes or self is not a maintainer. */
export function planRepair(session: PrivateSession, self: string, coreId: string): RepairPlan | null {
  const r = session.resolution
  const repair = r.repair
  if (repair === null || !isMaintainer(session, self)) return null
  const rotate = repair.nonMembers.map(base58Encode)
  const burned = currentBurned(r)
  const wrap: string[] = []
  const waiting: string[] = []
  for (const m of repair.missingWraps.map(base58Encode)) {
    if (usableEncryptionKey(session.memberKeys.get(m) ?? [], coreId) === null) waiting.push(m)
    else wrap.push(m)
  }
  if (rotate.length === 0 && wrap.length === 0 && waiting.length === 0 && !burned) return null
  return { rotate, wrap, waiting, burned }
}

// ---------------------------------------------------------------------------
// Flows (sign and broadcast)
// ---------------------------------------------------------------------------

/** What every flow needs. */
export interface PrivateWriteContext {
  readonly sdk: EvoSDK
  readonly auth: WriteAuth
  readonly repo: RepoRef
  readonly network: Network
  readonly ops: EncryptionOps
}

export type RotationStep =
  | { readonly kind: 'deleted' }
  | { readonly kind: 'waiting'; readonly what: string }
  | { readonly kind: 'wrapped'; readonly identity: string; readonly epoch: number }
  | { readonly kind: 'anchored'; readonly epoch: number }
  | { readonly kind: 'lost'; readonly epoch: number }
  /** The epoch's key reached someone it must not: anchored chain-only (§5.3), then the next. */
  | { readonly kind: 'burned'; readonly epoch: number }
  | { readonly kind: 'reanchored'; readonly epoch: number }

/** A fresh session (§5.3: anchors are re-read before every write). */
async function withFreshSession<T>(
  c: PrivateWriteContext,
  use: (s: PrivateSession) => Promise<T>,
  drop?: readonly { readonly identity: string; readonly role?: Role }[],
): Promise<T> {
  invalidateMembers(c.repo, c.network)
  // Uncached: it never replaces the session the page reads through, and it ends with the step.
  const session = await loadPrivateSessionUncached(c.sdk, c.repo, c.network, c.auth.identityId, sessionUnwrapper(c.ops), drop)
  try {
    return await use(session)
  } finally {
    session.close()
  }
}

function keyOf(session: PrivateSession, identity: string, keyId: number): IdentityPublicKey {
  const k = session.memberKeys.get(identity)?.find((x) => x.keyId === keyId)
  if (k === undefined) throw new PrivateMembersError(`the encryption key of ${short(identity)} could not be read`)
  return k as unknown as IdentityPublicKey
}

/**
 * This identity's writer key: the newest usable ENCRYPTION key on chain among those this browser
 * holds (a held key disabled since is never it). It sends every wrap, and gets the self-wraps.
 */
function senderKey(session: PrivateSession, c: PrivateWriteContext): IdentityPublicKey {
  const mine = session.memberKeys.get(c.auth.identityId) ?? []
  const k = usableEncryptionKey(mine.filter((x) => c.ops.keyIds.includes(x.keyId)), c.repo.forge.core) as (EncKeyLike & IdentityPublicKey) | null
  if (k === null) {
    throw new PrivateMembersError('no encryption key in this browser is still enabled on your identity; import your current one', 'E306')
  }
  return k
}

/**
 * The raw key of the reader's readable epoch `epoch`, from its own accepted wrap (a wrap to self
 * from a current maintainer whose key matches the anchor). The caller wipes it.
 */
async function rawEpochKey(session: PrivateSession, c: PrivateWriteContext, epoch: number): Promise<{ keys: EpochKeys; raw: Uint8Array }> {
  if (!session.resolution.keys.has(epoch)) throw new PrivateMembersError(`you can't read epoch ${epoch}`, 'E307')
  for (const w of acceptedOwnWraps(session, c.auth.identityId, epoch)) {
    return c.ops.unwrapRaw({
      document: w.raw,
      counterpartyKey: keyOf(session, base58Encode(w.row.owner), w.senderKeyId),
      repoId: session.repoId,
      epoch,
    })
  }
  throw new PrivateMembersError(`no wrap of epoch ${epoch} to you was found`, 'E307')
}

/** The reader's own wraps for `epoch` whose key is the epoch's key (accepted, §5.4). */
function acceptedOwnWraps(session: PrivateSession, self: string, epoch: number): WrapDoc[] {
  const want = session.resolution.keys.get(epoch)
  if (want === undefined) return []
  const selfId = decodeIdentifier(self)
  return session.wraps.filter(
    (w) =>
      w.row.epoch === epoch &&
      w.row.keys !== undefined &&
      bytesEqual(w.row.memberId, selfId) &&
      bytesEqual(w.row.keys.commit, want.commit) &&
      isMaintainer(session, base58Encode(w.row.owner)),
  )
}

/** Post one `repoKey` wrapping `raw` (epoch `keys.epoch`) to `identity`'s key `keyId`. */
/** How posting one wrap ended (parity: forge-core `keyring::WrapOutcome`). */
export type WrapOutcome =
  /** A new wrap landed, or this signer's standing wrap holds the same key to the same key id. */
  | { readonly kind: 'same' }
  /** This signer's wrap stands with another key or to another recipient key (it cannot be replaced). */
  | { readonly kind: 'different' }
  /** This signer's wrap stands and cannot be read back (sealed from a key this browser lacks). */
  | { readonly kind: 'unreadable' }
  /**
   * The recipient holds no maintainer or writer document any more (removed since the plan was
   * read; consensus refused the wrap, 40120 on `memberId`, RC1 R-13): nothing was written.
   */
  | { readonly kind: 'not-a-member' }

/** Whether a refusal is RC1 `wrap_member`'s: the wrap names no current maintainer or writer. */
export function isWrapNotAMember(e: unknown): boolean {
  return e instanceof ConsensusRefusal && e.code === GATE_REFUSED_CODE && /not found for path memberId\b/.test(e.message)
}

/** The outcome of a standing wrap read back as (its key's commitment, its recipient key id). */
export function wrapOutcome(
  standing: { readonly commit: Uint8Array; readonly recipientKeyId: number } | null,
  want: { readonly commit: Uint8Array; readonly keyId: number },
): WrapOutcome {
  if (standing === null) return { kind: 'unreadable' }
  return bytesEqual(standing.commit, want.commit) && standing.recipientKeyId === want.keyId ? { kind: 'same' } : { kind: 'different' }
}

/**
 * Before a key goes to anyone: read the member list again, after the session's configs and wraps
 * were read, and require it to agree with the session's (minus what this flow just deleted). The
 * two reads can come from different nodes; a lagging membership read beside a fresh config read
 * would hand the current key to someone removed a moment ago. Refuses on any difference.
 */
async function assertMembersSettled(
  c: PrivateWriteContext,
  session: PrivateSession,
  drop: readonly { readonly identity: string; readonly role?: Role }[] = [],
): Promise<void> {
  const again = (await readMemberships(c.sdk, c.repo)).filter(
    (m) => !drop.some((d) => d.identity === m.identity && (d.role === undefined || d.role === m.role)),
  )
  const key = (rows: readonly Membership[]): string => rows.map((m) => `${m.role}:${m.identity}`).sort().join(',')
  if (key(again) !== key(session.members)) {
    throw new PrivateMembersError('the member list is still changing on Platform; nothing was sent. Try again in a moment.', 'E310')
  }
}

/** Post a sealed private `config` (a rotation anchor or a re-anchor); never with plaintext content. */
async function postConfig(c: PrivateWriteContext, data: Record<string, unknown>, intent: string): Promise<void> {
  assertNoPlaintext(c.repo, DOC.config, data)
  await createDocumentIdempotent(c.sdk, c.auth, { contractId: c.repo.forge.core, documentType: DOC.config, data: withVis(c.repo.visibility, DOC.config, data), intent })
}

/**
 * What a new anchor (a rotation, a re-anchor, epoch 0) of `c.repo` carries ({@link anchorContent},
 * pinned by the `mixed_anchor__*` vectors): a private repo repeats its current branch and patterns
 * (a `main` default when none opens) sealed, and `backend` / `archived` in plaintext; a public
 * repo's members key carries none of its settings, so no anchor is ever read as them (DESIGN D1).
 */
function anchorOf(c: PrivateWriteContext, session: PrivateSession, link: ChainLink | null): AnchorContent {
  return anchorContent(
    c.repo.visibility,
    {
      defaultBranch: session.config?.defaultBranch ?? 'main',
      protectedPatterns: session.config?.protectedPatterns ?? [],
      backend: session.configPlain?.backend ?? { mode: 0 },
      archived: session.configPlain?.archived ?? false,
    },
    link,
  )
}

/** A short, public tag of an epoch key (its commitment): binds a signed write to the key it carries. */
function keyTag(keys: EpochKeys): string {
  return bytesToHex(keys.commit).slice(0, 16)
}

/**
 * A `repoKey` document of `repoId`: `props`, the wrap `sealWrap` sealed (`wrapped`,
 * `recipientKeyId`, `senderKeyId`), addressed to `identity` for `epoch`.
 */
export function repoKeyData(repoId: string, identity: string, epoch: number, props: Record<string, unknown>): Record<string, unknown> {
  return { repoId: decodeIdentifier(repoId), memberId: decodeIdentifier(identity), epoch, ...props }
}

/**
 * Post one `repoKey` wrapping `raw` (epoch `keys.epoch`) to `identity`'s key `keyId`. The write's
 * intent names the key, so a retry never replays a wrap of another key. When this signer's wrap
 * for (member, epoch) already stands (the unique index), it is read back — a sender opens its own
 * wraps with the recipient's public key — and the outcome says whether it holds this key.
 */
async function postWrap(
  c: PrivateWriteContext,
  session: PrivateSession,
  keys: EpochKeys,
  raw: Uint8Array,
  identity: string,
  keyId: number,
  intent: string,
): Promise<WrapOutcome> {
  const props = await c.ops.wrap({ keys, raw, senderKey: senderKey(session, c), recipientKey: keyOf(session, identity, keyId) })
  const data = repoKeyData(c.repo.repoId, identity, keys.epoch, props)
  assertNoPlaintext(c.repo, DOC.repoKey, data)
  try {
    await createDocumentIdempotent(c.sdk, c.auth, {
      contractId: contractOf(c.repo.forge, DOC.repoKey),
      documentType: DOC.repoKey,
      data,
      intent: `${intent}:wrap:${keys.epoch}:${keyTag(keys)}:${identity}`,
    })
    return { kind: 'same' }
  } catch (e) {
    // Removed since the plan was read: the caller re-plans without them (parity: forge-core
    // `WrapOutcome::NotAMember`).
    if (isWrapNotAMember(e)) return { kind: 'not-a-member' }
    if (!(e instanceof ConsensusRefusal && e.code === DUPLICATE_UNIQUE_CODE)) throw e
  }
  return standingOutcome(c, session, keys, identity, keyId)
}

/** The outcome of this signer's standing wrap of `keys.epoch` to `identity`, read back. */
async function standingOutcome(c: PrivateWriteContext, session: PrivateSession, keys: EpochKeys, identity: string, keyId: number): Promise<WrapOutcome> {
  const standing = await readOwnWrap(c, session, keys.epoch, identity)
  try {
    return wrapOutcome(standing === null ? null : { commit: standing.keys.commit, recipientKeyId: standing.recipientKeyId }, { commit: keys.commit, keyId })
  } finally {
    standing?.raw.fill(0)
  }
}

/**
 * This signer's standing wrap of `epoch` to `identity`, opened with this browser's key and the
 * recipient's public key (ECDH is symmetric): its key and recipient key id, or null when it
 * cannot be read (sealed from a key this browser does not hold). The caller wipes `raw`.
 */
async function readOwnWrap(
  c: PrivateWriteContext,
  session: PrivateSession,
  epoch: number,
  identity: string,
): Promise<{ keys: EpochKeys; raw: Uint8Array; recipientKeyId: number } | null> {
  const { documents } = await queryDocumentsWithProof(
    c.sdk,
    repoSource(c.repo).repoQuery(DOC.repoKey, {
      where: [
        ['memberId', '==', identity],
        ['epoch', '==', epoch],
        ['$ownerId', '==', c.auth.identityId],
      ],
      orderBy: [
        ['memberId', 'asc'],
        ['epoch', 'asc'],
        ['$ownerId', 'asc'],
      ],
      limit: 1,
    }),
  )
  const doc = documents[0]
  const w = doc === undefined ? null : parseWrapDoc(doc)
  if (w === null || !c.ops.keyIds.includes(w.senderKeyId)) return null
  const recipient = (session.memberKeys.get(identity) ?? (await fetchIdentityKeys(c.sdk, identity)) ?? []).find((k) => k.keyId === w.row.recipientKeyId)
  if (recipient === undefined) return null
  try {
    const got = await c.ops.unwrapRaw({ document: w.raw, counterpartyKey: recipient as unknown as IdentityPublicKey, repoId: session.repoId, epoch })
    return { ...got, recipientKeyId: w.row.recipientKeyId }
  } catch (e) {
    if (e instanceof WrapError) return null
    throw e
  }
}

/** A wrap that stands with another key cannot be replaced: say so (the caller decides what now). */
function requireSame(outcome: WrapOutcome, identity: string, epoch: number): void {
  if (outcome.kind !== 'same') throw unusableWrap(outcome, identity, epoch)
}

function unusableWrap(outcome: WrapOutcome, identity: string, epoch: number): PrivateMembersError {
  switch (outcome.kind) {
    case 'not-a-member':
      return new PrivateMembersError(`${short(identity)} is not a maintainer or writer of this repo any more; the key was not wrapped to them`, 'E310')
    case 'unreadable':
      return new PrivateMembersError(`your key wrap of epoch ${epoch} for ${short(identity)} stands and cannot be read back from this browser`, 'E310')
    default:
      return new PrivateMembersError(`key epoch ${epoch} already holds another key of yours for ${short(identity)}; run the rotation again`, 'E310')
  }
}

/**
 * This signer's `repoKey`s at `epoch`, read fresh from chain, that went to anyone outside
 * `allowed` (base58 member ids): a key known to someone it must not be.
 */
async function straysAt(c: PrivateWriteContext, epoch: number, allowed: readonly string[]): Promise<string[]> {
  // The repo's wraps through its one listing index (`memberEpoch`), then this signer's at `epoch`.
  const docs = await sdkSessionSource(c.sdk, c.repo).repoKeys().catch(() => null)
  if (docs === null) throw new PrivateMembersError(`your wraps of epoch ${epoch} could not be read back; try again`, 'E310')
  return docs
    .map(parseWrapDoc)
    .filter((w): w is NonNullable<typeof w> => w !== null && w.row.epoch === epoch && base58Encode(w.row.owner) === c.auth.identityId)
    .map((w) => base58Encode(w.row.memberId))
    .filter((m) => !allowed.includes(m))
}

/** Step 4's reading of the anchor of `epoch` for the key with commitment `commit`. */
export type AnchorVerdict = 'ours' | 'lost' | 'mismatch' | 'pending' | { readonly preempted: number; readonly by: string }

/**
 * `ours` only when the anchor is by `self`, commits to our key, and this reader holds the epoch;
 * `lost` when another current maintainer's anchor is first; `mismatch` for our anchor with
 * another key (a replayed or stale write); `pending` while none is visible; `preempted` when a
 * later epoch's anchor was posted before ours (a config waiting above the current epoch, which
 * our anchor made contiguous): its key, not ours, is the repo's now.
 */
export function anchorVerdict(session: PrivateSession, epoch: number, commit: Uint8Array, self: string): AnchorVerdict {
  const r = session.resolution
  const anchor = r.anchors.get(epoch)
  if (anchor === undefined) return 'pending'
  if (base58Encode(anchor.owner) !== self) return 'lost'
  if (anchor.commit === null || !bytesEqual(anchor.commit, commit)) return 'mismatch'
  // A rotation past ours after it is fine; a later anchor from before ours is not.
  for (const [e, a] of r.anchors) if (e > epoch && a.height < anchor.height) return { preempted: e, by: base58Encode(a.owner) }
  // Our anchor, with our key: we must be able to read it (our self-wrap holds this key).
  return r.keys.has(epoch) ? 'ours' : 'mismatch'
}

const POLL_ATTEMPTS = 10
const POLL_MS = 2000

/**
 * Rotate the repo key (§5.5 steps 1–4), excluding `exclude` explicitly. Returns the new epoch.
 * Throws {@link PrivateMembersError} when another maintainer's anchor won.
 */
export async function rotateRepoKey(
  c: PrivateWriteContext,
  exclude: readonly string[],
  intent: string,
  onStep?: (s: RotationStep) => void,
  /** Memberships just deleted, dropped from every read of this rotation (see `loadPrivateSession`). */
  drop: readonly { readonly identity: string; readonly role?: Role }[] = exclude.map((identity) => ({ identity })),
  /** The epoch the removal this rotation follows keeps as current (see `rotateWith`). */
  minFrom?: number,
  /** This rotation is the repair after a lost one: do not chain another repair. */
  afterLoss = false,
): Promise<number> {
  const done = await withFreshSession(c, (session) => rotateWith(c, session, exclude, intent, onStep, minFrom, drop), drop)
  // Step 4: confirm the anchor of the new epoch is ours, with our key, among current maintainers.
  const epoch = 'lost' in done ? done.lost : done.epoch
  if ('commit' in done && (await confirmAnchor(c, epoch, done.commit, drop, onStep)) === 'ours') {
    onStep?.({ kind: 'anchored', epoch })
    return epoch
  }
  // Their key is the repo's key now. If they rotated from a member list that still had the
  // removed member, that member holds it: the repair check (with this removal's drop) finds and
  // rotates that. A second loss in a row is reported rather than chased.
  onStep?.({ kind: 'lost', epoch })
  let repair = 'the repair check ran after it'
  if (!afterLoss) {
    try {
      await runRepair(c, `${intent}:after-lost`, onStep, drop, true)
    } catch (e) {
      repair = `the repair check after it failed (${e instanceof Error ? e.message : String(e)}); open Repair on the repo page`
    }
  }
  throw new PrivateMembersError(`another maintainer rotated to epoch ${epoch} first; their key is the repo's key, and ${repair}.`, 'E310', 'lost')
}

/**
 * Poll until the anchor of `epoch` shows: `ours` (by this identity, with the key of `commit`) or
 * `lost` (another current maintainer's came first). Throws on our anchor with another key, or
 * when none shows in time.
 */
async function confirmAnchor(
  c: PrivateWriteContext,
  epoch: number,
  commit: Uint8Array,
  drop: readonly { readonly identity: string; readonly role?: Role }[],
  onStep?: (s: RotationStep) => void,
): Promise<'ours' | 'lost'> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    onStep?.({ kind: 'waiting', what: `the anchor of epoch ${epoch}` })
    const verdict = await withFreshSession(c, async (s) => anchorVerdict(s, epoch, commit, c.auth.identityId), drop)
    if (verdict === 'ours' || verdict === 'lost') return verdict
    if (typeof verdict === 'object') {
      throw new PrivateMembersError(
        `key epoch ${epoch} is anchored, but a config for epoch ${verdict.preempted} by ${short(verdict.by)} was posted before it and now follows it, so its key is the repo's current key; the owner can remove that maintainer to drop it.`,
        'E310',
        'preempted',
      )
    }
    if (verdict === 'mismatch') {
      throw new PrivateMembersError(`the anchor of epoch ${epoch} does not carry the key you wrapped; run the rotation again`, 'E310', 'mismatch')
    }
    await sleep(POLL_MS)
  }
  throw new PrivateMembersError(`the anchor of epoch ${epoch} is not visible yet; reload and repair to finish`, 'E310')
}

/**
 * §5.5 steps 1–3 over `session`: wraps (self first), then the anchor. Returns the new epoch and
 * its key's commitment, or `lost` when a burn's anchor lost the race (nothing built on it).
 */
async function rotateWith(
  c: PrivateWriteContext,
  session: PrivateSession,
  exclude: readonly string[],
  intent: string,
  onStep?: (s: RotationStep) => void,
  /** The epoch the removal this rotation follows keeps as current: never chain from below it. */
  minFrom?: number,
  drop: readonly { readonly identity: string; readonly role?: Role }[] = [],
): Promise<{ epoch: number; commit: Uint8Array } | { lost: number }> {
  const plan = planRotation(session, c.auth.identityId, exclude, c.repo.forge.core, c.ops.keyIds)
  // The read must be at least as new as the removal it follows: a current epoch below the one
  // before the removal means its re-anchor is not visible here yet, and chaining from it would
  // skip that epoch.
  if (minFrom !== undefined && plan.from < minFrom) {
    throw new PrivateMembersError('the repo\'s key epochs are still catching up after the removal; try again in a moment', 'E310')
  }
  await assertMembersSettled(c, session, drop)
  const self = plan.recipients[0]
  if (self === undefined || self.identity !== c.auth.identityId) throw new PrivateMembersError('your identity has no usable encryption key', 'E306')
  const selfId = decodeIdentifier(self.identity)
  const removing = exclude.length > 0
  const allowed = [...plan.recipients.map((r) => r.identity), ...plan.unreachable]
  // `from`: the epoch this step chains from and its key (the caller's copy is wiped here).
  // `skip`: when `from` is burned, the nearest non-burned epoch below it and its key.
  let from = { epoch: plan.from, raw: (await rawEpochKey(session, c, plan.from)).raw }
  let skip: { epoch: number; raw: Uint8Array } | null = null
  let burned: number | null = null
  try {
    if (session.resolution.burned.has(plan.from)) skip = await skipBelow(session, c, plan.from)
    for (;;) {
      const epoch = from.epoch + 1
      if (burned !== null) {
        const closed = burned
        await assertMembersSettled(c, session, drop).catch(() => {
          throw new PrivateMembersError(`key epoch ${closed} was closed, but the member list is still changing on Platform; run Repair in a moment to finish.`, 'E310')
        })
      }
      let next = await ownEpochKey(c, session, self, epoch, intent)
      try {
        onStep?.({ kind: 'wrapped', identity: self.identity, epoch })
        // An earlier run's key may already sit with someone who must not have it: a removal never
        // trusts a read that may lag that run's wrap; any run burns on a stray it can see, or on
        // a standing wrap it cannot replace.
        const mine = ownWraps(session, selfId, epoch)
        let leak =
          (removing && next.resumed) ||
          mustBurn(false, false, mine, plan.recipients, allowed) ||
          (await straysAt(c, epoch, allowed)).length > 0
        // Every recipient this run already wrapped or found standing at `epoch`: never posted twice.
        const tried = new Set(mine.map((w) => base58Encode(w.row.memberId)))
        if (!leak) {
          for (const r of plan.recipients.slice(1)) {
            const outcome = tried.has(r.identity)
              ? await standingOutcome(c, session, next.keys, r.identity, r.keyId)
              : await postWrap(c, session, next.keys, next.raw, r.identity, r.keyId, intent)
            tried.add(r.identity)
            // Removed since the plan was read: re-planned out (they get no key; nothing leaked).
            if (outcome.kind === 'not-a-member') continue
            if (outcome.kind !== 'same') {
              leak = true
              break
            }
            onStep?.({ kind: 'wrapped', identity: r.identity, epoch })
          }
        }
        if (leak) {
          if (burned !== null) {
            throw new PrivateMembersError(`key epoch ${epoch} needs burning too; it was left unanchored. Run Repair again.`, 'E310')
          }
          // §5.3 burn: first hand that key to every remaining member (so any maintainer can finish
          // the burn with Repair, chaining from it), then anchor `epoch` chain-only with it; the
          // next epoch chains from it once this anchor is the epoch's (else another maintainer's
          // stands: build nothing on ours). A wrap that stands and cannot be replaced is skipped.
          for (const r of plan.recipients.slice(1)) {
            if (tried.has(r.identity)) continue
            if ((await postWrap(c, session, next.keys, next.raw, r.identity, r.keyId, intent)).kind === 'same') {
              onStep?.({ kind: 'wrapped', identity: r.identity, epoch })
            }
          }
          await postAnchor(c, session, next.keys, epoch, from.epoch, null, intent, true)
          if ((await confirmAnchor(c, epoch, next.keys.commit, drop, onStep)) === 'lost') return { lost: epoch }
          onStep?.({ kind: 'burned', epoch })
          burned = epoch
          // The next epoch skips this burned one to the nearest non-burned epoch below it.
          if (skip === null) skip = from
          else from.raw.fill(0)
          from = { epoch, raw: next.raw }
          next = { keys: next.keys, raw: new Uint8Array(0), resumed: false }
          continue
        }
        if ((await straysAt(c, epoch, allowed)).length > 0) {
          throw new PrivateMembersError(`key epoch ${epoch} reached someone it must not; run the rotation again`, 'E310')
        }
        await postAnchor(c, session, next.keys, epoch, from.epoch, from.raw, intent, false, skip?.raw ?? null)
        return { epoch, commit: next.keys.commit }
      } finally {
        next.raw.fill(0)
      }
    }
  } finally {
    from.raw.fill(0)
    skip?.raw.fill(0)
  }
}

/**
 * The nearest non-burned epoch below the burned epoch `burned` and its raw key (§5.3 skip link),
 * from this reader's own accepted wraps. Every epoch between it and `burned` must be readable
 * and burned; otherwise the chain cannot be continued from here: refused.
 */
async function skipBelow(session: PrivateSession, c: PrivateWriteContext, burned: number): Promise<{ epoch: number; raw: Uint8Array }> {
  const r = session.resolution
  for (let s = burned - 1; s >= 0; s--) {
    if (!r.keys.has(s)) break
    if (r.burned.has(s)) continue
    if (acceptedOwnWraps(session, c.auth.identityId, s).length === 0) break
    return { epoch: s, raw: (await rawEpochKey(session, c, s)).raw }
  }
  throw new PrivateMembersError(
    `key epoch ${burned} is burned and you hold no key of the epoch below it that the next epoch must skip to; a maintainer who holds it must rotate`,
    'E310',
  )
}

/**
 * The last step of a private create (§5.3 epoch 0; parity: forge-core
 * `keyring::create_private_state`): the owner's self-wrap of a fresh epoch-0 key, then the
 * epoch-0 anchor `config` (`defaultBranch`, `protectedPatterns`, backend in plaintext). For a
 * public repo (members-only content, {@link enableMembersContent}) the anchor carries `vis:
 * "public"` and none of the settings ({@link anchorContent}; `defaultBranch` is ignored). A
 * resumed create reuses its own standing epoch-0 self-wrap; one whose anchor already exists
 * does nothing. Returns whether it wrote the anchor.
 */
export async function createEpochZero(c: PrivateWriteContext, defaultBranch: string, intent: string, protectedPatterns: readonly string[] = []): Promise<boolean> {
  return withFreshSession(c, async (read) => {
    if (read.resolution.anchors.has(0)) return false
    // The maintainer document was just written: a member-list read may not show it yet, so the
    // owner's own keys are read directly.
    const own = await fetchIdentityKeys(c.sdk, c.auth.identityId)
    const session: PrivateSession = { ...read, memberKeys: new Map([...read.memberKeys, [c.auth.identityId, own]]) }
    const selfKey = usableEncryptionKey(own ?? [], c.repo.forge.core)
    if (selfKey === null) throw new PrivateMembersError('your identity has no usable encryption key', 'E306')
    // Resume: our own epoch-0 self-wrap, if it landed, is the key (to whatever key of ours it
    // went, as long as this browser holds it); else a fresh one, wrapped to the identity's newest
    // encryption key (§5.2), which must be the one this browser holds, or the repo would be
    // created unreadable to its own owner.
    const pending = pendingSelfWrap(session, c.auth.identityId, 0)
    if (pending !== null && !c.ops.keyIds.includes(pending.row.recipientKeyId)) throw notHeldKey(0, pending.row.recipientKeyId)
    if (pending === null && !c.ops.keyIds.includes(selfKey.keyId)) {
      throw new PrivateMembersError(`your identity's current encryption key is key ${selfKey.keyId}, but this browser holds ${heldKeysText(c.ops.keyIds)}; add key ${selfKey.keyId} here (Settings → Private repos)`, 'E306')
    }
    const k0 = await ownEpochKey(c, session, { identity: c.auth.identityId, keyId: pending?.row.recipientKeyId ?? selfKey.keyId }, 0, intent)
    try {
      const anchor = anchorContent(
        c.repo.visibility,
        { defaultBranch: shortBranch(defaultBranch), protectedPatterns: [...protectedPatterns], backend: { mode: 0 }, archived: false },
        null,
      )
      const enc = await sealDoc(k0.keys, { type: 'config', ownerId: decodeIdentifier(c.auth.identityId), epoch: 0 }, anchor.fields, { anchor: true })
      await postConfig(c, { repoId: decodeIdentifier(c.repo.repoId), epoch: 0, enc, ...anchor.plaintext }, `${intent}:anchor:0:${keyTag(k0.keys)}`)
      return true
    } finally {
      k0.raw.fill(0)
    }
  })
}

/**
 * Turn members-only content on in a public repo (DESIGN D1, §4.1; parity: forge-core
 * `keyring::enable_members_key`): epoch 0 of its members key, the signer's self-wrap then the
 * settings-free anchor (`vis: "public"`, an empty TLV, no `backend` / `archived`:
 * {@link anchorContent}), then the key shared with every current member who holds it (the repair
 * check, §5.6). A maintainer only; resumable. Epoch 0 is minted only when the repo has no sealed
 * config at all: one that does not resolve is never papered over by a second epoch 0. Returns
 * whether this run wrote the anchor. No UI calls it yet (stream 1D's "Turn on members-only
 * content" sheet will).
 */
export async function enableMembersContent(c: PrivateWriteContext, intent: string): Promise<boolean> {
  if (c.repo.visibility !== 'public') throw new PrivateMembersError('a private repo is members-only already')
  const step = await withFreshSession(c, async (s) => {
    if (!isMaintainer(s, c.auth.identityId)) throw new PrivateMembersError('only a maintainer can turn on members-only content')
    if (s.resolution.anchors.size > 0) return 'repair' as const
    if (s.configRows.length > 0) {
      throw new PrivateMembersError("this repo's members-only key exists but can't be read; a maintainer who holds it can repair it", 'E310')
    }
    return 'mint' as const
  })
  const anchored = step === 'mint' ? await createEpochZero(c, 'main', `${intent}:enable`) : false
  noteMembersKey(c.repo)
  await runRepair(c, `${intent}:share`)
  return anchored
}

/**
 * The key of `epoch` for this signer (`self`: its identity and the key id its self-wrap goes to):
 * its pending self-wrap's (an earlier run's; the unique index keeps it), else a fresh one, posted
 * as its self-wrap; a self-wrap that stands unseen by this read is adopted, if it is to the key
 * this browser holds. `resumed`: the key is an earlier run's. The caller wipes `raw`.
 */
async function ownEpochKey(
  c: PrivateWriteContext,
  session: PrivateSession,
  self: { readonly identity: string; readonly keyId: number },
  epoch: number,
  intent: string,
): Promise<{ keys: EpochKeys; raw: Uint8Array; resumed: boolean }> {
  const pending = pendingSelfWrap(session, self.identity, epoch)
  if (pending !== null) {
    const k = await c.ops.unwrapRaw({ document: pending.raw, counterpartyKey: keyOf(session, self.identity, pending.senderKeyId), repoId: session.repoId, epoch })
    return { ...k, resumed: true }
  }
  const fresh = await freshKey(session.repoId, epoch)
  try {
    const outcome = await postWrap(c, session, fresh.keys, fresh.raw, self.identity, self.keyId, intent)
    if (outcome.kind === 'same') return { ...fresh, resumed: false }
    if (outcome.kind === 'unreadable') throw unusableWrap(outcome, self.identity, epoch)
    // Removed as a maintainer meanwhile: this signer cannot rotate any more.
    if (outcome.kind === 'not-a-member') throw new PrivateMembersError('you are not a maintainer of this repo any more; ask the owner to add you again, or rotate from another maintainer', 'E310')
    const standing = await readOwnWrap(c, session, epoch, self.identity)
    if (standing === null) throw unusableWrap({ kind: 'unreadable' }, self.identity, epoch)
    if (!c.ops.keyIds.includes(standing.recipientKeyId)) {
      standing.raw.fill(0)
      throw notHeldKey(epoch, standing.recipientKeyId)
    }
    fresh.raw.fill(0)
    return { keys: standing.keys, raw: standing.raw, resumed: true }
  } catch (e) {
    fresh.raw.fill(0)
    throw e
  }
}

async function freshKey(repoId: Uint8Array, epoch: number): Promise<{ keys: EpochKeys; raw: Uint8Array }> {
  const raw = generateEpochKey()
  return { keys: await EpochKeys.import(repoId, epoch, raw), raw }
}

/**
 * Post the anchor `config` of `epoch` under `keys`: the current config fields, the chain pair
 * (`prevEpoch`, `prevEpochKey` = K_prev), and `burned` for a chain-only epoch (§5.3).
 */
async function postAnchor(
  c: PrivateWriteContext,
  session: PrivateSession,
  keys: EpochKeys,
  epoch: number,
  prevEpoch: number,
  /** K_prev; null for a burned anchor (§5.3: its key may sit with someone who never held the key below). */
  prevEpochKey: Uint8Array | null,
  intent: string,
  burned: boolean,
  /** The key of the nearest non-burned epoch below a burned `prevEpoch` (§5.3 `skipEpochKey`). */
  skipEpochKey: Uint8Array | null = null,
): Promise<void> {
  const anchor = anchorOf(c, session, {
    prevEpoch,
    ...(prevEpochKey !== null ? { prevEpochKey: new Uint8Array(prevEpochKey) } : {}),
    ...(skipEpochKey !== null ? { skipEpochKey: new Uint8Array(skipEpochKey) } : {}),
    ...(burned ? { burned: true } : {}),
  })
  const fields = anchor.fields
  try {
    const enc = await sealDoc(keys, { type: 'config', ownerId: decodeIdentifier(c.auth.identityId), epoch }, fields, { anchor: true })
    await postConfig(
      c,
      { repoId: decodeIdentifier(c.repo.repoId), epoch, enc, ...anchor.plaintext },
      `${intent}:anchor:${epoch}:${keyTag(keys)}${burned ? ':burned' : ''}`,
    )
  } finally {
    fields.prevEpochKey?.fill(0)
    fields.skipEpochKey?.fill(0)
  }
}

/**
 * Add a member (§5.5): check their usable ENCRYPTION key and their `consent` (RC1: they accepted
 * the invitation), write the membership document, then a wrap of the current epoch to them. Two
 * transitions.
 */
export async function addPrivateMember(c: PrivateWriteContext, memberId: string, role: Role, intent: string): Promise<AddOutcome> {
  if ((await retryWhileMissing(() => findConsent(c.sdk, c.repo, memberId), CONSENT_LAG_RETRIES)) === null) throw new ConsentMissingError(memberId)
  const keys = await fetchIdentityKeys(c.sdk, memberId)
  const canReceive = usableEncryptionKey(keys ?? [], c.repo.forge.core) !== null
  // A private repo's member with no encryption key could be granted a role but never read it:
  // refused. In a public one they can still do everything public; the members key is shared once
  // they add one (the repair check wraps them), as `dg collab add` does.
  if (!canReceive && c.repo.visibility === 'private') throw new PrivateMembersError(`${short(memberId)} has no encryption key yet`, 'E306')
  const receives = canReceive && holdsMembersKey(role, c.repo.visibility)
  // Nothing is written unless the wrap can follow, and a new maintainer's old configs must not
  // take over any epoch (§5.3: under contiguity an earlier config of theirs would come first).
  await withFreshSession(c, async (s) => {
    requireWriteEpoch(s)
    if (role !== 'maintainer' || isMaintainer(s, memberId)) return
    // Their configs count again: one for an epoch that exists must change nothing, and one above
    // the current epoch would become the anchor once the epochs below it exist.
    const id = decodeIdentifier(memberId)
    const current = s.resolution.currentEpoch ?? -1
    const above = s.configRows.filter((cfg) => bytesEqual(cfg.owner, id) && cfg.epoch > current).map((cfg) => cfg.epoch)
    const changed = [...new Set([...(await anchorChanges(s, new IdSet([...maintainersOf(s), id]))), ...above])].sort((a, b) => a - b)
    if (changed.length > 0) {
      throw new PrivateMembersError(
        `${short(memberId)} can't be made a maintainer of this repo again, because an earlier key of theirs would take over. Add them as a writer, or make another identity of theirs the maintainer.`,
        'E310',
        undefined,
        changed,
      )
    }
  })
  await grantMembershipDoc(c.sdk, c.auth, c.repo, memberId, role, `${intent}:member`)
  if (!receives) return { shared: false }
  await waitForMembers(c, (rows) => holds(rows, memberId, role))
  await withFreshSession(c, (session) => wrapForMember(c, session, memberId, intent))
  return { shared: true }
}

/** What an add did with the key: `shared` false, a public repo's member with no encryption key yet (the repair check wraps them later). */
export interface AddOutcome {
  readonly shared: boolean
}

/** The epoch a key can be handed out under; refuses a burned or unreadable current epoch. */
function requireWriteEpoch(session: PrivateSession): number {
  const r = session.resolution
  if (r.writeEpoch !== null) return r.writeEpoch
  if (currentBurned(r)) {
    throw new PrivateMembersError(`key epoch ${r.currentEpoch} is closed; run Repair on the repo page to rotate the key first`, 'E310')
  }
  throw new PrivateMembersError("you can't read the current key, so you can't hand it out", 'E310')
}

function maintainersOf(session: PrivateSession): Uint8Array[] {
  return session.members.filter((m) => m.role === 'maintainer').map((m) => decodeIdentifier(m.identity))
}

async function wrapForMember(c: PrivateWriteContext, session: PrivateSession, memberId: string, intent: string): Promise<void> {
  const n = requireWriteEpoch(session)
  const key = usableEncryptionKey(session.memberKeys.get(memberId) ?? [], c.repo.forge.core)
  if (key === null) throw new PrivateMembersError(`${short(memberId)} has no encryption key yet`, 'E306')
  await assertMembersSettled(c, session)
  const kn = await rawEpochKey(session, c, n)
  try {
    requireSame(await postWrap(c, session, kn.keys, kn.raw, memberId, key.keyId, intent), memberId, n)
  } finally {
    kn.raw.fill(0)
  }
}

/** Whether `id` has a usable ENCRYPTION key (the Add button's check). */
export async function hasUsableEncryptionKey(sdk: EvoSDK, coreId: string, id: string): Promise<boolean> {
  const keys = await fetchIdentityKeys(sdk, id)
  return keys !== null && usableEncryptionKey(keys, coreId) !== null
}

/** Poll the membership (uncached) until `ok` holds for it; returns that membership. */
export async function waitForMembers(c: PrivateWriteContext, ok: (rows: readonly Membership[]) => boolean): Promise<readonly Membership[]> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    invalidateMembers(c.repo, c.network)
    const rows = await readMemberships(c.sdk, c.repo)
    if (ok(rows)) return rows
    await sleep(POLL_MS)
  }
  throw new PrivateMembersError('the membership change is not visible yet; reload to check it, then repair')
}

export const holds = (rows: readonly Membership[], identity: string, role?: Role): boolean =>
  rows.some((m) => m.identity === identity && (role === undefined || m.role === role))

/**
 * What removing `role` from `memberId` does to the key (§5.4, §5.5), given the current members:
 * - `rotate-exclude`: they leave the repo; rotate without them;
 * - `rotate-keep`: a maintainer stays on as a writer; their wraps no longer count (§5.4 check 2),
 *   so rotate, and they get the new key like every remaining member;
 * - `none`: a writer role goes while they stay maintainer; nothing about the key changes.
 */
export type RemovalEffect = 'rotate-exclude' | 'rotate-keep' | 'none'

export function removalEffect(members: readonly Membership[], memberId: string, role: Role): RemovalEffect {
  const keeps = members.some((m) => m.identity === memberId && m.role !== role)
  if (!keeps) return 'rotate-exclude'
  return role === 'maintainer' ? 'rotate-keep' : 'none'
}

/** A rotation error after the membership was deleted: the Remove button is gone by then. */
function afterRevoke(e: unknown): Error {
  const reason = e instanceof Error ? e.message : String(e)
  return new PrivateMembersError(`the member was removed, but the key was not rotated yet (${reason}). Open Repair on the repo page to finish.`, 'E310')
}

/**
 * Remove a member's role (owner only) and rotate as {@link removalEffect} says (§5.5): delete the
 * membership, wait until the list no longer shows it, then {@link rotateRepoKey}, excluding them
 * explicitly when they left. Returns the new epoch, or null when no rotation was needed.
 */
export async function removePrivateMember(
  c: PrivateWriteContext,
  memberId: string,
  role: Role,
  intent: string,
  onStep?: (s: RotationStep) => void,
): Promise<number | null> {
  // §5.3: a maintainer's anchors stop counting when their role goes. Re-anchor each of their
  // epochs that stays ({@link epochsToReanchor}) first, so no kept epoch falls back.
  // The rotation after the delete chains from the epoch that stays current: refuse now, before
  // anything is deleted, when this browser cannot read it (a maintainer who holds it must remove).
  await withFreshSession(c, async (s) => {
    if (role === 'maintainer' && memberId === c.auth.identityId) {
      const mine = epochsAnchoredBy(s, memberId)
      if (mine.length > 0) {
        throw new PrivateMembersError(
          `you can't remove your own maintainer role while you anchor key ${mine.length === 1 ? 'epoch' : 'epochs'} ${mine.join(', ')}: your anchors stop counting with the role and nobody can re-anchor them first. Keep the role; nothing was removed.`,
          'E310',
        )
      }
    }
    const effect = removalEffect(s.members, memberId, role)
    if (effect === 'none') return
    const kept = chainFrom(s, memberId, role)
    if (kept !== null && !s.resolution.keys.has(kept)) {
      const holders = role === 'maintainer' ? vanishing(s, memberId).holders.filter((h) => h !== c.auth.identityId) : []
      throw new PrivateMembersError(
        holders.length > 0
          ? `you can't read key epoch ${kept}, which ${holders.map(short).join(', ')} also hold${holders.length === 1 ? 's' : ''}; a maintainer who holds it can do the removal, or may be able to hand you the key with Repair. Nothing was removed.`
          : `key epoch ${kept} stays current after this removal and you can't read it, so the key can't be rotated from this browser; a maintainer who holds it must do the removal. Nothing was removed.`,
        'E310',
      )
    }
    // The rotation after the delete is planned now (its own checks: the rotator's key among them),
    // so a removal it would refuse is refused before the membership goes.
    if (kept !== null && s.resolution.keys.has(kept)) {
      planRotation(s, c.auth.identityId, effect === 'rotate-exclude' ? [memberId] : [], c.repo.forge.core, c.ops.keyIds, kept)
    }
    // Another staying maintainer's config that would come before this browser's re-anchor, and
    // is not the same anchor, is known now: refuse before paying for anything.
    if (role === 'maintainer') {
      const changed = await anchorsAfterReanchor(s, memberId, c.auth.identityId)
      if (changed.length > 0) {
        const by = takenOverBy(s, memberId, changed)
        throw new PrivateMembersError(
          `Removing this maintainer would let ${by.length > 0 ? by.map(short).join(', ') : 'another maintainer'}'s older key take over, so nothing was removed. Remove that maintainer first, or rotate the repo key.`,
          'E310',
          undefined,
          changed,
        )
      }
    }
  })
  let before: number | undefined
  if (role === 'maintainer') {
    before = await withFreshSession(c, async (s) => {
      await reanchorEpochsOf(c, s, memberId, intent, onStep)
      return keptEpoch(s, memberId) ?? undefined
    })
    // The re-anchors must now be what each epoch falls back to once the role goes, and nothing
    // that vanishes may be held by anyone who stays (a few fresh reads: the re-anchors may not
    // be visible on the first node). The rotation never chains from below any kept epoch seen.
    for (let i = 0; ; i++) {
      const [changed, kept] = await withFreshSession(c, async (s) => [await anchorsWithout(s, memberId), keptEpoch(s, memberId)] as const)
      if (kept !== null) before = Math.max(before ?? kept, kept)
      if (changed.length === 0) break
      if (i + 1 >= SURVIVE_POLLS) throw anchorsWouldChange(changed, await withFreshSession(c, async (s) => takenOverBy(s, memberId, changed)))
      await sleep(POLL_MS)
    }
  }
  await revokeMembershipDoc(c.sdk, c.auth, c.repo, memberId, role)
  onStep?.({ kind: 'deleted' })
  onStep?.({ kind: 'waiting', what: 'the member list to drop them' })
  const rows = await waitForMembers(c, (r) => !holds(r, memberId, role))
  const effect = removalEffect([...rows, { identity: memberId, role, createdAt: 0 }], memberId, role)
  if (effect === 'none') return null
  // A lagging node may still list the deleted role: every read from here on drops it.
  const drop = [{ identity: memberId, ...(effect === 'rotate-exclude' ? {} : { role }) }]
  let epoch: number | null = null
  try {
    epoch = await rotateRepoKey(c, effect === 'rotate-exclude' ? [memberId] : [], intent, onStep, drop, before)
  } catch (e) {
    // The membership is gone; the key must still move. The repair check rotates when the removed
    // member still holds the current key (a lost rotation already ran it). If that fails too, the
    // page's Repair finishes it. An outcome the owner must see (lost, pre-empted, mismatch) is
    // reported after the repair, never swallowed.
    const outcome = e instanceof PrivateMembersError ? e.outcome : undefined
    if (outcome !== 'lost') {
      onStep?.({ kind: 'waiting', what: 'the repair check after a failed rotation' })
      try {
        await runRepair(c, `${intent}:repair`, onStep, drop)
      } catch {
        throw afterRevoke(e)
      }
    }
    if (outcome !== undefined) throw e
    return null
  }
  // Once more, the repair check (§5.6): a concurrent rotation that lost, or one by a maintainer
  // who did not exclude this member, shows up here and is fixed now.
  await runRepair(c, `${intent}:repair`, onStep, drop)
  return epoch
}

/**
 * The cost shown before removing `role` from `memberId`: re-anchoring their epochs (a maintainer),
 * then the rotation when there is one (the delete itself refunds, and is not counted).
 */
export function removalCost(session: PrivateSession, self: string, memberId: string, role: Role, plan: RotationPlan | null): CostPreview {
  const reanchors = role === 'maintainer' ? epochsToReanchor(session, memberId).map(() => previewCreate('config')) : []
  const keep = role === 'maintainer' ? keepWrapEpochs(session, self, memberId).map(() => previewCreate('repoKey')) : []
  return sumPreviews([...keep, ...reanchors, ...(plan !== null ? [rotationCost(plan)] : [])])
}

/** {@link anchorChanges} with `leaving` no longer a maintainer; the {@link vanishing} epochs must vanish. */
export async function anchorsWithout(session: PrivateSession, leaving: string): Promise<number[]> {
  const remaining = maintainersOf(session).filter((m) => !bytesEqual(m, decodeIdentifier(leaving)))
  return anchorChanges(session, new IdSet(remaining), new Set(vanishing(session, leaving).epochs))
}

/**
 * {@link anchorsWithout} as it will be once this browser's re-anchors land (after every config
 * that stands now): the epochs whose anchor another staying maintainer's config would change.
 * Known from the first read, so a removal refuses before it writes anything.
 */
async function anchorsAfterReanchor(session: PrivateSession, leaving: string, self: string): Promise<number[]> {
  const selfId = decodeIdentifier(self)
  const last = Math.max(0, ...session.configRows.map((cfg) => cfg.createdAtBlockHeight)) + 1
  const ours = epochsToReanchor(session, leaving).map((e, i) => {
    const a = session.resolution.anchors.get(e) as Anchor
    return { ...a.config, owner: selfId, id: new Uint8Array(32).fill(0xff), createdAtBlockHeight: last + i }
  })
  const staying = maintainersOf(session).filter((m) => !bytesEqual(m, decodeIdentifier(leaving)))
  if (!staying.some((m) => bytesEqual(m, selfId))) staying.push(selfId)
  const planned = new Set(ours.map((x) => x.epoch))
  return anchorChanges({ ...session, configRows: [...session.configRows, ...ours] }, new IdSet(staying), new Set(vanishing(session, leaving).epochs), planned)
}

/**
 * The epochs whose anchor changes in substance when the maintainers are `maintainers` (sorted):
 * an epoch that exists now needs an anchor with the same key (commitment), the same `burned` flag
 * and the same chain pair (a config this reader cannot open only counts when it is the same
 * document); no new epoch may appear. `vanish`: epochs that must stop existing instead.
 */
async function anchorChanges(
  session: PrivateSession,
  maintainers: IdSet,
  vanish: ReadonlySet<number> = new Set(),
  /** Epochs a planned re-anchor (id 0xff…) stands in for: it counts as the same anchor. */
  planned: ReadonlySet<number> = new Set(),
): Promise<number[]> {
  const r = session.resolution
  const after = selectAnchors(session.configRows, maintainers)
  const changed = [...after.keys()].filter((e) => !r.anchors.has(e))
  const isPlanned = (e: number, id: Uint8Array): boolean => planned.has(e) && id.every((b) => b === 0xff)
  for (const [e, a] of r.anchors) {
    const next = after.get(e)
    if (vanish.has(e)) {
      if (next !== undefined) changed.push(e)
    } else if (next === undefined || (!bytesEqual(next.id, a.id) && !isPlanned(e, next.id) && !(await sameAnchor(session, e, next.config)))) {
      changed.push(e)
    }
  }
  return changed.sort((x, y) => x - y)
}

/**
 * Whether `config` could stand in for the anchor of `epoch`: it opens with the epoch's key (so it
 * carries the same commitment) and repeats the anchor's whole chain link: the same `burned` flag,
 * `prevEpoch`, and keys (`prevEpochKey`, `skipEpochKey`) committing to the same keys (§5.3).
 * False when this reader cannot read the epoch.
 */
async function sameAnchor(session: PrivateSession, epoch: number, config: Anchor['config']): Promise<boolean> {
  const r = session.resolution
  const keys = r.keys.get(epoch)
  const anchor = r.anchors.get(epoch)
  if (keys === undefined || anchor === undefined) return false
  const open = async (x: Anchor['config']) => {
    const o = await openWithKey({ type: 'config', ownerId: x.owner, epoch, id: x.id, createdAtBlockHeight: x.createdAtBlockHeight, enc: x.enc }, keys, true)
    return o.status === 'readable' ? o.fields : null
  }
  const [mine, theirs] = [await open(config), await open(anchor.config)]
  const wipe = (f: typeof mine) => {
    f?.prevEpochKey?.fill(0)
    f?.skipEpochKey?.fill(0)
  }
  try {
    if (mine === null || theirs === null) return false
    const same = (x?: Uint8Array, y?: Uint8Array) => (x === undefined) === (y === undefined) && (x === undefined || bytesEqual(x, y as Uint8Array))
    return (
      (mine.burned === true) === (theirs.burned === true) &&
      mine.prevEpoch === theirs.prevEpoch &&
      same(mine.prevEpochKey, theirs.prevEpochKey) &&
      same(mine.skipEpochKey, theirs.skipEpochKey)
    )
  } finally {
    wipe(mine)
    wipe(theirs)
  }
}

/**
 * The epochs that stop existing when `leaving`'s maintainer role goes (§5.3 contiguity): every
 * epoch above the highest one this reader can read, when `leaving` anchored all of them and no
 * maintainer who stays holds any (no wrap there by another current maintainer: wrap rows are
 * public). The next rotation takes their numbers again. `holders`: the maintainers who stay and
 * hold one (then nothing vanishes; they can hand this reader the key). `losing`: members who stay
 * and were wrapped one only by `leaving` (they lose what was written under it).
 */
export function vanishing(session: PrivateSession, leaving: string): { epochs: number[]; holders: string[]; losing: string[] } {
  const none = { epochs: [], holders: [], losing: [] }
  const r = session.resolution
  if (r.currentEpoch === null) return none
  const top = Math.max(-1, ...r.keys.keys())
  if (top < 0 || top >= r.currentEpoch) return none
  const epochs = Array.from({ length: r.currentEpoch - top }, (_, i) => top + 1 + i)
  if (epochs.some((e) => session.anchors.get(e)?.owner !== leaving)) return none
  const staying = new Set(session.members.filter((m) => m.identity !== leaving).map((m) => m.identity))
  const maintainers = new Set(session.members.filter((m) => m.role === 'maintainer' && m.identity !== leaving).map((m) => m.identity))
  const holders = new Set<string>()
  const losing = new Set<string>()
  for (const w of session.wraps) {
    if (!epochs.includes(w.row.epoch)) continue
    const owner = base58Encode(w.row.owner)
    const member = base58Encode(w.row.memberId)
    if (staying.has(member)) losing.add(member)
    // A maintainer who stays and wrote or received a wrap there holds it. The leaving
    // maintainer's own wraps stop counting with the role (§5.4 (2); parity: `reanchor_plan`).
    if (owner === leaving) continue
    if (maintainers.has(owner)) holders.add(owner)
    if (maintainers.has(member)) holders.add(member)
  }
  if (holders.size > 0) return { ...none, holders: [...holders].sort() }
  return { epochs, holders: [], losing: [...losing].sort() }
}

/** The current epoch once `leaving`'s maintainer role goes: below the ones that vanish. */
export function keptEpoch(session: PrivateSession, leaving: string): number | null {
  const [first] = vanishing(session, leaving).epochs
  return first === undefined ? session.resolution.currentEpoch : first - 1
}

/** The epoch the rotation after removing `role` from `member` chains from. */
export function chainFrom(session: PrivateSession, member: string, role: Role): number | null {
  return role === 'maintainer' ? keptEpoch(session, member) : session.resolution.currentEpoch
}

/** The epochs `leaving` anchored that must be re-anchored before their role goes (not the vanishing ones). */
export function epochsToReanchor(session: PrivateSession, leaving: string): number[] {
  const gone = new Set(vanishing(session, leaving).epochs)
  return epochsAnchoredBy(session, leaving).filter((e) => !gone.has(e))
}

/** How many reads before a maintainer's removal is refused because an epoch would change key. */
const SURVIVE_POLLS = 4

/** The refusal when a maintainer's removal would change an epoch's key (nothing was removed). */
function anchorsWouldChange(changed: readonly number[], by: readonly string[]): PrivateMembersError {
  const who = by.length > 0 ? `${by.map(short).join(', ')}'s older key` : 'another maintainer\'s older key'
  return new PrivateMembersError(
    `Removing this maintainer would let ${who} take over, or the new key isn't visible yet, so nothing was removed. Try again in a moment.`,
    'E310',
    undefined,
    changed,
  )
}

/** Who anchors each of `epochs` once `leaving` is gone and is not this reader (base58, sorted). */
function takenOverBy(session: PrivateSession, leaving: string, epochs: readonly number[]): string[] {
  const staying = maintainersOf(session).filter((m) => !bytesEqual(m, decodeIdentifier(leaving)))
  const after = selectAnchors(session.configRows, new IdSet(staying))
  const by = new Set<string>()
  for (const e of epochs) {
    const a = after.get(e)
    if (a !== undefined) by.add(base58Encode(a.owner))
  }
  return [...by].sort()
}

/** The epochs whose anchor `memberId` wrote (the ones that go when their maintainer role does). */
export function epochsAnchoredBy(session: PrivateSession, memberId: string): number[] {
  return [...session.anchors.values()].filter((a) => a.owner === memberId).map((a) => a.epoch).sort((a, b) => a - b)
}

/**
 * The epochs `self` must wrap to itself before `leaving`'s maintainer role goes (parity:
 * forge-core `wrap_held_through`): every epoch up to the kept one ({@link keptEpoch}) whose only
 * accepted wraps to `self` come from `leaving` (they stop counting with the role, §5.4 (2), and
 * the chain may not reach it), and the kept epoch itself when so.
 */
export function keepWrapEpochs(session: PrivateSession, self: string, leaving: string): number[] {
  const top = keptEpoch(session, leaving)
  if (top === null) return []
  const leavingId = decodeIdentifier(leaving)
  const heldOtherwise = (e: number): boolean => acceptedOwnWraps(session, self, e).some((w) => !bytesEqual(w.row.owner, leavingId))
  const selfId = decodeIdentifier(self)
  const onlyTheirs = session.wraps
    .filter((w) => bytesEqual(w.row.memberId, selfId) && bytesEqual(w.row.owner, leavingId) && w.row.epoch <= top && session.resolution.keys.has(w.row.epoch))
    .map((w) => w.row.epoch)
    .filter((e) => !heldOtherwise(e))
  if (!heldOtherwise(top)) onlyTheirs.push(top)
  return [...new Set(onlyTheirs)].sort((x, y) => x - y)
}

/** Whether `self` needs any self-wrap before `leaving`'s maintainer role goes ({@link keepWrapEpochs}). */
export function needsKeepWrap(session: PrivateSession, self: string, leaving: string): boolean {
  return keepWrapEpochs(session, self, leaving).length > 0
}

/**
 * Before a maintainer's role is deleted: wrap to this signer every epoch in {@link keepWrapEpochs}.
 * An epoch it holds only through the chain has no wrap of its own to unwrap: refused. A standing
 * self-wrap with another key is an error (a wrap cannot be replaced within an epoch).
 */
async function keepCurrentKey(c: PrivateWriteContext, session: PrivateSession, leaving: string, intent: string): Promise<void> {
  for (const n of keepWrapEpochs(session, c.auth.identityId, leaving)) {
    if (acceptedOwnWraps(session, c.auth.identityId, n).length === 0) {
      throw new PrivateMembersError(`you have no copy of key epoch ${n} of your own to keep; ask another maintainer to remove this one`, 'E310')
    }
    const kn = await rawEpochKey(session, c, n)
    try {
      requireSame(await postWrap(c, session, kn.keys, kn.raw, c.auth.identityId, senderKey(session, c).keyId, `${intent}:keep`), c.auth.identityId, n)
    } finally {
      kn.raw.fill(0)
    }
  }
}

/**
 * Before a maintainer's role is deleted (§5.3): for every epoch they anchored that does not vanish
 * ({@link epochsToReanchor}), post a config under
 * the same key with the same `prevEpoch` / `prevEpochKey` and the current config fields, so the
 * next anchor among the remaining maintainers carries the same commitment and still chains.
 * Refuses (nothing written) when this browser cannot read one of those epochs.
 */
async function reanchorEpochsOf(
  c: PrivateWriteContext,
  session: PrivateSession,
  memberId: string,
  intent: string,
  onStep?: (s: RotationStep) => void,
): Promise<void> {
  const epochs = epochsToReanchor(session, memberId)
  const unreadable = epochs.filter((e) => !session.resolution.keys.has(e))
  if (unreadable.length > 0) {
    throw new PrivateMembersError(
      `this maintainer anchored key epoch ${unreadable.join(', ')}, which you can't read, so their role can't be removed from this browser without losing it`,
      'E310',
    )
  }
  const self = decodeIdentifier(c.auth.identityId)
  await keepCurrentKey(c, session, memberId, intent)
  for (const e of epochs) {
    const keys = session.resolution.keys.get(e) as EpochKeys
    const anchor = session.resolution.anchors.get(e) as Anchor
    // Already re-anchored by this signer (an earlier attempt): a config of ours at this epoch
    // that stands in for the anchor. Never pay for it twice.
    let done = false
    for (const cfg of session.configRows) {
      if (cfg.epoch !== e || !bytesEqual(cfg.owner, self) || bytesEqual(cfg.id, anchor.id)) continue
      if (await sameAnchor(session, e, cfg)) {
        done = true
        break
      }
    }
    if (done) {
      onStep?.({ kind: 'reanchored', epoch: e })
      continue
    }
    // The anchor's own chain pair (an epoch-0 anchor has none).
    const opened = await openContent(
      { type: 'config', ownerId: anchor.owner, epoch: e, id: anchor.id, createdAtBlockHeight: anchor.height, enc: anchor.config.enc },
      session.ctx,
    )
    if (opened.status !== 'readable') throw new PrivateMembersError(`the anchor of epoch ${e} does not open; repair the repo first`, 'E310')
    const { prevEpoch, prevEpochKey, skipEpochKey, burned } = opened.fields
    try {
      // The same key and the whole chain link (§5.3: prevEpoch, prevEpochKey, skipEpochKey,
      // burned): the re-anchor stands in for the anchor.
      const anchorFields = anchorOf(
        c,
        session,
        prevEpoch === undefined
          ? null
          : {
              prevEpoch,
              ...(prevEpochKey !== undefined ? { prevEpochKey } : {}),
              ...(skipEpochKey !== undefined ? { skipEpochKey } : {}),
              ...(burned === true ? { burned } : {}),
            },
      )
      const enc = await sealDoc(keys, { type: 'config', ownerId: self, epoch: e }, anchorFields.fields, { anchor: true })
      await postConfig(
        c,
        { repoId: decodeIdentifier(c.repo.repoId), epoch: e, enc, ...anchorFields.plaintext },
        `${intent}:reanchor:${e}:${keyTag(keys)}`,
      )
    } finally {
      prevEpochKey?.fill(0)
      skipEpochKey?.fill(0)
    }
    onStep?.({ kind: 'reanchored', epoch: e })
  }
}

/**
 * Run the repair check's actions (§5.6): rotate when a wrapped identity is not a member, then
 * wrap each member without a wrap to an enabled key.
 */
export async function runRepair(
  c: PrivateWriteContext,
  intent: string,
  onStep?: (s: RotationStep) => void,
  drop: readonly { readonly identity: string; readonly role?: Role }[] = [],
  afterLoss = false,
): Promise<void> {
  const first = await withFreshSession(c, async (s) => planRepair(s, c.auth.identityId, c.repo.forge.core), drop)
  if (first === null) return
  if (first.rotate.length > 0 || first.burned) {
    await rotateRepoKey(c, first.rotate, `${intent}:rotate`, onStep, [...drop, ...first.rotate.map((identity) => ({ identity }))], undefined, afterLoss)
  }
  await withFreshSession(c, (session) => wrapMissing(c, session, intent, onStep, drop), drop)
}

/** §5.6's second action: wrap the current epoch to each member with no wrap to an enabled key. */
async function wrapMissing(
  c: PrivateWriteContext,
  session: PrivateSession,
  intent: string,
  onStep?: (s: RotationStep) => void,
  drop: readonly { readonly identity: string; readonly role?: Role }[] = [],
): Promise<void> {
  const plan = planRepair(session, c.auth.identityId, c.repo.forge.core)
  if (plan === null) return
  const n = session.resolution.writeEpoch
  if (n === null || plan.wrap.length === 0) return
  await assertMembersSettled(c, session, drop)
  const kn = await rawEpochKey(session, c, n)
  try {
    for (const id of plan.wrap) {
      const key = usableEncryptionKey(session.memberKeys.get(id) ?? [], c.repo.forge.core)
      if (key === null) continue
      const outcome = await postWrap(c, session, kn.keys, kn.raw, id, key.keyId, intent)
      // A standing wrap to a key they no longer hold cannot be replaced: that needs a rotation.
      if (outcome.kind !== 'same') continue
      onStep?.({ kind: 'wrapped', identity: id, epoch: n })
    }
  } finally {
    kn.raw.fill(0)
  }
}

/** The cost of a repair: a rotation (members + 1) when needed, plus one wrap per unwrapped member. */
export function repairCost(session: PrivateSession, plan: RepairPlan, self: string, coreId: string, held: number | readonly number[]): CostPreview {
  const wraps = plan.wrap.map(() => previewCreate('repoKey'))
  if (plan.rotate.length === 0 && !plan.burned) return sumPreviews(wraps)
  return rotationCost(planRotation(session, self, plan.rotate, coreId, held))
}
