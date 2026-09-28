/**
 * Sealed writes to a private repo (`docs/security/private-repos.md` §4, §5.3, §8): the content
 * fields of an `issue`, `patch`, `comment`, `review`, `refUpdate` / `protectedRefUpdate`, and
 * an `event`'s `value`, go into `enc` under the current write epoch; their bind fields stay
 * plaintext; ref names become keyed hashes. Every seal reads the anchors fresh (§5.3: a writer
 * never seals under an epoch it last saw minutes ago), so a rotation that just happened is
 * honoured.
 *
 * Callers: `writeRepoDoc` (`writes.ts`; `review-writes.ts` goes through it), `writeRefUpdate`
 * (`push.ts`), and `storeAndRecordPack` via {@link sealArtifact} (`storage/index.ts`). Each
 * user action resolves one {@link PrivateWriter} (one fresh session) and seals every document
 * of the action under it. {@link sealEdit} is for the issue / PR / comment edit screens (not
 * wired yet: a private edit is refused until they call it). Nothing in the UI seals on its own.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { decodeIdentifier } from '../auth/base58'
import { encryptionOps } from '../auth/encryption-key'
import { idbDelete, idbEntries, idbGet, idbPut } from '../idb'
import { EpochKeys, MalformedError, TooLargeError, type EpochResolution, openPack, propOf, refNameHash, sealDoc, sealPack, type DocFields, type PrivateDoc, type PrivateDocType } from '../private'
import type { WriteAuth } from '../sdk'
import type { RepoRef } from './contract'
import { loadPrivateSessionUncached, sessionUnwrapper, type PrivateSession } from './private-session'

/** The content fields each sealed type moves into `enc` (`private-repos.md` §4.3). */
const SEALED_FIELDS: Readonly<Record<PrivateDocType, readonly (keyof DocFields)[]>> = {
  issue: ['title', 'body'],
  patch: ['title', 'body', 'baseRefName', 'sourceRefName'],
  comment: ['body', 'path'],
  review: ['body'],
  refUpdate: ['refName'],
  protectedRefUpdate: ['refName'],
  config: ['defaultBranch', 'protectedPatterns'],
  event: ['eventValue'],
}

/**
 * Why nothing can be written under `r`'s current epoch (§5.3, §5.6), or null when the write
 * epoch is set: a burned epoch, the current key held by a non-member, or a key this reader lacks.
 */
export function writeBlockReason(r: EpochResolution): string | null {
  if (r.writeEpoch !== null) return null
  if (r.currentEpoch !== null && r.burned.has(r.currentEpoch)) return `Key epoch ${r.currentEpoch} is closed; nothing can be written until a maintainer rotates the key (Repair).`
  if (r.repair !== null && r.repair.nonMembers.length > 0) return 'The current key reached someone who is no longer a member; nothing can be written until a maintainer runs Repair.'
  return "You don't have this repo's current key yet, so you can't write to it; a maintainer can repair it."
}

/** Why a private write cannot go ahead (shown as is). `code`: the CLI's code for the same case, if any. */
export class PrivateWriteError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'PrivateWriteError'
  }
}

/**
 * What one user action seals under (§5.3): the current write epoch of a fresh session of the
 * signer, read once for the action (the page's session may be minutes old; a review with its
 * comments shares one), and that session's decrypted config (protected-ref routing).
 */
export interface PrivateWriter {
  readonly keys: EpochKeys
  readonly protectedPatterns: readonly string[]
}

/**
 * The intent of a sealed write under `keys`: the action's intent plus the epoch and a tag of the
 * key. The write engine replays a cached signed write per intent (for up to a day); a retry
 * after a rotation must sign afresh under the new key, never re-broadcast bytes sealed under a
 * key a removed member holds (§5.5; as the key-rotation writes do).
 */
