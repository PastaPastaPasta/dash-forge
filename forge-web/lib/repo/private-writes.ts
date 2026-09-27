/**
 * Sealed writes to a private repo (`docs/security/private-repos.md` §4, §5.3, §8): the content
 * fields of an `issue`, `patch`, `comment`, `review`, `refUpdate` / `protectedRefUpdate` go
 * into `enc` under the current write epoch; their bind fields stay plaintext; ref names become
 * keyed hashes. Every seal reads the anchors fresh (§5.3: a writer never seals under an epoch
 * it last saw minutes ago), so a rotation that just happened is honoured.
 *
 * The plaintext writers (`writes.ts`, `review-writes.ts`, `push.ts`) call {@link sealForRepo}
 * for a private repo; nothing in the UI seals on its own.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { decodeIdentifier } from '../auth/base58'
import { encryptionOps } from '../auth/encryption-key'
import { idbGet, idbPut } from '../idb'
import { EpochKeys, TooLargeError, openPack, refNameHash, sealDoc, sealPack, type DocFields, type PrivateDoc, type PrivateDocType } from '../private'
import type { WriteAuth } from '../sdk'
import type { RepoRef } from './contract'
import { loadPrivateSessionUncached, sessionUnwrapper } from './private-session'

/** The content fields each sealed type moves into `enc` (`private-repos.md` §4.3). */
const SEALED_FIELDS: Readonly<Record<PrivateDocType, readonly (keyof DocFields)[]>> = {
  issue: ['title', 'body'],
  patch: ['title', 'body', 'baseRefName', 'sourceRefName'],
  comment: ['body', 'path'],
  review: ['body'],
  refUpdate: ['refName'],
  protectedRefUpdate: ['refName'],
  config: ['defaultBranch', 'protectedPatterns'],
}

/** Why a private write cannot go ahead (shown as is). */
export class PrivateWriteError extends Error {
  constructor(
    message: string,
    readonly code = 'E310',
  ) {
    super(message)
    this.name = 'PrivateWriteError'
  }
}

/**
 * The epoch and keys a new private document is sealed under: the current write epoch of a
 * fresh session of the signer (the page's session may be minutes old, §5.3), or `epoch`.
 */
async function writeKeys(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, epoch?: number): Promise<EpochKeys> {
  const ops = await encryptionOps(sdk, auth.network, auth.identityId, repo.forge.core)
  if (ops === null) throw new PrivateWriteError('add your encryption key to this browser (Settings → Keys) to write to a private repo', 'E306')
  const { session: _page, ...plain } = repo
  void _page
  const s = await loadPrivateSessionUncached(sdk, plain, auth.network, auth.identityId, sessionUnwrapper(ops))
  try {
    const r = s.resolution
    const e = epoch ?? r.writeEpoch
    if (e === null || e === undefined) {
      if (r.currentEpoch !== null && r.burned.has(r.currentEpoch)) {
        throw new PrivateWriteError(`key epoch ${r.currentEpoch} is closed; a maintainer must run Repair before anything new is written`)
      }
      if (r.repair !== null && r.repair.nonMembers.length > 0) {
        throw new PrivateWriteError('the current key reached someone who is no longer a member; a maintainer must run Repair (it rotates the key) before anything new is written')
      }
      throw new PrivateWriteError("you can't read this repo's current key, so you can't write to it yet; ask a maintainer to run Repair", 'E307')
    }
    const keys = r.keys.get(e)
    if (keys === undefined) throw new PrivateWriteError(`you can't read key epoch ${e} of this repo`, 'E307')
    return keys
  } finally {
    s.close()
  }
}

/**
 * The combined plaintext cap of each sealed type (`private-repos.md` §4.3): title + body for an
 * issue or PR (their ref names too), body + path for a comment, the body of a review. Checked
 * before sealing, so the writer says so instead of failing inside the seal.
 */
