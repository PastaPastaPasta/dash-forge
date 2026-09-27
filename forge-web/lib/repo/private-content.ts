/**
 * Reading a repo's content documents through one gate, public or private
 * (`docs/security/private-repos.md` §8).
 *
 * A {@link ContentGate} admits a raw document with its content fields as plaintext, or says why
 * it is hidden. A public repo's gate is the `isWellFormed` filter. A private repo's gate runs
 * `open_content` (`openContent`) with the reader's keys: a readable document comes back with the
 * decrypted fields set as if they were plaintext (`title`, `body`, `refName`, `path`, …) and
 * `enc` / `epoch` removed, so every fold and view downstream works unchanged. Admitted documents
 * live in memory only: nothing here writes them anywhere.
 *
 * Hidden documents are counted by the three reasons the UI names (`ux-dx-spec.md` §9):
 * "not encrypted for this repo" (plaintext, malformed, or an outsider's bytes), "wrong or missing
 * key" (no key for its epoch, or an epoch with no anchor), and "written after the key was
 * rotated" (the late-content rule, §8.2).
 */

import { decodeIdentifier } from '../auth/base58'
import { openContent, type DocFields, type OpenContext, type PrivateDocType, type StoredPrivateDoc } from '../private'
import type { ContentKind } from '../rules/v2'
import { base64ToBytes, type PlainDocument } from '../sdk'
import { asIdentifierString, num, wellFormed, type RepoRef } from './contract'

/** Why a document is hidden. */
export type HiddenReason = 'notEncrypted' | 'wrongKey' | 'late'

/** Hidden documents, by reason. */
export type HiddenCounts = Readonly<Record<HiddenReason, number>>

const NO_HIDDEN: HiddenCounts = { notEncrypted: 0, wrongKey: 0, late: 0 }

/** The sentence each reason is shown with. */
export const HIDDEN_REASON_TEXT: Readonly<Record<HiddenReason, string>> = {
  notEncrypted: 'not encrypted for this repo',
  wrongKey: 'wrong or missing key',
  late: 'written after the key was rotated',
}

export function totalHidden(h: HiddenCounts): number {
  return h.notEncrypted + h.wrongKey + h.late
}

/** A tally that counts hidden documents while a read runs. */
export class HiddenTally {
  private counts: Record<HiddenReason, number> = { ...NO_HIDDEN }

  add(reason: HiddenReason): void {
    this.counts[reason] += 1
  }

  get value(): HiddenCounts {
    return { ...this.counts }
  }

  get total(): number {
    return totalHidden(this.counts)
  }
}

export type Admission = { readonly ok: true; readonly doc: PlainDocument } | { readonly ok: false; readonly reason: HiddenReason }

/** Admits a repo's content documents (see the module doc). */
export interface ContentGate {
  readonly visibility: RepoRef['visibility']
  admit(type: PrivateDocType, doc: PlainDocument): Promise<Admission>
}

const KIND_OF: Readonly<Record<PrivateDocType, ContentKind>> = {
  issue: 'issue',
  patch: 'patch',
  comment: 'comment',
  review: 'review',
  refUpdate: 'refUpdate',
  protectedRefUpdate: 'refUpdate',
  config: 'config',
}

/** A public repo's gate: well-formed documents, as they are. */
function publicGate(repo: RepoRef): ContentGate {
  return {
    visibility: repo.visibility,
    async admit(type, doc) {
      return wellFormed(repo, KIND_OF[type], doc) ? { ok: true, doc } : { ok: false, reason: 'notEncrypted' }
    },
  }
}

/** A private repo seen without keys (not a member, or no session yet): nothing is admitted. */
export function sealedGate(repo: RepoRef): ContentGate {
  return {
    visibility: repo.visibility,
    async admit(type, doc) {
      return { ok: false, reason: wellFormed(repo, KIND_OF[type], doc) ? 'wrongKey' : 'notEncrypted' }
    },
  }
}

/** The gate a read uses when the caller gave none. */
export function defaultGate(repo: RepoRef): ContentGate {
  return repo.visibility === 'private' ? sealedGate(repo) : publicGate(repo)
}

/** A byteArray field (base64 from `toJSON`, or raw bytes), or undefined when absent. */
export function bytesField(doc: PlainDocument, field: string): Uint8Array | undefined {
  const v = doc[field]
  if (v instanceof Uint8Array) return v
  if (typeof v === 'string' && v.length > 0) {
    try {
      return base64ToBytes(v)
    } catch {
      return undefined
    }
  }
  return undefined
}