export function sealedIntent(intent: string | undefined, keys: EpochKeys): string | undefined {
  if (intent === undefined) return undefined
  const tag = [...keys.commit.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${intent}:e${keys.epoch}:${tag}`
}

/** A fresh session of the signer for `repo` (never the page's). The caller closes it. */
async function freshSession(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef): Promise<PrivateSession> {
  const ops = await encryptionOps(sdk, auth.network, auth.identityId, repo.forge.core)
  if (ops === null) throw new PrivateWriteError('add your encryption key to this browser (Settings → Keys) to write to a private repo', 'E306')
  const { session: _page, ...plain } = repo
  void _page
  return loadPrivateSessionUncached(sdk, plain, auth.network, auth.identityId, sessionUnwrapper(ops))
}

/**
 * The {@link PrivateWriter} of one action on the private `repo`: refused (nothing written) when
 * the current epoch cannot be written under ({@link writeBlockReason}).
 */
export async function privateWriter(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef): Promise<PrivateWriter> {
  const { writer, session } = await privateWriterWithSession(sdk, auth, repo)
  session.close()
  return writer
}

/**
 * {@link privateWriter}, keeping its fresh session open for reads the action compares against
 * what it writes (a review submit's reconcile opens content under the epoch it seals with).
 * The caller closes the session.
 */
export async function privateWriterWithSession(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef): Promise<{ writer: PrivateWriter; session: PrivateSession }> {
  const s = await freshSession(sdk, auth, repo)
  const r = s.resolution
  const keys = r.writeEpoch === null ? undefined : r.keys.get(r.writeEpoch)
  if (keys === undefined) {
    s.close()
    throw new PrivateWriteError(writeBlockReason(r) as string, r.currentEpoch !== null && !r.keys.has(r.currentEpoch) ? 'E307' : 'E310')
  }
  return { writer: { keys, protectedPatterns: s.config?.protectedPatterns ?? [] }, session: s }
}

/** The keys of the patch's own epoch `epoch` (a PR edit keeps its epoch, §4.5): readable, anchored, not burned. */
async function patchEpochKeys(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, epoch: number): Promise<EpochKeys> {
  const s = await freshSession(sdk, auth, repo)
  try {
    const r = s.resolution
    const keys = r.keys.get(epoch)
    if (keys === undefined) throw new PrivateWriteError(`you can't read key epoch ${epoch} of this repo`, 'E307')
    if (r.burned.has(epoch)) throw new PrivateWriteError(`key epoch ${epoch} is closed; this PR can't be edited`, 'E310')
    return keys
  } finally {
    s.close()
  }
}

/**
 * The combined text cap of each sealed type: the largest TLV (the `enc` cap less its 29-byte
 * frame, `maxPlaintext`) less 3 bytes of framing per text field the type carries (§4.3):
 * title + body of an issue (5085), title + body + both branch names of a PR (5079), body + path
 * of a comment (5085), the body of a review (5088). Checked before sealing, so the writer says
 * so (and writes nothing) instead of failing inside the seal.
 */
export const SEALED_TEXT_LIMIT = { issue: 5085, patch: 5079, comment: 5085, review: 5088 } as const

/** The sealed types a user writes text into. */
export type SealedKind = keyof typeof SEALED_TEXT_LIMIT

/** Whether `type` is a {@link SealedKind}. */
export function isSealedKind(type: string): type is SealedKind {
  return Object.hasOwn(SEALED_TEXT_LIMIT, type)
}

/** Plaintext fields (`data`) with bytes or base58 ids, as the writers build them. */
type Data = Record<string, unknown>

function bytesOf(v: unknown): Uint8Array | undefined {
  if (v instanceof Uint8Array) return v
  return undefined
}

function idOf(v: unknown): Uint8Array | undefined {
  if (v instanceof Uint8Array) return v
  if (typeof v === 'string' && v !== '') return decodeIdentifier(v)
  return undefined
}

/**
 * The text bytes `data` puts into a sealed `type` (`used`, over `fields` non-empty text
 * fields), and that type's limit (null for none).
 */
export function sealedTextUse(
  type: PrivateDocType,
  data: Readonly<Record<string, unknown>>,
): { used: number; fields: number; limit: number | null; props: readonly string[] } {
  const props = SEALED_FIELDS[type].map(propOf)
  const present = props.filter((p) => typeof data[p] === 'string' && data[p] !== '')
  const used = present.reduce((n, p) => n + new TextEncoder().encode(data[p] as string).length, 0)
  return { used, fields: present.length, limit: isSealedKind(type) ? SEALED_TEXT_LIMIT[type] : null, props }
}

/**
 * Seal `data` (the plaintext document a public writer would post) for the private `repo`: its
 * content fields go into `enc` under the action's `writer` (resolved here when not given), or
 * under `keys` (a PR edit's own epoch), `epoch` is set, ref names become keyed hashes. The
 * signer (`auth`) is bound into the AD. Returns the document data to post.
 */
export async function sealForRepo(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  type: PrivateDocType,
  data: Data,
  writer?: PrivateWriter | { readonly keys: EpochKeys },
): Promise<Data> {
  if (repo.visibility !== 'private') return data
  const { used, limit } = sealedTextUse(type, data)
  if (limit !== null && used > limit) {
    throw new PrivateWriteError(`the text is too long for a private repo: an encrypted ${type} holds at most ${limit} bytes of text (this one has ${used})`)
  }
  const keys = (writer ?? (await privateWriter(sdk, auth, repo))).keys
  try {
    return await sealContent(keys, type, decodeIdentifier(auth.identityId), data)
  } catch (e) {
    if (e instanceof TooLargeError) throw new PrivateWriteError(`the text is too long for a private repo's encrypted ${type}`)
    if (e instanceof MalformedError) throw new PrivateWriteError(`this ${type} can't be written to a private repo: ${e.message}`)
    throw e
  }
}

