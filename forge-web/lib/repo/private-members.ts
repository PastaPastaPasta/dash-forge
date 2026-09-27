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
import { fetchIdentityKeys, usableEncryptionKey } from '../auth/encryption-key'
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
  createDocumentIdempotent,
  previewCreate,
  queryDocumentsWithProof,
  sumPreviews,
  type CostPreview,
  type WriteAuth,
} from '../sdk'
import { sleep } from '../sdk/facade'
import { DOC, type RepoRef } from './contract'
import { invalidateMembers, readMemberships } from './members'
import {
  isMaintainer,
  loadPrivateSessionUncached,
  parseWrapDoc,
  sdkSessionSource,
  sessionUnwrapper,
  type PrivateSession,
  type WrapDoc,
} from './private-session'
import { repoSource } from './source'
import { assertNoPlaintext, grantMember, revokeMember } from './writes'


/** A private-repo membership change that cannot go ahead, with the message to show. */
export class PrivateMembersError extends Error {
  constructor(
    message: string,
    /** The CLI's error code for the same condition (E306–E310). */
    readonly code?: string,
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
  /** Documents to write: the missing wraps plus the anchor. */
  readonly writes: number
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
  /** The id of the encryption key this browser holds: only a self-wrap to it can be resumed. */
  heldKeyId: number,
  /** The epoch the rotation chains from: the current one, or the one a maintainer's removal keeps. */
  from: number | null = session.resolution.currentEpoch,
): RotationPlan {
  const r = session.resolution
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
  const remaining = [...new Set(session.members.map((m) => m.identity))].filter((id) => !excluded.has(id))
  if (!remaining.includes(self)) throw new PrivateMembersError('you cannot remove yourself this way')

  // Epochs are contiguous (§5.3): the new one is always n + 1. A rotation that stopped after its
  // self-wrap left a pending n + 1 (the unique index keeps that wrap): its key is the one n + 1
  // must use. When one of this signer's wraps there reached someone outside the remaining
  // members, n + 1 is burned instead (anchored chain-only, then n + 2).
  const epoch = n + 1
  if (epoch > 0xffff_ffff) throw new PrivateMembersError('no key epoch number is left')
  const mine = session.wraps.filter((w) => bytesEqual(w.row.owner, selfId) && w.row.epoch === epoch)
  const selfWrap = mine.find((w) => bytesEqual(w.row.memberId, selfId)) ?? null
  if (selfWrap !== null && selfWrap.row.recipientKeyId !== heldKeyId) {
    throw new PrivateMembersError(
      `your pending key wrap of epoch ${epoch} went to your key ${selfWrap.row.recipientKeyId}, which this browser does not hold; add it here, or ask another maintainer to rotate`,
      'E310',
    )
  }
  const resume = selfWrap
  const burn = resume !== null && mine.some((w) => !remaining.includes(base58Encode(w.row.memberId)))
  const wrappedBySelf = new Set(mine.filter((w) => w.row.epoch === epoch).map((w) => base58Encode(w.row.memberId)))
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
    recipients.push({ identity: id, keyId: key.keyId, done: wrappedBySelf.has(id) })
  }
  return {
    from: n,
    epoch,
    resume,
    burn,
    recipients,
    unreachable,
    excluded: [...excluded],
    // A burn: its anchor, then a full rotation to n + 2.
    writes: burn ? 1 + recipients.length + 1 : recipients.filter((x) => !x.done).length + 1,
  }
}

/** The cost shown before a rotation: its wraps plus the anchor (§5.5: members + 1). */
export function rotationCost(plan: RotationPlan): CostPreview {
  const wraps = plan.burn ? plan.recipients.length : plan.recipients.filter((x) => !x.done).length
  return sumPreviews([...Array.from({ length: wraps }, () => previewCreate('repoKey')), previewCreate('config'), ...(plan.burn ? [previewCreate('config')] : [])])
}