/** An identifier field (base58 or base64) as its 32 raw bytes, or undefined. */
export function idField(doc: PlainDocument, field: string): Uint8Array | undefined {
  const s = asIdentifierString(doc[field])
  if (s === '') return undefined
  try {
    const b = decodeIdentifier(s)
    return b.length === 32 ? b : undefined
  } catch {
    return undefined
  }
}

/** `$createdAtBlockHeight` as a number, or undefined. */
export function blockHeightOf(doc: PlainDocument): number | undefined {
  const v = doc['$createdAtBlockHeight']
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
  return undefined
}

/**
 * The {@link StoredPrivateDoc} of a raw document of `type`: its plaintext bind fields as bytes.
 * Null when a field the AD needs cannot be decoded (the caller treats that as malformed).
 */
function storedPrivateDoc(type: PrivateDocType, doc: PlainDocument): StoredPrivateDoc | null {
  const ownerId = idField(doc, '$ownerId')
  const id = idField(doc, '$id')
  const enc = bytesField(doc, 'enc')
  if (ownerId === undefined || enc === undefined || doc['epoch'] == null) return null
  const base = { type, ownerId, epoch: num(doc, 'epoch'), id, createdAtBlockHeight: blockHeightOf(doc), enc }
  switch (type) {
    case 'issue':
    case 'patch':
      return {
        ...base,
        number: num(doc, 'number'),
        ...(type === 'patch'
          ? { baseRefNameHash: bytesField(doc, 'baseRefNameHash'), sourceRefNameHash: bytesField(doc, 'sourceRefNameHash') }
          : {}),
      }
    case 'comment': {
      const targetId = idField(doc, 'targetId')
      return targetId === undefined ? null : { ...base, targetId }
    }
    case 'review': {
      const patchId = idField(doc, 'patchId')
      return patchId === undefined ? null : { ...base, patchId }
    }
    case 'refUpdate':
    case 'protectedRefUpdate':
      return {
        ...base,
        refNameHash: bytesField(doc, 'refNameHash'),
        newOid: bytesField(doc, 'newOid') ?? new Uint8Array(0),
        prevOid: bytesField(doc, 'prevOid'),
        force: doc['force'] === true,
      }
    case 'config':
      return base
  }
}

/** The plaintext-shaped copy of an opened document: `enc` and `epoch` dropped, fields set. */
function asPlaintext(doc: PlainDocument, fields: DocFields): PlainDocument {
  const out: PlainDocument = { ...doc }
  delete out['enc']
  delete out['epoch']
  for (const [k, v] of Object.entries(fields) as [string, unknown][]) {
    if (v === undefined || k === 'prevEpochKey' || k === 'prevEpoch') continue
    out[k] = v
  }
  return out
}

/**
 * A private repo's gate over the reader's {@link OpenContext} (`resolveEpochs` →
 * `openContextOf`): §8.1 in order, then the decrypted fields as plaintext.
 */
export function privateGate(repo: RepoRef, ctx: OpenContext): ContentGate {
  return {
    visibility: repo.visibility,
    async admit(type, doc) {
      if (!wellFormed(repo, KIND_OF[type], doc)) return { ok: false, reason: 'notEncrypted' }
      const stored = storedPrivateDoc(type, doc)
      if (stored === null) return { ok: false, reason: 'notEncrypted' }
      const opened = await openContent(stored, ctx)
      if (opened.status === 'readable') {
        // An anchor's prevEpochKey is an older epoch's raw key: never kept past the open.
        opened.fields.prevEpochKey?.fill(0)
        return { ok: true, doc: asPlaintext(doc, opened.fields) }
      }
      if (opened.status === 'malformed') return { ok: false, reason: 'notEncrypted' }
      switch (opened.reason) {
        case 'late':
          return { ok: false, reason: 'late' }
        case 'badTag':
          return { ok: false, reason: 'notEncrypted' }
        default:
          return { ok: false, reason: 'wrongKey' }
      }
    },
  }
}

/** Admit every document of `docs`, in order: the admitted ones and the hidden tally. */
export async function admitAll(
  gate: ContentGate,
  type: PrivateDocType,
  docs: readonly PlainDocument[],
  tally: HiddenTally = new HiddenTally(),
): Promise<{ docs: PlainDocument[]; hidden: HiddenTally }> {
  const out: PlainDocument[] = []
  for (const d of docs) {
    const a = await gate.admit(type, d)
    if (a.ok) out.push(a.doc)
    else tally.add(a.reason)
  }
  return { docs: out, hidden: tally }
}

/** The gate a read of `repo` goes through: its session's for a member, else {@link defaultGate}. */
export function gateFor(repo: RepoRef): ContentGate {
  return repo.session?.gate ?? defaultGate(repo)
}
