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
  bytesEqual,
  compareBytes,
  generateEpochKey,
  sealDoc,
} from '../private'
import type { Role } from '../rules/v2'
import { ConsensusRefusal, DUPLICATE_UNIQUE_CODE, createDocumentIdempotent, previewCreate, sumPreviews, type CostPreview, type WriteAuth } from '../sdk'
import { sleep } from '../sdk/facade'
import { DOC, type RepoRef } from './contract'
import { invalidateMembers, readMemberships } from './members'
import { invalidatePrivateSession, isMaintainer, loadPrivateSessionFresh, sessionUnwrapper, type PrivateSession, type WrapDoc } from './private-session'
import { grantMember, revokeMember } from './writes'


/** A private-repo membership change that cannot go ahead, with the message to show. */
export class PrivateMembersError extends Error {
  constructor(
    message: string,
    /** The CLI's error code for the same condition (E305–E309). */
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
export function planRotation(session: PrivateSession, self: string, exclude: readonly string[], coreId: string): RotationPlan {
  const r = session.resolution
  const n = r.currentEpoch
  if (n === null) throw new PrivateMembersError('this repo has no key epoch yet', 'E309')
  if (r.writeEpoch !== n) {
    throw new PrivateMembersError(`you can't read the current key (epoch ${n}); ask another maintainer to rotate`, 'E306')
  }
  if (!isMaintainer(session, self)) {
    throw new PrivateMembersError('only a current maintainer can rotate the repo key')
  }
  const selfId = decodeIdentifier(self)
  const excluded = new Set(exclude)
  const remaining = [...new Set(session.members.map((m) => m.identity))].filter((id) => !excluded.has(id))
  if (!remaining.includes(self)) throw new PrivateMembersError('you cannot remove yourself this way')

  // Resume (§5.5 crash between steps 2 and 3): the smallest unanchored epoch above n holding a
  // self-wrap by self, unless one of self's wraps there went to an identity now excluded (the
  // key would then be known to someone it must not be).
  const mine = session.wraps.filter((w) => bytesEqual(w.row.owner, selfId) && w.row.epoch > n && !r.anchors.has(w.row.epoch))
  const leaked = new Set(mine.filter((w) => !remaining.includes(base58Encode(w.row.memberId))).map((w) => w.row.epoch))
  const resumable = mine
    .filter((w) => bytesEqual(w.row.memberId, selfId) && !leaked.has(w.row.epoch))
    .sort((a, b) => a.row.epoch - b.row.epoch)
  const resume = resumable[0] ?? null
  let epoch: number
  if (resume !== null) {
    epoch = resume.row.epoch
  } else {
    // The smallest epoch above n with no wrap by self (and no anchor, above n by definition).
    const taken = new Set(mine.map((w) => w.row.epoch))
    epoch = n + 1
    while (taken.has(epoch)) epoch += 1
    if (epoch > 0xffff_ffff) throw new PrivateMembersError('no key epoch number is left')
  }

  const wrappedBySelf = new Set(mine.filter((w) => w.row.epoch === epoch).map((w) => base58Encode(w.row.memberId)))
  const ordered = [self, ...remaining.filter((id) => id !== self).sort((a, b) => compareBytes(decodeIdentifier(a), decodeIdentifier(b)))]
  const recipients: RotationRecipient[] = []
  const unreachable: string[] = []
  for (const id of ordered) {
    const key = usableEncryptionKey(session.memberKeys.get(id) ?? [], coreId)
    if (key === null) {
      if (id === self) throw new PrivateMembersError('your identity has no usable encryption key', 'E305')
      unreachable.push(id)
      continue
    }
    recipients.push({ identity: id, keyId: key.keyId, done: wrappedBySelf.has(id) })
  }
  return {
    from: n,
    epoch,
    resume,
    recipients,
    unreachable,
    excluded: [...excluded],
    writes: recipients.filter((x) => !x.done).length + 1,
  }
}

/** The cost shown before a rotation: its wraps plus the anchor (§5.5: members + 1). */
export function rotationCost(plan: RotationPlan): CostPreview {
  return sumPreviews([...plan.recipients.filter((x) => !x.done).map(() => previewCreate('repoKey')), previewCreate('config')])
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
}

/** The repair plan of `session` for `self` (pure); null when the check passes or self is not a maintainer. */
export function planRepair(session: PrivateSession, self: string, coreId: string): RepairPlan | null {
  const repair = session.resolution.repair
  if (repair === null || !isMaintainer(session, self)) return null
  const rotate = repair.nonMembers.map(base58Encode)
  const wrap: string[] = []
  const waiting: string[] = []
  for (const m of repair.missingWraps.map(base58Encode)) {
    if (usableEncryptionKey(session.memberKeys.get(m) ?? [], coreId) === null) waiting.push(m)
    else wrap.push(m)
  }
  if (rotate.length === 0 && wrap.length === 0 && waiting.length === 0) return null
  return { rotate, wrap, waiting }
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

/** A fresh session (§5.3: anchors are re-read before every write). */
function freshSession(c: PrivateWriteContext): Promise<PrivateSession> {
  invalidateMembers(c.repo, c.network)
  return loadPrivateSessionFresh(c.sdk, c.repo, c.network, c.auth.identityId, sessionUnwrapper(c.ops))
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
    throw new PrivateMembersError('the encryption key in this browser is no longer enabled on your identity; import your current one', 'E305')
  }
  return k
}

/**
 * The raw key of the reader's readable epoch `epoch`, from its own accepted wrap (a wrap to self
 * from a current maintainer whose key matches the anchor). The caller wipes it.
 */
async function rawEpochKey(session: PrivateSession, c: PrivateWriteContext, epoch: number): Promise<{ keys: EpochKeys; raw: Uint8Array }> {
  const want = session.resolution.keys.get(epoch)
  if (want === undefined) throw new PrivateMembersError(`you can't read epoch ${epoch}`, 'E306')
  const self = decodeIdentifier(c.auth.identityId)
  for (const w of session.wraps) {
    if (w.row.epoch !== epoch || w.row.keys === undefined || !bytesEqual(w.row.memberId, self)) continue
    if (!bytesEqual(w.row.keys.commit, want.commit)) continue
    return c.ops.unwrapRaw({
      document: w.raw,
      counterpartyKey: keyOf(session, base58Encode(w.row.owner), w.senderKeyId),
      repoId: session.repoId,
      epoch,
    })
  }
  throw new PrivateMembersError(`no wrap of epoch ${epoch} to you was found`, 'E306')
}

/** Post one `repoKey` wrapping `raw` (epoch `keys.epoch`) to `identity`'s key `keyId`. */
async function postWrap(c: PrivateWriteContext, session: PrivateSession, keys: EpochKeys, raw: Uint8Array, identity: string, keyId: number, intent: string): Promise<void> {
  const props = await c.ops.wrap({ keys, raw, senderKey: senderKey(session, c), recipientKey: keyOf(session, identity, keyId) })
  try {
    await createDocumentIdempotent(c.sdk, c.auth, {
      contractId: c.repo.forge.core,
      documentType: DOC.repoKey,
      data: { repoId: decodeIdentifier(c.repo.repoId), memberId: decodeIdentifier(identity), epoch: keys.epoch, ...props },
      intent: `${intent}:wrap:${keys.epoch}:${identity}`,
    })
  } catch (e) {
    // The unique (repoId, memberId, epoch, $ownerId) is taken: this identity already wrapped it.
    if (!(e instanceof ConsensusRefusal && e.code === DUPLICATE_UNIQUE_CODE)) throw e
  }
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
): Promise<number> {
  const session = await freshSession(c)
  const plan = planRotation(session, c.auth.identityId, exclude, c.repo.forge.core)
  const kn = await rawEpochKey(session, c, plan.from)
  let next: { keys: EpochKeys; raw: Uint8Array }
  try {
    if (plan.resume !== null) {
      next = await c.ops.unwrapRaw({
        document: plan.resume.raw,
        counterpartyKey: keyOf(session, c.auth.identityId, plan.resume.senderKeyId),
        repoId: session.repoId,
        epoch: plan.epoch,
      })
    } else {
      const raw = generateEpochKey()
      next = { keys: await EpochKeys.import(session.repoId, plan.epoch, raw), raw }
    }
    try {
      // Step 2: wraps, self first (the self-wrap is the journal).
      for (const r of plan.recipients) {
        if (r.done) continue
        await postWrap(c, session, next.keys, next.raw, r.identity, r.keyId, intent)
        onStep?.({ kind: 'wrapped', identity: r.identity, epoch: plan.epoch })
      }
      // Step 3: the anchor, repeating the current config.
      const fields = {
        ...(session.config !== null ? { defaultBranch: session.config.defaultBranch, protectedPatterns: [...session.config.protectedPatterns] } : {}),
        prevEpoch: plan.from,
        prevEpochKey: kn.raw,
      }
      const enc = await sealDoc(next.keys, { type: 'config', ownerId: decodeIdentifier(c.auth.identityId), epoch: plan.epoch }, fields, { anchor: true })
      await createDocumentIdempotent(c.sdk, c.auth, {
        contractId: c.repo.forge.core,
        documentType: DOC.config,
        data: {
          repoId: decodeIdentifier(c.repo.repoId),
          epoch: plan.epoch,
          enc,
          backend: session.configPlain?.backend ?? { mode: 0 },
          archived: session.configPlain?.archived ?? false,
        },
        intent: `${intent}:anchor:${plan.epoch}`,
      })
    } finally {
      next.raw.fill(0)
    }
  } finally {
    kn.raw.fill(0)
  }
  // Step 4: confirm the anchor of the new epoch is this identity's, among current maintainers.
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    onStep?.({ kind: 'waiting', what: `the anchor of epoch ${plan.epoch}` })
    const s = await freshSession(c)
    const anchor = s.anchors.get(plan.epoch)
    if (anchor !== undefined) {
      if (anchor.owner !== c.auth.identityId) {
        throw new PrivateMembersError(
          `another maintainer rotated to epoch ${plan.epoch} first; their key is the repo's key. Nothing more to do.`,
          'E309',
        )
      }
      onStep?.({ kind: 'anchored', epoch: plan.epoch })
      return plan.epoch
    }
    await sleep(POLL_MS)
  }
  throw new PrivateMembersError(`the anchor of epoch ${plan.epoch} is not visible yet; reload and repair to finish`, 'E309')
}

/**
 * Add a member (§5.5): check their usable ENCRYPTION key, write the membership document, then a
 * wrap of the current epoch to them. Two transitions.
 */
export async function addPrivateMember(c: PrivateWriteContext, memberId: string, role: Role, intent: string): Promise<void> {
  const before = await freshSession(c)
  const keys = before.memberKeys.get(memberId) ?? (await fetchIdentityKeys(c.sdk, memberId))
  if (usableEncryptionKey(keys ?? [], c.repo.forge.core) === null) throw new PrivateMembersError(`${memberId.slice(0, 8)}… has no encryption key yet`, 'E305')
  await grantMember(c.sdk, c.auth, c.repo, memberId, role, `${intent}:member`)
  await waitForMembers(c, (ids) => ids.includes(memberId))
  const session = await freshSession(c)
  const n = session.resolution.writeEpoch
  if (n === null) throw new PrivateMembersError("you can't read the current key, so you can't hand it out", 'E306')
  const key = usableEncryptionKey(session.memberKeys.get(memberId) ?? [], c.repo.forge.core)
  if (key === null) throw new PrivateMembersError(`${memberId.slice(0, 8)}… has no encryption key yet`, 'E305')
  const kn = await rawEpochKey(session, c, n)
  try {
    await postWrap(c, session, kn.keys, kn.raw, memberId, key.keyId, intent)
  } finally {
    kn.raw.fill(0)
  }
  invalidatePrivateSession(c.repo)
}

/** Whether `id` has a usable ENCRYPTION key (the Add button's check). */
export async function hasUsableEncryptionKey(sdk: EvoSDK, coreId: string, id: string): Promise<boolean> {
  const keys = await fetchIdentityKeys(sdk, id)
  return keys !== null && usableEncryptionKey(keys, coreId) !== null
}

/** Poll the membership (uncached) until `ok` holds for its identities. */
async function waitForMembers(c: PrivateWriteContext, ok: (ids: string[]) => boolean): Promise<void> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    invalidateMembers(c.repo, c.network)
    const ids = (await readMemberships(c.sdk, c.repo)).map((m) => m.identity)
    if (ok(ids)) return
    await sleep(POLL_MS)
  }
  throw new PrivateMembersError('the membership change is not visible yet; reload and repair to finish', 'E309')
}