/** The cost shown before adding a member: the membership document and one wrap (~0.0006 DASH). */
export function addMemberCost(role: Role): CostPreview {
  return sumPreviews([previewCreate(role), previewCreate('repoKey')])
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
  const burned = r.currentEpoch !== null && r.burned.has(r.currentEpoch)
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
  if (k === undefined) throw new PrivateMembersError(`the encryption key of ${identity.slice(0, 8)}… could not be read`)
  return k as unknown as IdentityPublicKey
}

/** This identity's stored encryption key, as the sender of a wrap: it must still be usable. */
function senderKey(session: PrivateSession, c: PrivateWriteContext): IdentityPublicKey {
  const mine = session.memberKeys.get(c.auth.identityId) ?? []
  const k = mine.find((x) => x.keyId === c.ops.keyId) as (EncKeyLike & IdentityPublicKey) | undefined
  if (k === undefined || usableEncryptionKey([k], c.repo.forge.core) === null) {
    throw new PrivateMembersError('the encryption key in this browser is no longer enabled on your identity; import your current one', 'E306')
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
  await createDocumentIdempotent(c.sdk, c.auth, { contractId: c.repo.forge.core, documentType: DOC.config, data, intent })
}

/** The config fields a new anchor repeats: the current branch and patterns (a `main` default when none opens). */
function currentConfigFields(session: PrivateSession): { defaultBranch: string; protectedPatterns: string[] } {
  return { defaultBranch: session.config?.defaultBranch ?? 'main', protectedPatterns: [...(session.config?.protectedPatterns ?? [])] }
}

/** A short, public tag of an epoch key (its commitment): binds a signed write to the key it carries. */
function keyTag(keys: EpochKeys): string {
  return bytesToHex(keys.commit).slice(0, 16)
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
  const data = { repoId: decodeIdentifier(c.repo.repoId), memberId: decodeIdentifier(identity), epoch: keys.epoch, ...props }
  assertNoPlaintext(c.repo, DOC.repoKey, data)
  try {
    await createDocumentIdempotent(c.sdk, c.auth, {
      contractId: c.repo.forge.core,
      documentType: DOC.repoKey,
      data,
      intent: `${intent}:wrap:${keys.epoch}:${keyTag(keys)}:${identity}`,
    })
    return { kind: 'same' }
  } catch (e) {
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
  if (w === null || w.senderKeyId !== c.ops.keyId) return null
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
  return new PrivateMembersError(
    outcome.kind === 'unreadable'
      ? `your key wrap of epoch ${epoch} for ${identity.slice(0, 8)}… stands and cannot be read back from this browser`
      : `key epoch ${epoch} already holds another key of yours for ${identity.slice(0, 8)}…; run the rotation again`,
    'E310',
  )
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
export type AnchorVerdict = 'ours' | 'lost' | 'mismatch' | 'pending'

/**
 * `ours` only when the anchor is by `self`, commits to our key, and this reader holds the epoch;
 * `lost` when another current maintainer's anchor is first; `mismatch` for our anchor with
 * another key (a replayed or stale write); `pending` while none is visible.
 */
export function anchorVerdict(session: PrivateSession, epoch: number, commit: Uint8Array, self: string): AnchorVerdict {
  const anchor = session.resolution.anchors.get(epoch)
  if (anchor === undefined) return 'pending'
  if (base58Encode(anchor.owner) !== self) return 'lost'
  if (anchor.commit === null || !bytesEqual(anchor.commit, commit)) return 'mismatch'
  // Our anchor, with our key: the epoch is ours even if someone already rotated past it. We must
  // be able to read it (our self-wrap holds this key); a later epoch does not change that.
  return session.resolution.keys.has(epoch) ? 'ours' : 'mismatch'
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
  /** The current epoch before the removal this rotation follows (see `rotateWith`). */
  minFrom?: number,
  /** This rotation is the repair after a lost one: do not chain another repair. */
  afterLoss = false,
): Promise<number> {
  const done = await withFreshSession(c, (session) => rotateWith(c, session, exclude, intent, onStep, minFrom, drop), drop)
  // Step 4: confirm the anchor of the new epoch is ours, with our key, among current maintainers.
  const epoch = 'lost' in done ? done.lost : done.epoch
  if (!('lost' in done) && (await confirmAnchor(c, done.epoch, done.commit, drop, onStep)) === 'ours') {
    onStep?.({ kind: 'anchored', epoch })
    return epoch
  }
  // Their key is the repo's key now. If they rotated from a member list that still had the
  // removed member, that member holds it: the repair check (with this removal's drop) finds and
  // rotates that. A second loss in a row is reported rather than chased.
  onStep?.({ kind: 'lost', epoch })
  if (!afterLoss) await runRepair(c, `${intent}:after-lost`, onStep, drop, true)
  throw new PrivateMembersError(`another maintainer rotated to epoch ${epoch} first; their key is the repo's key, and the repair check ran after it.`, 'E310')
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
    if (verdict === 'mismatch') {
      throw new PrivateMembersError(`the anchor of epoch ${epoch} does not carry the key you wrapped; run the rotation again`, 'E310')
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
  const plan = planRotation(session, c.auth.identityId, exclude, c.repo.forge.core, c.ops.keyId)
  // The read must be at least as new as the removal it follows: a current epoch below the one
  // before the removal means its re-anchor is not visible here yet, and chaining from it would
  // skip that epoch.
  if (minFrom !== undefined && plan.from < minFrom) {
    throw new PrivateMembersError('the repo\'s key epochs are still catching up after the removal; try again in a moment', 'E310')
  }
  await assertMembersSettled(c, session, drop)
  const self = plan.recipients[0]
  if (self === undefined || self.identity !== c.auth.identityId) throw new PrivateMembersError('your identity has no usable encryption key', 'E306')
  const kn = await rawEpochKey(session, c, plan.from)
  try {
    // n + 1's key: the pending self-wrap's (the unique index keeps it; it is the only key n + 1
    // can have for this signer), else a fresh one.
    const pending = plan.resume
    const next: { keys: EpochKeys; raw: Uint8Array } =
      pending !== null
        ? await c.ops.unwrapRaw({
            document: pending.raw,
            counterpartyKey: keyOf(session, c.auth.identityId, pending.senderKeyId),
            repoId: session.repoId,
            epoch: plan.epoch,
          })
        : await freshKey(session.repoId, plan.epoch)
    try {
      // The self-wrap first (the journal). A self-wrap that stands unseen by this read (a retry
      // whose read lagged it) stops the run: it re-plans from a read that shows it.
      const selfOutcome = self.done
        ? await standingOutcome(c, session, next.keys, self.identity, self.keyId)
        : await postWrap(c, session, next.keys, next.raw, self.identity, self.keyId, intent)
      if (selfOutcome.kind === 'different') {
        throw new PrivateMembersError(`an earlier run of this rotation already wrapped epoch ${plan.epoch}; run it again in a moment`, 'E310')
      } else if (selfOutcome.kind === 'unreadable') {
        throw unusableWrap(selfOutcome, self.identity, plan.epoch)
      }
      onStep?.({ kind: 'wrapped', identity: self.identity, epoch: plan.epoch })
      // Which of this signer's wraps at n + 1 stand now (a fresh read): any outside the remaining
      // members means n + 1's key is burned.
      const allowed = [...plan.recipients.map((r) => r.identity), ...plan.unreachable]
      const strays = await straysAt(c, plan.epoch, allowed)
      if (strays.length > 0) {
        // §5.3 burn: anchor n + 1 chain-only with that key, then rotate to n + 2 from it.
        await postAnchor(c, session, next.keys, plan.epoch, plan.from, kn.raw, intent, true)
        // n + 2 chains from n + 1's key: only once the burned anchor is n + 1's. When another
        // maintainer's n + 1 came first, stop (the repair check takes over from theirs).
        if ((await confirmAnchor(c, plan.epoch, next.keys.commit, drop, onStep)) === 'lost') return { lost: plan.epoch }
        onStep?.({ kind: 'burned', epoch: plan.epoch })
        const n2 = plan.epoch + 1
        const after = await freshKey(session.repoId, n2)
        try {
          for (const r of plan.recipients) {
            requireSame(await postWrap(c, session, after.keys, after.raw, r.identity, r.keyId, intent), r.identity, n2)
            onStep?.({ kind: 'wrapped', identity: r.identity, epoch: n2 })
          }
          if ((await straysAt(c, n2, allowed)).length > 0) throw new PrivateMembersError(`key epoch ${n2} reached someone it must not; stopped`, 'E310')
          await postAnchor(c, session, after.keys, n2, plan.epoch, next.raw, intent, false)
          return { epoch: n2, commit: after.keys.commit }
        } finally {
          after.raw.fill(0)
        }
      }
      // A normal rotation: every remaining member, then the anchor.
      for (const r of plan.recipients.slice(1)) {
        // Already wrapped by an earlier run: verify it holds this key (a refused duplicate would
        // still pay its fee), else post it.
        const outcome = r.done
          ? await standingOutcome(c, session, next.keys, r.identity, r.keyId)
          : await postWrap(c, session, next.keys, next.raw, r.identity, r.keyId, intent)
        requireSame(outcome, r.identity, plan.epoch)
        onStep?.({ kind: 'wrapped', identity: r.identity, epoch: plan.epoch })
      }
      if ((await straysAt(c, plan.epoch, allowed)).length > 0) {
        throw new PrivateMembersError(`key epoch ${plan.epoch} reached someone it must not; run the rotation again`, 'E310')
      }
      await postAnchor(c, session, next.keys, plan.epoch, plan.from, kn.raw, intent, false)
      return { epoch: plan.epoch, commit: next.keys.commit }
    } finally {
      next.raw.fill(0)
    }
  } finally {
    kn.raw.fill(0)
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
  prevEpochKey: Uint8Array,
  intent: string,
  burned: boolean,
): Promise<void> {
  const fields = { ...currentConfigFields(session), prevEpoch, prevEpochKey: new Uint8Array(prevEpochKey), ...(burned ? { burned: true as const } : {}) }
  try {
    const enc = await sealDoc(keys, { type: 'config', ownerId: decodeIdentifier(c.auth.identityId), epoch }, fields, { anchor: true })
    await postConfig(
      c,
      {
        repoId: decodeIdentifier(c.repo.repoId),
        epoch,
        enc,
        backend: session.configPlain?.backend ?? { mode: 0 },
        archived: session.configPlain?.archived ?? false,
      },
      `${intent}:anchor:${epoch}:${keyTag(keys)}${burned ? ':burned' : ''}`,
    )
  } finally {
    fields.prevEpochKey.fill(0)
  }
}

/**
 * Add a member (§5.5): check their usable ENCRYPTION key, write the membership document, then a
 * wrap of the current epoch to them. Two transitions.
 */
export async function addPrivateMember(c: PrivateWriteContext, memberId: string, role: Role, intent: string): Promise<void> {
  const keys = await fetchIdentityKeys(c.sdk, memberId)
  if (usableEncryptionKey(keys ?? [], c.repo.forge.core) === null) throw new PrivateMembersError(`${memberId.slice(0, 8)}… has no encryption key yet`, 'E306')
  // Nothing is written unless the wrap can follow, and a new maintainer's old configs must not
  // take over any epoch (§5.3: under contiguity an earlier config of theirs would come first).
  await withFreshSession(c, async (s) => {
    requireWriteEpoch(s)
    if (role !== 'maintainer' || isMaintainer(s, memberId)) return
    const changed = await anchorChanges(s, new IdSet([...maintainersOf(s), decodeIdentifier(memberId)]))
    if (changed.length > 0) {
      throw new PrivateMembersError(
        `making ${memberId.slice(0, 8)}… a maintainer would change the key of epoch ${changed.join(', ')} (an earlier config of theirs would come first), so they can't be a maintainer of this repo again; add them as a writer`,
        'E310',
      )
    }
  })
  await grantMember(c.sdk, c.auth, c.repo, memberId, role, `${intent}:member`)
  await waitForMembers(c, (rows) => holds(rows, memberId, role))
  await withFreshSession(c, (session) => wrapForMember(c, session, memberId, intent))
}

/** The epoch a key can be handed out under; refuses a burned or unreadable current epoch. */
function requireWriteEpoch(session: PrivateSession): number {
  const r = session.resolution
  if (r.writeEpoch !== null) return r.writeEpoch
  if (r.currentEpoch !== null && r.burned.has(r.currentEpoch)) {
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
  if (key === null) throw new PrivateMembersError(`${memberId.slice(0, 8)}… has no encryption key yet`, 'E306')
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
async function waitForMembers(c: PrivateWriteContext, ok: (rows: readonly Membership[]) => boolean): Promise<readonly Membership[]> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    invalidateMembers(c.repo, c.network)
    const rows = await readMemberships(c.sdk, c.repo)
    if (ok(rows)) return rows
    await sleep(POLL_MS)
  }
  throw new PrivateMembersError('the membership change is not visible yet; reload to check it, then repair')
}

const holds = (rows: readonly Membership[], identity: string, role?: Role): boolean =>
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
  // epochs first (refused when this browser cannot read one), so no epoch vanishes or falls back.
  // The rotation after the delete chains from the epoch that stays current: refuse now, before
  // anything is deleted, when this browser cannot read it (a maintainer who holds it must remove).
  await withFreshSession(c, async (s) => {
    if (removalEffect(s.members, memberId, role) === 'none') return
    const kept = role === 'maintainer' ? keptEpoch(s, memberId) : s.resolution.currentEpoch
    if (kept !== null && !s.resolution.keys.has(kept)) {
      throw new PrivateMembersError(
        `key epoch ${kept} stays current after this removal and you can't read it, so the key can't be rotated from this browser; a maintainer who holds it must do the removal. Nothing was removed.`,
        'E310',
      )
    }
  })
  let before: number | undefined
  if (role === 'maintainer') {
    before = await withFreshSession(c, async (s) => {
      await reanchorEpochsOf(c, s, memberId, intent, onStep)
      return keptEpoch(s, memberId) ?? undefined
    })
    // The re-anchors must now be what each epoch falls back to once the role goes (a few reads:
    // the re-anchors may not be visible on the first node).
    for (let i = 0; ; i++) {
      const changed = await withFreshSession(c, (s) => anchorsWithout(s, memberId))
      if (changed.length === 0) break
      if (i + 1 >= SURVIVE_POLLS) throw anchorsWouldChange(changed)
      await sleep(POLL_MS)
    }
  }
  await revokeMember(c.sdk, c.auth, c.repo, memberId, role)
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
    // The membership is gone; the key must still move. The repair check (below) rotates when the
    // removed member still holds the current key. If that fails too, the page's Repair finishes it.
    onStep?.({ kind: 'waiting', what: 'the repair check after a failed rotation' })
    try {
      await runRepair(c, `${intent}:repair`, onStep, drop)
    } catch {
      throw afterRevoke(e)
    }
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
  const keep = role === 'maintainer' && needsKeepWrap(session, self, memberId) ? [previewCreate('repoKey')] : []
  return sumPreviews([...keep, ...reanchors, ...(plan !== null ? [rotationCost(plan)] : [])])
}

/**
 * The epochs whose anchor would change in substance once `leaving` is no longer a maintainer
 * (§5.3): each epoch that stays must fall back to a config with the same key, the same `burned`
 * flag and the same chain pair. The epochs that vanish ({@link vanishingEpochs}) must vanish.
 */
export async function anchorsWithout(session: PrivateSession, leaving: string): Promise<number[]> {
  const remaining = maintainersOf(session).filter((m) => !bytesEqual(m, decodeIdentifier(leaving)))
  return anchorChanges(session, new IdSet(remaining), new Set(vanishingEpochs(session, leaving)))
}

/**
 * The epochs whose anchor changes in substance when the maintainers are `maintainers` (sorted):
 * an epoch that exists now needs an anchor with the same key (commitment), the same `burned` flag
 * and the same chain pair (a config this reader cannot open only counts when it is the same
 * document); no new epoch may appear. `vanish`: epochs that must stop existing instead.
 */
async function anchorChanges(session: PrivateSession, maintainers: IdSet, vanish: ReadonlySet<number> = new Set()): Promise<number[]> {
  const r = session.resolution
  const after = selectAnchors(session.configRows, maintainers)
  const changed = [...after.keys()].filter((e) => !r.anchors.has(e))
  for (const [e, a] of r.anchors) {
    const next = after.get(e)
    if (vanish.has(e)) {
      if (next !== undefined) changed.push(e)
    } else if (next === undefined || (!bytesEqual(next.id, a.id) && !(await sameAnchor(session, e, next.config)))) {
      changed.push(e)
    }
  }
  return changed.sort((x, y) => x - y)
}

/**
 * Whether `config` could stand in for the anchor of `epoch`: it opens with the epoch's key (so it
 * carries the same commitment), with the same `burned` flag, and chains to the same key of
 * `epoch - 1` (§5.3). False when this reader cannot read the epoch.
 */
async function sameAnchor(session: PrivateSession, epoch: number, config: Anchor['config']): Promise<boolean> {
  const r = session.resolution
  const keys = r.keys.get(epoch)
  if (keys === undefined) return false
  const opened = await openWithKey(
    { type: 'config', ownerId: config.owner, epoch, id: config.id, createdAtBlockHeight: config.createdAtBlockHeight, enc: config.enc },
    keys,
    true,
  )
  if (opened.status !== 'readable') return false
  const { burned, prevEpoch, prevEpochKey } = opened.fields
  try {
    if ((burned === true) !== r.burned.has(epoch)) return false
    if (epoch === 0) return true
    const prevCommit = r.anchors.get(epoch - 1)?.commit
    if (prevEpoch !== epoch - 1 || prevEpochKey === undefined || prevCommit == null) return false
    const prev = await EpochKeys.import(session.repoId, epoch - 1, prevEpochKey)
    return bytesEqual(prev.commit, prevCommit)
  } finally {
    prevEpochKey?.fill(0)
  }
}

/**
 * The epochs that stop existing when `leaving`'s maintainer role goes (§5.3 contiguity): every
 * epoch above the highest one this reader can read, when `leaving` anchored the first of them.
 * Nobody else can read those (a maintainer who wrapped a new epoch to themselves alone); the next
 * rotation takes their numbers again. Empty otherwise, or when this reader can read nothing.
 */
export function vanishingEpochs(session: PrivateSession, leaving: string): number[] {
  const r = session.resolution
  if (r.currentEpoch === null) return []
  const top = Math.max(-1, ...r.keys.keys())
  if (top < 0 || session.anchors.get(top + 1)?.owner !== leaving) return []
  return Array.from({ length: r.currentEpoch - top }, (_, i) => top + 1 + i)
}

/** The current epoch once `leaving`'s maintainer role goes: below the ones that vanish. */
export function keptEpoch(session: PrivateSession, leaving: string): number | null {
  const gone = vanishingEpochs(session, leaving)
  return gone.length > 0 ? (gone[0] as number) - 1 : session.resolution.currentEpoch
}

/** The epochs `leaving` anchored that must be re-anchored before their role goes (not the vanishing ones). */
export function epochsToReanchor(session: PrivateSession, leaving: string): number[] {
  const gone = new Set(vanishingEpochs(session, leaving))
  return epochsAnchoredBy(session, leaving).filter((e) => !gone.has(e))
}

/** How many reads before a maintainer's removal is refused because an epoch would change key. */
const SURVIVE_POLLS = 4

/** The refusal when a maintainer's removal would change an epoch's key (nothing was removed). */
function anchorsWouldChange(changed: readonly number[]): PrivateMembersError {
  return new PrivateMembersError(
    `removing this maintainer would change the key of epoch ${changed.join(', ')} (another config comes first, or the re-anchor is not visible yet); nothing was removed. Try again in a moment, or ask the other maintainers about their configs for that epoch.`,
    'E310',
  )
}

/** The epochs whose anchor `memberId` wrote (the ones that go when their maintainer role does). */
export function epochsAnchoredBy(session: PrivateSession, memberId: string): number[] {
  return [...session.anchors.values()].filter((a) => a.owner === memberId).map((a) => a.epoch).sort((a, b) => a - b)
}

/**
 * Before a maintainer's role is deleted: the remover must keep the current epoch `n` it chains the
 * rotation from. When its only accepted wraps for `n` come from the leaving maintainer (whose
 * wraps stop counting, §5.4 check 2), it posts a self-wrap of `K_n` first. A reader that holds
 * `n` only through the chain has no wrap to unwrap: refused.
 */
/** Whether `self` needs a self-wrap of the current key before `leaving`'s maintainer role goes. */
export function needsKeepWrap(session: PrivateSession, self: string, leaving: string): boolean {
  const n = keptEpoch(session, leaving)
  if (n === null) return false
  const leavingId = decodeIdentifier(leaving)
  return !acceptedOwnWraps(session, self, n).some((w) => !bytesEqual(w.row.owner, leavingId))
}

async function keepCurrentKey(c: PrivateWriteContext, session: PrivateSession, leaving: string, intent: string): Promise<void> {
  const n = keptEpoch(session, leaving)
  if (n === null || !needsKeepWrap(session, c.auth.identityId, leaving)) return
  if (acceptedOwnWraps(session, c.auth.identityId, n).length === 0) {
    throw new PrivateMembersError(`you have no copy of the current key (epoch ${n}) of your own to keep; ask another maintainer to remove this one`, 'E310')
  }
  const kn = await rawEpochKey(session, c, n)
  try {
    requireSame(await postWrap(c, session, kn.keys, kn.raw, c.auth.identityId, c.ops.keyId, `${intent}:keep`), c.auth.identityId, n)
  } finally {
    kn.raw.fill(0)
  }
}

/**
 * Before a maintainer's role is deleted (§5.3): for every epoch they anchored, post a config under
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
    const anchor = session.resolution.anchors.get(e)
    if (anchor === undefined) continue
    // Already re-anchored by this signer (an earlier attempt): a config of ours at this epoch
    // that stands in for the anchor. Never pay for it twice.
    let done = false
    for (const cfg of session.configRows) {
      if (cfg.epoch === e && bytesEqual(cfg.owner, self) && !bytesEqual(cfg.id, anchor.id) && (await sameAnchor(session, e, cfg))) done = true
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
    const { prevEpoch, prevEpochKey, burned } = opened.fields
    try {
      // The same key, chain pair and burned flag (§5.3): the re-anchor stands in for the anchor.
      const fields = {
        ...currentConfigFields(session),
        ...(prevEpoch !== undefined && prevEpochKey !== undefined ? { prevEpoch, prevEpochKey } : {}),
        ...(burned === true ? { burned } : {}),
      }
      const enc = await sealDoc(keys, { type: 'config', ownerId: self, epoch: e }, fields, { anchor: true })
      await postConfig(
        c,
        {
          repoId: decodeIdentifier(c.repo.repoId),
          epoch: e,
          enc,
          backend: session.configPlain?.backend ?? { mode: 0 },
          archived: session.configPlain?.archived ?? false,
        },
        `${intent}:reanchor:${e}:${keyTag(keys)}`,
      )
    } finally {
      prevEpochKey?.fill(0)
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
export function repairCost(session: PrivateSession, plan: RepairPlan, self: string, coreId: string, heldKeyId: number): CostPreview {
  const wraps = plan.wrap.map(() => previewCreate('repoKey'))
  if (plan.rotate.length === 0 && !plan.burned) return sumPreviews(wraps)
  return rotationCost(planRotation(session, self, plan.rotate, coreId, heldKeyId))
}
