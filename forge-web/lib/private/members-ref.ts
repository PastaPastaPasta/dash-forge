/**
 * Members-only ref updates of a public repository (`docs/security/private-repos.md` §19.2,
 * mixed-visibility DESIGN §4.3); the Rust twin is `forge-core::private::members_ref`, held byte
 * for byte by the `sealed_ref` vectors (`members-git.conformance.test.ts`).
 *
 * A members-only branch is written as an ordinary `refUpdate` / `protectedRefUpdate` with
 * `refName` absent, `refNameHash = HMAC(K_ref,e, name)` under the members key's epoch, `vis:
 * "public"`, and `newOid` / `prevOid` holding blinds (`./blind`) under a fresh salt of this
 * document; the name, the real OIDs and the salt are sealed in `enc` v0x03 (TLV 3, 22, 23, 27).
 * Null OIDs stay plain: a create has no `prevOid`, a delete an all-zero `newOid`. `prevOid` is
 * blinded under the update's **own** salt, never copied from the update that introduced the
 * commit, so the public cannot chain a members-only branch's updates (only its name hash, which
 * groups them within an epoch, and `force` stay visible).
 *
 * Readers open the update (`openContent`: commitment, AES-GCM, TLV, the name hash check, the late
 * rule) and then take its real values ({@link realValues}): each blind is checked against the
 * value sealed beside it; a mismatch keeps the update and raises an {@link Alert}.
 */

import { alertOf, check, freshSalt, isNull, isOidWidth, plaintextOf, type Alert, type OidField } from './blind'
import type { Bytes } from './bytes'
import { openContent, sealMembersDoc, type OpenContext, type OpenResult, type PrivateDoc, type StoredPrivateDoc, type UnreadableReason } from './doc'
import type { PrivateId } from './ids'
import { refNameHash, type EpochKeys } from './keys'
import { MalformedError, type DocFields } from './tlv'

/** The two ref-update types. */
export type RefUpdateType = 'refUpdate' | 'protectedRefUpdate'

/** One members-only ref update to seal. */
export interface RefUpdateIn {
  readonly type: RefUpdateType
  /** The full ref name (`refs/heads/sec/fix`). */
  readonly name: string
  /** The real new tip; all zero for a delete. */
  readonly newOid: Uint8Array
  /** The real previous tip; absent for a create. */
  readonly prevOid?: Uint8Array
  readonly force: boolean
}

/** A sealed members-only ref update: the plaintext fields its document carries. */
export interface SealedRefUpdate {
  readonly type: RefUpdateType
  /** `HMAC(K_ref,e, name)`. */
  readonly refNameHash: Bytes
  /** The blind of the new tip (or the null OID of a delete). */
  readonly newOid: Bytes
  /** The blind of the previous tip, absent for a create. */
  readonly prevOid?: Bytes
  readonly force: boolean
  /** The members key's epoch it is sealed under. */
  readonly epoch: number
  /** `enc` v0x03. */
  readonly enc: Bytes
  /**
   * The salt of its blinds, which rule C copies into the PR head and head updates that name the
   * same commit (a members-only write path holds it; it is never published by itself).
   */
  readonly salt: Bytes
}

/**
 * The document properties a sealed update decides (`refNameHash`, `newOid`, `prevOid`, `force`,
 * `epoch`, `enc`, `vis`); the caller adds `repoId` and whatever else its type carries.
 */
export function sealedRefProps(s: SealedRefUpdate): Record<string, unknown> {
  return {
    refNameHash: s.refNameHash,
    newOid: s.newOid,
    ...(s.prevOid !== undefined ? { prevOid: s.prevOid } : {}),
    force: s.force,
    epoch: s.epoch,
    enc: s.enc,
    vis: 'public',
  }
}

/** Seals a ref update's plaintext header and TLV into `enc` v0x03. */
export type MembersRefSealer = (doc: PrivateDoc, fields: DocFields) => Promise<Uint8Array>

/**
 * The plaintext header and TLV fields of `input` with `salt`, its name hashed to `nameHash` under
 * key epoch (or branch generation) `epoch`: refused ({@link MalformedError}) for a type that is not
 * a ref update, an OID that is not 20 or 32 bytes, a `prevOid` of another width than `newOid`, and
 * an update that names no commit at all (a null create). forge-core `members_ref::header_and_fields`;
 * `./branch-key` seals a narrower branch's update (`enc` v0x06) from the same two.
 */
export async function refDocAndFields(
  nameHash: Uint8Array,
  epoch: number,
  ownerId: PrivateId,
  input: RefUpdateIn,
  salt: Uint8Array,
): Promise<{ doc: PrivateDoc; fields: DocFields }> {
  const { type, name, newOid, prevOid, force } = input
  if (type !== 'refUpdate' && type !== 'protectedRefUpdate') throw new MalformedError(`${String(type)} is not a ref update`)
  if (!isOidWidth(newOid.length)) throw new MalformedError('newOid is not 20 or 32 bytes')
  if (prevOid !== undefined && prevOid.length !== newOid.length) throw new MalformedError('prevOid and newOid differ in width')
  if (isNull(newOid) && (prevOid === undefined || isNull(prevOid))) throw new MalformedError('a ref update that names no commit')
  const plainNew = await plaintextOf(salt, newOid)
  const plainPrev = prevOid === undefined ? undefined : await plaintextOf(salt, prevOid)
  if (plainNew === null || plainPrev === null) throw new MalformedError('an OID is not 20 or 32 bytes')
  // a null OID has no real value (TLV 22 / 23 absent)
  const fields: DocFields = {
    refName: name,
    ...(!isNull(newOid) ? { newOid: new Uint8Array(newOid) } : {}),
    ...(prevOid !== undefined && !isNull(prevOid) ? { prevOid: new Uint8Array(prevOid) } : {}),
    oidSalt: new Uint8Array(salt),
  }
  const doc: PrivateDoc = {
    type,
    vis: 'public',
    ownerId,
    epoch,
    refNameHash: new Uint8Array(nameHash),
    newOid: plainNew,
    ...(plainPrev !== undefined ? { prevOid: plainPrev } : {}),
    force,
  }
  return { doc, fields }
}

