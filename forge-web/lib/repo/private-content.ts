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
 * Hidden documents are counted by the reasons the UI names (`ux-dx-spec.md` §9): "not encrypted
 * for this repo" (plaintext, malformed, or an outsider's bytes), "wrong or missing key" (no key
 * for its epoch, or an epoch with no anchor), "written after the key was rotated" (the
 * late-content rule, §8.2), and in a public repo "members-only" and "for specific people".
 *
 * A public repo holds plaintext and members-only documents side by side (DESIGN §4.1): reads are
 * **per document**. A plaintext one passes through; a sealed one opens through the reader's
 * members-key session (`repo.lane`, {@link laneGate}) or comes back as a {@link MembersOnlyItem}
 * placeholder, never as an error. A members-key session is never a private session: it never
 * stands in for the repo's public config, refs or packs (those read `repo.session` only).
 */

import { decodeIdentifier } from '../auth/base58'
import { openContent, openVis, propOf, type DocFields, type OpenContext, type PrivateDocType, type StoredPrivateDoc, type UnreadableReason } from '../private'
import { ENC_SPECIFIC_PEOPLE, type Audience, type ContentKind, type Visibility } from '../rules/v2'
import { base64ToBytes, type PlainDocument } from '../sdk'
import { asIdentifierString, num, wellFormed, type RepoRef } from './contract'
import { noteMembersKey } from './members-key-cache'

/**
 * Why a document is hidden. `membersOnly`: a members-only document of a public repo this reader
 * holds no key for; `letter`: a specific-people document (`enc` v0x04), opened only by its
 * recipients (not in this release); `unknownVersion`: encrypted in a format a later version of
 * Forge writes (`enc` v0x05 on), never opened here.
 */
export type HiddenReason = 'notEncrypted' | 'wrongKey' | 'late' | 'lateEdit' | 'membersOnly' | 'letter' | 'unknownVersion'

/** Hidden documents, by reason. */
export type HiddenCounts = Readonly<Record<HiddenReason, number>>

const NO_HIDDEN: HiddenCounts = { notEncrypted: 0, wrongKey: 0, late: 0, lateEdit: 0, membersOnly: 0, letter: 0, unknownVersion: 0 }

/** The sentence each reason is shown with. */
export const HIDDEN_REASON_TEXT: Readonly<Record<HiddenReason, string>> = {
  notEncrypted: 'not encrypted for this repo',
  wrongKey: 'wrong or missing key',
  late: 'written after the key was rotated',
  lateEdit: 'edited after its author was removed; the original text is gone',
  membersOnly: 'members-only',
  letter: 'for specific people',
  unknownVersion: 'written by a newer version of Forge',
}

export function totalHidden(h: HiddenCounts): number {
  return (Object.values(h) as number[]).reduce((a, b) => a + b, 0)
}

/**
 * Why this reader cannot open a sealed document (forge-core `Unopened`): `noKey`, it holds no
 * members key of this repo here (not a member, not unlocked, or not shared with yet: the page's
 * members access says which); `notReadable`, it holds keys of this repo but not one this document
 * opens with (written after their removal, or late); `notForThisRepo`, it fails this repo's key
 * checks (forged, relabelled or moved: the commitment or the tag); `letter`, it is for specific
 * people.
 */
export type Unopened = 'noKey' | 'notReadable' | 'notForThisRepo' | 'letter'

/**
 * A sealed document of a public repo this reader cannot open, as DESIGN D14 shows it: who wrote
 * it, when and where, never what. Every field is plaintext of the stored document.
 */
export interface MembersOnlyItem {
  readonly type: PrivateDocType
  /** `$id`. */
  readonly id: string
  /** `$ownerId`. */
  readonly author: string
  /** `$createdAt` (ms). */
  readonly createdAt: number
  /** It carries `asMember`: consensus proved its writer a member when it was written. */
  readonly asMember: boolean
  /** An issue's or PR's number (public anyway: numbers are dense). */
  readonly number: number | null
  /** A comment's `replyTo` (thread placement), when it has one. */
  readonly replyTo: string | null
  readonly audience: Exclude<Audience, 'public'>
  readonly why: Unopened
}

/**
 * Whether a placeholder is shown (DESIGN D14): when it carries `asMember` or is the thread's root
 * (an issue or PR, which always gets a row); otherwise it is hidden and only counted.
 */