export const SEALED_TEXT_LIMIT: Readonly<Partial<Record<PrivateDocType, number>>> = { issue: 5085, patch: 5085, comment: 5085, review: 5088 }

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
 * Seal `data` (the plaintext document a public writer would post) for the private `repo`: its
 * content fields go into `enc` under the current write epoch (or `epoch`: a PR edit keeps its
 * epoch, §4.5), `epoch` is set, ref names become keyed hashes. Returns the document data to
 * post. `ownerId` is the signer (bound into the AD).
 */
export async function sealForRepo(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  type: PrivateDocType,
  data: Data,
  epoch?: number,
): Promise<Data> {
  if (repo.visibility !== 'private') return data
  const limit = SEALED_TEXT_LIMIT[type]
  if (limit !== undefined) {
    const used = SEALED_FIELDS[type].reduce((n, f) => n + (typeof data[f] === 'string' ? new TextEncoder().encode(data[f] as string).length : 0), 0)
    if (used > limit) throw new PrivateWriteError(`the text is too long for a private repo: an encrypted ${type} holds at most ${limit} bytes (this one has ${used})`, '')
  }
  const keys = await writeKeys(sdk, auth, repo, epoch)
  const out: Data = { ...data }
  const fields: Record<string, unknown> = {}
  for (const f of SEALED_FIELDS[type]) {
    const v = out[f]
    delete out[f]
    if (v === undefined || v === null || v === '') continue
    fields[f] = v
  }
  const doc: { -readonly [K in keyof PrivateDoc]: PrivateDoc[K] } = { type, ownerId: decodeIdentifier(auth.identityId), epoch: keys.epoch }
  switch (type) {
    case 'issue':
    case 'patch':
      doc.number = out['number'] as number
      if (type === 'patch') {
        // The ref-name hashes are HMACs under the patch's epoch (§4.5), never sha256.
        doc.baseRefNameHash = await refNameHash(keys, fields['baseRefName'] as string)
        doc.sourceRefNameHash = await refNameHash(keys, fields['sourceRefName'] as string)
        out['baseRefNameHash'] = doc.baseRefNameHash
        out['sourceRefNameHash'] = doc.sourceRefNameHash
      }
      break
    case 'comment':
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
  try {
    out['enc'] = await sealDoc(keys, doc, fields as DocFields)
  } catch (e) {
    if (e instanceof TooLargeError) {
      throw new PrivateWriteError(`the text is too long for a private repo: its encrypted ${type} holds at most ${e.limit} bytes`, '')
    }
    throw e
  }
  out['epoch'] = keys.epoch
  return out
}

/**
 * The fields an edit (a replace) of a private document changes: its content re-sealed as a
 * whole. `current` is the document's decrypted content (the edit replaces some of it), `bind`
 * its plaintext bind fields. A patch keeps its epoch (§4.5); issues and comments re-seal under
 * the current epoch.
 */
export async function sealEdit(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  type: 'issue' | 'patch' | 'comment',
  bind: Data,
  current: Readonly<Record<string, unknown>>,
  changes: Readonly<Record<string, unknown>>,
  epoch?: number,
): Promise<Data> {
  const merged: Data = { ...bind }
  for (const f of SEALED_FIELDS[type]) {
    const v = f in changes ? changes[f] : current[f]
    if (v !== undefined && v !== null && v !== '') merged[f] = v
  }
  const sealed = await sealForRepo(sdk, auth, repo, type, merged, type === 'patch' ? epoch : undefined)
  const out: Data = { enc: sealed['enc'], epoch: sealed['epoch'] }
  return out
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
  const keys = await writeKeys(sdk, auth, repo)
  const cacheKey = `sealed-pack:${auth.network}:${repo.repoId}:${await sha256Hex(plain)}`
  const cached = await idbGet<Uint8Array>('journal', cacheKey)
  if (cached instanceof Uint8Array) {
    const opened = await openPack(cached, cached.length, new Map([[keys.epoch, keys]])).catch(() => null)
    if (opened !== null && sameBytes(opened, plain)) return cached
  }
  const sealed = await sealPack(keys, plain)
  await idbPut('journal', cacheKey, sealed).catch(() => undefined)
  return sealed
}