/** Seals a document's TLV under `keys` (`sealDoc`; the conformance runner passes a fixed-nonce one). */
export type DocSealer = (keys: EpochKeys, doc: PrivateDoc, fields: DocFields) => Promise<Uint8Array>

/**
 * The sealed document of `data` under `keys`, signed by `ownerId` (pure: the transform the CLI's
 * `collab::private::seal_props` makes, pinned by the shared `private_collab_seal` vectors): the
 * sealed fields leave the plaintext for `enc`, an importer's `imported.author` / `imported.url`
 * become TLV 13 / 14 (`createdAt` stays), ref names become keyed hashes, `epoch` is set. Throws
 * `TooLargeError` / `MalformedError` from the seal.
 */
export async function sealContent(keys: EpochKeys, type: PrivateDocType, ownerId: Uint8Array, data: Data, seal: DocSealer = sealDoc): Promise<Data> {
  const out: Data = { ...data }
  const fields: Record<string, unknown> = {}
  for (const f of SEALED_FIELDS[type]) {
    const prop = propOf(f)
    const v = out[prop]
    delete out[prop]
    if (v === undefined || v === null || v === '') continue
    fields[f] = v
  }
  // An importer's provenance names the source org, repo and people: sealed, but for createdAt.
  const imported = out['imported']
  if (imported !== null && typeof imported === 'object' && !(imported instanceof Uint8Array) && !Array.isArray(imported)) {
    const kept: Data = {}
    for (const [k, v] of Object.entries(imported as Data)) {
      if (k === 'author') fields['importedAuthor'] = String(v)
      else if (k === 'url') fields['importedUrl'] = String(v)
      else kept[k] = v
    }
    out['imported'] = kept
  }
  const doc: { -readonly [K in keyof PrivateDoc]: PrivateDoc[K] } = { type, ownerId, epoch: keys.epoch }
  switch (type) {
    case 'issue':
    case 'patch':
      doc.number = out['number'] as number
      if (type === 'patch') {
        // The ref-name hashes are HMACs under the patch's epoch (§4.5), never sha256.
        doc.baseRefNameHash = await refNameHash(keys, fields['baseRefName'] as string)
        out['baseRefNameHash'] = doc.baseRefNameHash
        if (typeof fields['sourceRefName'] === 'string') {
          doc.sourceRefNameHash = await refNameHash(keys, fields['sourceRefName'])
          out['sourceRefNameHash'] = doc.sourceRefNameHash
        } else {
          delete out['sourceRefNameHash']
        }
      }
      break
    case 'comment':
    case 'event':
      doc.targetId = idOf(out['targetId'])
      break
    case 'review':
      doc.patchId = idOf(out['patchId'])
      break
    case 'refUpdate':
    case 'protectedRefUpdate': {
      doc.refNameHash = await refNameHash(keys, fields['refName'] as string)
      out['refNameHash'] = doc.refNameHash
      doc.newOid = bytesOf(out['newOid'])
      doc.prevOid = bytesOf(out['prevOid'])
      doc.force = out['force'] === true
      break
    }
    case 'config':
      throw new PrivateWriteError('a private config is written by the key rotation, not here')
  }
  out['enc'] = await seal(keys, doc, fields as DocFields)
  out['epoch'] = keys.epoch
  return out
}

/**
 * For the edit screens (not wired yet): the `enc` / `epoch` a replace of a private issue, PR or
 * comment posts, its content re-sealed as a whole (`current`: the decrypted content, `changes`:
 * what the edit sets, `bind`: the plaintext bind fields). Issues and comments re-seal under the
 * current write epoch; a PR keeps its own epoch `patchEpoch` (§4.5), which must still be
 * readable and not burned.
 */
/**
 * The plaintext a private edit re-seals: the bind fields, every sealed field as the edit leaves
 * it (unchanged ones from `current`), and an imported document's provenance (`imported`: its
 * author and URL are sealed too, TLV 13 / 14, and a replace that left them out would drop them).
 */
export function editFields(
  type: 'issue' | 'patch' | 'comment',
  bind: Data,
  current: Readonly<Record<string, unknown>>,
  changes: Readonly<Record<string, unknown>>,
  imported?: Readonly<Record<string, unknown>> | null,
): Data {
  const merged: Data = { ...bind }
  for (const f of SEALED_FIELDS[type]) {
    const v = f in changes ? changes[f] : current[f]
    if (v !== undefined && v !== null && v !== '') merged[f] = v
  }
  if (imported !== undefined && imported !== null) merged['imported'] = { ...imported }
  return merged
}