export function placeholderShown(p: MembersOnlyItem): boolean {
  return p.asMember || p.type === 'issue' || p.type === 'patch'
}

/** A tally that counts hidden documents (and keeps their placeholders) while a read runs. */
export class HiddenTally {
  private counts: Record<HiddenReason, number> = { ...NO_HIDDEN }
  private items: MembersOnlyItem[] = []

  add(reason: HiddenReason, placeholder?: MembersOnlyItem): void {
    this.counts[reason] += 1
    if (placeholder !== undefined) this.items.push(placeholder)
  }

  get value(): HiddenCounts {
    return { ...this.counts }
  }

  get total(): number {
    return totalHidden(this.counts)
  }

  /** The placeholders of the sealed documents counted, in read order. */
  get placeholders(): readonly MembersOnlyItem[] {
    return [...this.items]
  }
}

export type Admission =
  | { readonly ok: true; readonly doc: PlainDocument }
  | { readonly ok: false; readonly reason: HiddenReason; readonly placeholder?: MembersOnlyItem }

/** Admits a repo's content documents (see the module doc). */
export interface ContentGate {
  readonly visibility: RepoRef['visibility']
  admit(type: PrivateDocType, doc: PlainDocument): Promise<Admission>
}

/** The rules' content kind of each sealed type; an `event` has none ({@link readableEvents}). */
const KIND_OF: Readonly<Record<Exclude<PrivateDocType, 'event'>, ContentKind>> = {
  issue: 'issue',
  patch: 'patch',
  comment: 'comment',
  review: 'review',
  refUpdate: 'refUpdate',
  protectedRefUpdate: 'refUpdate',
  config: 'config',
}

/** Whether `doc` is well formed for `repo` as a `type` (an event's shape is checked by its reader). */
function wellFormedAs(repo: RepoRef, type: PrivateDocType, doc: PlainDocument): boolean {
  return type === 'event' || wellFormed(repo, KIND_OF[type], doc)
}

/** Whether a raw document carries a non-empty `enc` (the per-document switch, DESIGN §4.1). */
export function isSealedDoc(doc: PlainDocument): boolean {
  return (bytesField(doc, 'enc')?.length ?? 0) > 0
}

/**
 * What a specific-people document (`enc` v0x04) is called where it can't be opened: neutral,
 * since it is not members-only and its recipients are not public.
 */
export const LETTER_TITLE = 'Encrypted for specific people'

/** The audience a raw document was written for (its `enc`, never the repo's visibility). */
export function docAudience(doc: PlainDocument): Audience {
  const enc = bytesField(doc, 'enc')
  if (enc === undefined || enc.length === 0) return 'public'
  return enc[0] === ENC_SPECIFIC_PEOPLE ? 'specificPeople' : 'members'
}

/** The placeholder of `doc`, a well-formed sealed `type` document this reader could not open for `why`. */
export function membersOnlyItem(type: PrivateDocType, doc: PlainDocument, why: Unopened): MembersOnlyItem {
  const audience = docAudience(doc)
  const replyTo = asIdentifierString(doc['replyTo'])
  return {
    type,
    id: asIdentifierString(doc['$id']),
    author: asIdentifierString(doc['$ownerId']),
    createdAt: typeof doc['$createdAt'] === 'number' ? doc['$createdAt'] : 0,
    asMember: asIdentifierString(doc['asMember']) !== '',
    number: typeof doc['number'] === 'number' ? doc['number'] : null,
    replyTo: replyTo === '' ? null : replyTo,
    audience: audience === 'specificPeople' ? 'specificPeople' : 'members',
    why: audience === 'specificPeople' ? 'letter' : why,
  }
}

/** The hidden admission of a sealed document this reader cannot open. */
function unopened(type: PrivateDocType, doc: PlainDocument, why: Unopened, reason: HiddenReason): Admission {
  const placeholder = membersOnlyItem(type, doc, why)
  return { ok: false, reason: placeholder.why === 'letter' ? 'letter' : reason, placeholder }
}

/**
 * A public repo's gate without a members key: plaintext documents as they are; a well-formed
 * members-only or specific-people document becomes its placeholder ({@link MembersOnlyItem}),
 * never an error and never "not found".
 */