/**
 * Remove a member (owner only) and rotate (§5.5): delete the membership, wait until the list no
 * longer shows them, then {@link rotateRepoKey} excluding them explicitly.
 */
export async function removePrivateMember(
  c: PrivateWriteContext,
  memberId: string,
  role: Role,
  intent: string,
  onStep?: (s: RotationStep) => void,
): Promise<number> {
  await revokeMember(c.sdk, c.auth, c.repo, memberId, role)
  onStep?.({ kind: 'deleted' })
  onStep?.({ kind: 'waiting', what: 'the member list to drop them' })
  await waitForMembers(c, (ids) => !ids.includes(memberId))
  return rotateRepoKey(c, [memberId], intent, onStep)
}

/**
 * Run the repair check's actions (§5.6): rotate when a wrapped identity is not a member, then
 * wrap each member without a wrap to an enabled key.
 */
export async function runRepair(c: PrivateWriteContext, intent: string, onStep?: (s: RotationStep) => void): Promise<void> {
  let session = await freshSession(c)
  let plan = planRepair(session, c.auth.identityId, c.repo.forge.core)
  if (plan === null) return
  if (plan.rotate.length > 0) {
    await rotateRepoKey(c, plan.rotate, `${intent}:rotate`, onStep)
    session = await freshSession(c)
    plan = planRepair(session, c.auth.identityId, c.repo.forge.core)
    if (plan === null) return
  }
  const n = session.resolution.writeEpoch
  if (n === null || plan.wrap.length === 0) return
  const kn = await rawEpochKey(session, c, n)
  try {
    for (const id of plan.wrap) {
      const key = usableEncryptionKey(session.memberKeys.get(id) ?? [], c.repo.forge.core)
      if (key === null) continue
      await postWrap(c, session, kn.keys, kn.raw, id, key.keyId, intent)
      onStep?.({ kind: 'wrapped', identity: id, epoch: n })
    }
  } finally {
    kn.raw.fill(0)
  }
  invalidatePrivateSession(c.repo)
}

/** The cost of a repair: a rotation (members + 1) when needed, plus one wrap per unwrapped member. */
export function repairCost(session: PrivateSession, plan: RepairPlan, self: string, coreId: string): CostPreview {
  const wraps = plan.wrap.map(() => previewCreate('repoKey'))
  if (plan.rotate.length === 0) return sumPreviews(wraps)
  return rotationCost(planRotation(session, self, plan.rotate, coreId))
}