export async function sealEdit(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  type: 'issue' | 'patch' | 'comment',
  bind: Data,
  current: Readonly<Record<string, unknown>>,
  changes: Readonly<Record<string, unknown>>,
  patchEpoch?: number,
  imported?: Readonly<Record<string, unknown>> | null,
): Promise<Data> {
  const merged = editFields(type, bind, current, changes, imported)
  let writer: { readonly keys: EpochKeys } | undefined
  if (type === 'patch') {
    if (patchEpoch === undefined) throw new PrivateWriteError("a PR edit re-seals under the PR's own epoch: pass it")
    writer = { keys: await patchEpochKeys(sdk, auth, repo, patchEpoch) }
  }
  const sealed = await sealForRepo(sdk, auth, repo, type, merged, writer)
  return { enc: sealed['enc'], epoch: sealed['epoch'] }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/**
 * The bytes a private repo stores for the artifact `plain` (§3): sealed under the current write
 * epoch. A seal draws a fresh file id, so re-sealing a retried upload would change `packHash`
 * and orphan the chunks and manifest already stored; the sealed bytes (ciphertext only) are
 * kept in this browser per (repo, plaintext hash) and reused only while they open under the
 * current write key and hash back to `plain` (parity: git-remote-dash `seal_for_push`). A
 * public repo's bytes are returned as they are.
 */
export async function sealArtifact(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, plain: Uint8Array): Promise<Uint8Array> {
  if (repo.visibility !== 'private') return plain
  const { keys } = await privateWriter(sdk, auth, repo)
  await pruneSealedArtifacts()
  const cacheKey = sealedKey(auth, repo, await plainTag(keys, plain))
  const cached = await idbGet<CachedSeal>('journal', cacheKey)
  if (cached !== undefined && cached.bytes instanceof Uint8Array) {
    const opened = await openPack(cached.bytes, cached.bytes.length, new Map([[keys.epoch, keys]])).catch(() => null)
    const same = opened !== null && sameBytes(opened, plain)
    opened?.fill(0)
    if (same) return cached.bytes
  }
  const sealed = await sealPack(keys, plain)
  await idbPut<CachedSeal>('journal', cacheKey, { bytes: sealed, at: Date.now() }).catch(() => undefined)
  return sealed
}

/** A kept sealed artifact (ciphertext only) and when it was sealed. */
interface CachedSeal {
  readonly bytes: Uint8Array
  readonly at: number
}

const SEALED_PREFIX = 'sealed-pack:'
/** A kept seal older than this is dropped (an upload that long ago will not be resumed). */
const SEALED_MAX_AGE_MS = 7 * 24 * 3600_000

function sealedKey(auth: WriteAuth, repo: RepoRef, plainHash: string): string {
  return `${SEALED_PREFIX}${auth.network}:${repo.repoId}:${plainHash}`
}

/**
 * Forget the kept seal of `plain` once its manifest is recorded (the upload is done; a later
 * upload of the same bytes is a new one).
 */
export async function forgetSealedArtifact(auth: WriteAuth, repo: RepoRef, sealed: Uint8Array): Promise<void> {
  if (repo.visibility !== 'private') return
  const rows = await idbEntries<CachedSeal>('journal', `${SEALED_PREFIX}${auth.network}:${repo.repoId}:`).catch(() => [] as [string, CachedSeal][])
  for (const [k, v] of rows) if (v?.bytes instanceof Uint8Array && sameBytes(v.bytes, sealed)) await idbDelete('journal', k).catch(() => undefined)
}

/**
 * The cache tag of a plaintext artifact: keyed (the epoch's ref-name key), so this browser's
 * storage never holds a plain hash of a private pack (a content-equality oracle, §3.4).
 */
async function plainTag(keys: EpochKeys, plain: Uint8Array): Promise<string> {
  const h = await refNameHash(keys, `sealed-artifact:${await sha256Hex(plain)}`)
  return `e${keys.epoch}:${[...h].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

let pruned = false

/** Drop kept seals older than {@link SEALED_MAX_AGE_MS} (once per page load). */
async function pruneSealedArtifacts(now = Date.now()): Promise<void> {
  if (pruned) return
  pruned = true
  const rows = await idbEntries<CachedSeal>('journal', SEALED_PREFIX).catch(() => [] as [string, CachedSeal][])
  for (const [k, v] of rows) if (typeof v?.at !== 'number' || now - v.at > SEALED_MAX_AGE_MS) await idbDelete('journal', k).catch(() => undefined)
}