function publicGate(repo: RepoRef): ContentGate {
  return {
    visibility: repo.visibility,
    async admit(type, doc) {
      if (!wellFormedAs(repo, type, doc)) return { ok: false, reason: 'notEncrypted' }
      if (!isSealedDoc(doc)) return { ok: true, doc }
      // Sealed content here: the repo's writes check their parents from now on.
      noteMembersKey(repo.repoId)
      // an event's sealed value is dropped by its reader (`readableEvents`), the event kept
      return unopened(type, doc, 'noKey', 'membersOnly')
    },
  }
}

/** A private repo seen without keys (not a member, or no session yet): nothing is admitted. */
export function sealedGate(repo: RepoRef): ContentGate {
  return {
    visibility: repo.visibility,
    async admit(type, doc) {
      return { ok: false, reason: wellFormedAs(repo, type, doc) ? 'wrongKey' : 'notEncrypted' }
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

/** A block-height system field (`$createdAtBlockHeight` by default) as a number, or undefined. */
export function blockHeightOf(doc: PlainDocument, field: '$createdAtBlockHeight' | '$updatedAtBlockHeight' = '$createdAtBlockHeight'): number | undefined {
  const v = doc[field]
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
  return undefined
}

/**
 * The {@link StoredPrivateDoc} of a raw document of `type`: its plaintext bind fields as bytes,
 * opened under its own `vis` stamp (`openVis`, `private-repos.md` §18.1: a repository made public,
 * `converted`, keeps its earlier documents private). Null when a field the AD needs cannot be
 * decoded, or the stamp cannot be this repo's (the caller treats that as malformed).
 */
function storedPrivateDoc(type: PrivateDocType, doc: PlainDocument, repository: Visibility, converted = false): StoredPrivateDoc | null {
  const ownerId = idField(doc, '$ownerId')
  const id = idField(doc, '$id')
  const enc = bytesField(doc, 'enc')
  if (ownerId === undefined || enc === undefined || doc['epoch'] == null) return null
  const vis = openVis(doc['vis'], repository, converted, enc[0])
  if (vis === null) return null
  const updated = blockHeightOf(doc, '$updatedAtBlockHeight')
  const base = {
    type,
    vis,
    ownerId,
    epoch: num(doc, 'epoch'),
    id,
    createdAtBlockHeight: blockHeightOf(doc),
    ...(updated !== undefined ? { updatedAtBlockHeight: updated } : {}),
    enc,
  }
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
    case 'comment':
    case 'event': {
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

/** Where an admitted private document keeps the key epoch it was sealed under. */
export const SEALED_EPOCH = '$sealedEpoch'

/**
 * Where an admitted members-only document of a public repo says so (`'members'`): its decrypted
 * fields look like plaintext downstream, and a reply, an edit, a draft and a view must still
 * know who it was written for (DESIGN §2.4, §3.3).
 */
export const AUDIENCE_FIELD = '$audience'

/**
 * Where a list keeps a members-only issue or PR this reader cannot open as a row (DESIGN D14:
 * top-level issues and PRs always get one, "#42 · Members-only pull request"): the stored
 * document, untouched, with this mark. Its views have no title or body, only what is public.
 */
export const MEMBERS_ONLY_ROW = '$membersOnlyRow'

/** `doc` (a well-formed sealed issue or PR this reader cannot open) as a list's placeholder row. */
export function membersOnlyRow(doc: PlainDocument): PlainDocument {
  return { ...doc, [MEMBERS_ONLY_ROW]: true }
}

/** The audience of an admitted document ({@link AUDIENCE_FIELD}; plaintext otherwise). */
export function admittedAudience(doc: PlainDocument): Audience {
  const a = doc[AUDIENCE_FIELD]
  return a === 'members' || a === 'specificPeople' ? a : 'public'
}

/** The plaintext-shaped copy of an opened document: `enc` and `epoch` dropped, fields set. */
function asPlaintext(doc: PlainDocument, fields: DocFields): PlainDocument {
  const out: PlainDocument = { ...doc }
  delete out['enc']
  delete out['epoch']
  // The epoch it was sealed under stays readable as `$sealedEpoch`: a PR edit re-seals under the
  // PR's own epoch (private-repos.md §4.5), which no content field carries.
  if (doc['epoch'] != null) out[SEALED_EPOCH] = doc['epoch']
  for (const [k, v] of Object.entries(fields) as [string, unknown][]) {
    // A config's chain link carries raw keys of other epochs: never part of the plaintext view.
    if (v === undefined || k === 'prevEpochKey' || k === 'skipEpochKey' || k === 'prevEpoch') continue
    // An importer's sealed provenance (TLV 13, 14) goes back into its `imported` object.
    if (k === 'importedAuthor' || k === 'importedUrl') continue
    out[propOf(k as keyof DocFields)] = v
  }
  if (fields.importedAuthor !== undefined || fields.importedUrl !== undefined) {
    const kept = typeof out['imported'] === 'object' && out['imported'] !== null ? (out['imported'] as PlainDocument) : {}
    out['imported'] = {
      ...kept,
      ...(fields.importedAuthor !== undefined ? { author: fields.importedAuthor } : {}),
      ...(fields.importedUrl !== undefined ? { url: fields.importedUrl } : {}),
    }
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
      if (!wellFormedAs(repo, type, doc)) return { ok: false, reason: 'notEncrypted' }
      const stored = storedPrivateDoc(type, doc, 'private')
      if (stored === null) return { ok: false, reason: 'notEncrypted' }
      const opened = await openContent(stored, ctx)
      if (opened.status === 'readable') {
        // An anchor's prevEpochKey and skipEpochKey are older epochs' raw keys: never kept past
        // the open.
        const out = asPlaintext(doc, opened.fields)
        opened.fields.prevEpochKey?.fill(0)
        opened.fields.skipEpochKey?.fill(0)
        return { ok: true, doc: out }
      }
      if (opened.status === 'malformed') return { ok: false, reason: 'notEncrypted' }
      switch (opened.reason) {
        case 'late':
          return { ok: false, reason: 'late' }
        case 'lateEdit':
          return { ok: false, reason: 'lateEdit' }
        case 'badTag':
          return { ok: false, reason: 'notEncrypted' }
        case 'letter':
          return { ok: false, reason: 'letter' }
        case 'unknownVersion':
          return { ok: false, reason: 'unknownVersion' }
        default:
          return { ok: false, reason: 'wrongKey' }
      }
    },
  }
}

/**
 * The bucket of an unreadable members-only document (forge-core `keyring::hidden_bucket`, as the
 * lane reads v0x03): a failed tag or a commitment that does not match is a document made for
 * another key (forged, relabelled or moved), "not encrypted for this repo", never an earlier use
 * of the epoch; a letter is for specific people; the late rule has its own; anything else is
 * "wrong or missing key". (A private repo's v0x01 reads keep their own mapping, {@link privateGate}.)
 */
export function hiddenReasonOf(reason: UnreadableReason): HiddenReason {
  switch (reason) {
    case 'late':
      return 'late'
    case 'lateEdit':
      return 'lateEdit'
    case 'badTag':
    case 'commitMismatch':
      return 'notEncrypted'
    case 'letter':
      return 'letter'
    case 'unknownVersion':
      return 'unknownVersion'
    default:
      return 'wrongKey'
  }
}

/** How a public repo's {@link laneGate} reads: whether the repo was made public, and whether its reader is no member. */
export interface LaneOptions {
  /** The repo was made public (`private-repos.md` §18): its earlier documents open as private ones. */
  readonly converted?: boolean
  /**
   * The reader holds only the keys the owner of a repository made public published: a document
   * none of them opens is members-only to it, as to any reader without a key ({@link publicGate}).
   */
  readonly published?: boolean
}

/**
 * A public repo's gate over a member's members-key {@link OpenContext} (DESIGN §4.1): **per
 * document**. A plaintext document passes through as the public gate admits it; a sealed one
 * (members-only `enc` v0x03, or a repository made public's earlier content) opens under its own
 * `vis` and comes back with its fields as plaintext and {@link AUDIENCE_FIELD} set; one that does
 * not open is its placeholder.
 */
export function laneGate(repo: RepoRef, ctx: OpenContext, options: LaneOptions = {}): ContentGate {
  return {
    visibility: repo.visibility,
    async admit(type, doc) {
      if (!wellFormedAs(repo, type, doc)) return { ok: false, reason: 'notEncrypted' }
      if (!isSealedDoc(doc)) return { ok: true, doc }
      const stored = storedPrivateDoc(type, doc, repo.visibility, options.converted === true)
      if (stored === null) return { ok: false, reason: 'notEncrypted' }
      const opened = await openContent(stored, ctx)
      if (opened.status === 'readable') {
        const out = asPlaintext(doc, opened.fields)
        out[AUDIENCE_FIELD] = 'members'
        return { ok: true, doc: out }
      }
      if (opened.status === 'malformed') return { ok: false, reason: 'notEncrypted' }
      if (options.published === true && (opened.reason === 'noKey' || opened.reason === 'noEpoch')) {
        noteMembersKey(repo.repoId)
        return unopened(type, doc, 'noKey', 'membersOnly')
      }
      const reason = hiddenReasonOf(opened.reason)
      // a later client's envelope is members-only to this reader, as to one without a key
      const why: Unopened = reason === 'notEncrypted' ? 'notForThisRepo' : reason === 'unknownVersion' ? 'noKey' : 'notReadable'
      return unopened(type, doc, why, reason)
    },
  }
}

/** The gate of a reader's session over `ctx`: a private repo's {@link privateGate}, a public repo's {@link laneGate}. */
export function sessionGate(repo: RepoRef, ctx: OpenContext, options: LaneOptions = {}): ContentGate {
  return repo.visibility === 'private' ? privateGate(repo, ctx) : laneGate(repo, ctx, options)
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
    else tally.add(a.reason, a.placeholder)
  }
  return { docs: out, hidden: tally }
}

/** A repo's member events as read ({@link readableEvents}), and what their values were. */
export interface ReadableEvents {
  readonly docs: readonly PlainDocument[]
  /** Events whose sealed value is not readable here: kept, without their value. */
  readonly hiddenValues: number
  /** Events whose value an older client wrote in plaintext: kept (member-gated, so authentic). */
  readonly plaintextValues: number
}

type EventRead = { readonly doc: PlainDocument; readonly value: 'none' | 'sealed' | 'plaintext' | 'hidden' }

/** One member event as the folds read it (the CLI's `readable_event`). */
async function readableEvent(gate: ContentGate, d: PlainDocument): Promise<EventRead> {
  const doc: PlainDocument = { ...d }
  if (doc['value'] === '' || doc['value'] === null) delete doc['value']
  if ((bytesField(doc, 'enc')?.length ?? 0) === 0) return { doc, value: doc['value'] === undefined ? 'none' : 'plaintext' }
  // a plaintext value next to `enc` is never trusted: only the sealed one counts
  delete doc['value']
  const a = await gate.admit('event', doc)
  return a.ok ? { doc: a.doc, value: 'sealed' } : { doc, value: 'hidden' }
}

/**
 * A private repo's member events as the folds read them (the CLI's `readable_events`): every
 * event is kept, so its kind and `refId` stand (a dismissed review stays dismissed); a sealed
 * `value` is opened in place, or dropped when it does not open, as is a plaintext value next
 * to `enc`. A plaintext value on its own came from an older client and is kept, and counted.
 * An empty value is no value. In a public repo an event of a members-only issue carries its value
 * sealed (it follows its target, DESIGN §3.3): opened through the members key, else dropped; a
 * public repo with no sealed event is returned unchanged.
 */
export async function readableEvents(repo: RepoRef, docs: readonly PlainDocument[]): Promise<ReadableEvents> {
  if (repo.visibility !== 'private' && !docs.some(isSealedDoc)) return { docs, hiddenValues: 0, plaintextValues: 0 }
  const gate = gateFor(repo)
  const read = await Promise.all(docs.map((d) => readableEvent(gate, d)))
  return {
    docs: read.map((r) => r.doc),
    hiddenValues: read.filter((r) => r.value === 'hidden').length,
    // a public repo's plaintext values are simply public
    plaintextValues: repo.visibility === 'private' ? read.filter((r) => r.value === 'plaintext').length : 0,
  }
}

/**
 * The gate a read of `repo` goes through: a private repo's session for a member, a public repo's
 * members-key session (`repo.lane`) for a member who holds it, else {@link defaultGate}.
 */
export function gateFor(repo: RepoRef): ContentGate {
  return repo.session?.gate ?? repo.lane?.gate ?? defaultGate(repo)
}