/** The sealed update of the header `doc` (from {@link refDocAndFields}), its `salt` and its `enc`. */
export function sealedRefOf(doc: PrivateDoc, salt: Uint8Array, enc: Uint8Array): SealedRefUpdate {
  return {
    type: doc.type as RefUpdateType,
    refNameHash: doc.refNameHash as Bytes,
    newOid: doc.newOid as Bytes,
    ...(doc.prevOid !== undefined ? { prevOid: doc.prevOid as Bytes } : {}),
    force: doc.force === true,
    epoch: doc.epoch,
    enc: new Uint8Array(enc),
    salt: new Uint8Array(salt),
  }
}

async function sealRefWith(keys: EpochKeys, ownerId: PrivateId, input: RefUpdateIn, salt: Uint8Array, seal: MembersRefSealer): Promise<SealedRefUpdate> {
  const { doc, fields } = await refDocAndFields(await refNameHash(keys, input.name), keys.epoch, ownerId, input, salt)
  return sealedRefOf(doc, salt, await seal(doc, fields))
}

/**
 * Seal a members-only ref update under the members key's write epoch `keys`, with a fresh salt
 * and a hedged nonce (`sealMembersDoc`). Throws {@link MalformedError} for an update no reader
 * takes (see the refusals above).
 */
export function sealMembersRef(keys: EpochKeys, ownerId: PrivateId, input: RefUpdateIn): Promise<SealedRefUpdate> {
  return sealRefWith(keys, ownerId, input, freshSalt(), (doc, fields) => sealMembersDoc(keys, doc, fields))
}

/**
 * INTERNAL, TEST-ONLY: {@link sealMembersRef} with a caller-chosen salt and sealer (the vectors'
 * fixed nonce). Only `lib/private/testing.ts` may import it; it is not re-exported from `index.ts`.
 */
export function __unsafeSealMembersRefWith(
  keys: EpochKeys,
  ownerId: PrivateId,
  input: RefUpdateIn,
  salt: Uint8Array,
  seal: MembersRefSealer,
): Promise<SealedRefUpdate> {
  return sealRefWith(keys, ownerId, input, salt, seal)
}

/** A members-only ref update as members fold it: its real values. */
export interface RealRefUpdate {
  /** The full ref name, from TLV 3. */
  readonly name: string
  /** The real new tip (all zero for a delete). */
  readonly newOid: Uint8Array
  /** The real previous tip, absent for a create. */
  readonly prevOid?: Uint8Array
  /** Blinds that did not check against their real values (the update is kept). */
  readonly alerts: readonly Alert[]
}

/**
 * The real values of a members-only (`enc` v0x03) ref update whose plaintext is `doc` and whose
 * opened content is `fields`. `null` (malformed) when a non-null plaintext OID has no real value
 * or salt beside it, or a null one carries a real value; a blind that does not check is kept with
 * an alert.
 */
export async function realValues(doc: Pick<PrivateDoc, 'newOid' | 'prevOid'>, fields: DocFields): Promise<RealRefUpdate | null> {
  const name = fields.refName
  if (name === undefined || doc.newOid === undefined) return null
  const alerts: Alert[] = []
  const judge = async (field: OidField, plain: Uint8Array, real: Uint8Array | undefined): Promise<Uint8Array | null> => {
    const c = await check(plain, real, fields.oidSalt)
    if (c === 'malformed') return null
    const alert = alertOf(field, c)
    if (alert !== null) alerts.push(alert)
    return new Uint8Array(real ?? plain)
  }
  const newOid = await judge('newOid', doc.newOid, fields.newOid)
  if (newOid === null) return null
  let prevOid: Uint8Array | undefined
  if (doc.prevOid !== undefined) {
    const p = await judge('prevOid', doc.prevOid, fields.prevOid)
    if (p === null) return null
    prevOid = p
  } else if (fields.prevOid !== undefined) {
    return null
  }
  // one repository, one object format: a writer never mixes widths; and an update names a commit
  // (a create that is also a delete is no writer's)
  if (fields.newOid !== undefined && fields.prevOid !== undefined && fields.newOid.length !== fields.prevOid.length) return null
  if (isNull(newOid) && (prevOid === undefined || isNull(prevOid))) return null
  return { name, newOid, ...(prevOid !== undefined ? { prevOid } : {}), alerts }
}

/** How a reader sees one members-only ref update. */
export type RefOpened =
  | { readonly status: 'readable'; readonly ref: RealRefUpdate }
  | { readonly status: 'unreadable'; readonly reason: UnreadableReason }
  | { readonly status: 'malformed' }

/** A ref update `openContent` gave `opened`, taken to its real values. */
export async function refOpenedFrom(doc: Pick<PrivateDoc, 'newOid' | 'prevOid'>, opened: OpenResult): Promise<RefOpened> {
  if (opened.status !== 'readable') return opened
  const ref = await realValues(doc, opened.fields)
  return ref === null ? { status: 'malformed' } : { status: 'readable', ref }
}

/** Open a members-only ref update (`enc` v0x03) and take its real values. */
export async function openMembersRef(doc: StoredPrivateDoc, ctx: OpenContext): Promise<RefOpened> {
  return refOpenedFrom(doc, await openContent(doc, ctx))
}
