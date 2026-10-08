/**
 * Saving an environment from the browser (DESIGN §4.5, D9, D24): what a new snapshot starts from,
 * who it goes to, and the sealed version-2 letter, exactly as `dg env` writes it. The twin of
 * forge-core `env::service::{Book::base, Environments::prepare, Environments::store}`; the I/O
 * (keys, the vault, Platform) is injected ({@link EnvSaver}, bound to the SDK in `saver.ts`).
 *
 * - Every snapshot is a DFPK 0x02 letter to the people its audience resolves to at write time,
 *   the writer first and the rest in id order, each to their highest-id usable encryption key;
 *   someone with none is left out and named ({@link Prepared.skipped}).
 * - At most {@link MAX_RECIPIENTS} people, and one Platform chunk: a save past either is refused
 *   before anything is signed.
 * - Only a current maintainer saves (the saver checks it before sealing).
 */

import { estimateChunkCredits } from '../sdk/cost'
import { CHUNK_PAYLOAD_MAX } from '../constants'
import { artifactHeaderLength, privateId, randomBytes, bytesToHex, type LetterRecipient } from '../private'
import { supersedesWindow, MAX_SUPERSEDES } from './chain'
import { MAX_RECIPIENTS, audienceLabel, compareStrings as cmp, encodeSnapshot, type Audience, type EnvVar, type Snapshot } from './format'
import { currentOf, snapshotOf, stateOf, type EnvBook, type EnvManifest } from './loader'

/** The largest sealed snapshot one save writes: one Platform chunk (forge-core `MAX_SEALED`). */
export const MAX_SEALED = CHUNK_PAYLOAD_MAX
/** A `packManifest`'s storage, as `dg` quotes it (forge-core `cost::push_fees::MANIFEST_FIRST`). */
export const MANIFEST_CREDITS = 112_000_000

/** The upper bound a snapshot of `sealedLen` bytes costs: one chunk and one manifest (forge-core `snapshot_credits`). */
export function snapshotCredits(sealedLen: number): number {
  return estimateChunkCredits(sealedLen) + MANIFEST_CREDITS
}

/** Why a change can't be saved from here: told as is, nothing was written. */
export class EnvSaveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvSaveError'
  }
}

/** What a new snapshot of an environment starts from (forge-core `Base`). */
export interface Base {
  readonly vars: ReadonlyMap<string, EnvVar>
  /** Its audience, when it exists (an old snapshot's as the group of its word). */
  readonly audience: Audience | null
  /** Its id, when a version-2 snapshot of it exists. */
  readonly id: string | null
  /** The version of the snapshot it starts from (2 for a new environment). */
  readonly version: 1 | 2
  readonly markedChanged: readonly string[]
  /** The `packHash`es the new snapshot supersedes. */
  readonly supersedes: readonly string[]
  /** How many heads it has now (0 new, 1, or more when `keep` resolves a conflict). */
  readonly heads: number
}

function manifestsOf(book: EnvBook, ids: readonly string[]): EnvManifest[] {
  return ids.map((id) => book.manifests.find((m) => m.id === id)).filter((m): m is EnvManifest => m !== undefined)
}

/** The `supersedes` window over the snapshots `ids` of an environment whose heads are `heads` (forge-core `Book::window_over`). */
export function windowOver(book: EnvBook, ids: readonly string[], heads: readonly string[]): string[] {
  return supersedesWindow(manifestsOf(book, ids), heads)
}

/** The `supersedes` a new snapshot of `env` writes (forge-core `Book::window`). */
export function windowOf(book: EnvBook, env: string): string[] {
  const state = stateOf(book, env)
  return state === undefined ? [] : windowOver(book, state.snapshots, state.heads)
}

/** The `packHash`es of the manifests `ids`. */
export function hashesOf(book: EnvBook, ids: readonly string[]): string[] {
  return manifestsOf(book, ids).map((m) => m.packHash)
}

/** `first`, then `rest` not already in it, at most {@link MAX_SUPERSEDES} (dg `joined`). */
export function joined(first: readonly string[], rest: readonly string[]): string[] {
  const out = [...first]
  for (const h of rest) if (!out.includes(h)) out.push(h)
  return out.slice(0, MAX_SUPERSEDES)
}

/**
 * What a new snapshot of `env` starts from: its current entries and audience and the heads it
 * supersedes. On a conflict, `keep` (a head's id) picks the entries and the new snapshot
 * supersedes every head, which resolves it (forge-core `Book::base`).
 */
export function baseOf(book: EnvBook, env: string, keep?: string): Base {
  const from = (snap: Snapshot, heads: number): Base => ({
    vars: snap.vars,
    audience: snap.audience,
    id: snap.id,
    version: snap.version,
    markedChanged: snap.markedChanged,
    supersedes: windowOf(book, env),
    heads,
  })
  const cur = currentOf(book, env)
  if (cur.ok) return from(cur.snapshot, 1)
  const b = cur.blocked
  if (b.kind === 'missing') return { vars: new Map(), audience: null, id: null, version: 2, markedChanged: [], supersedes: [], heads: 0 }
  if (b.kind === 'conflict') {
    const picked = keep === undefined ? null : snapshotOf(book, keep)
    if (picked === null || !b.heads.some((h) => h.id === keep)) {
      throw new EnvSaveError(`${env} has versions saved at the same time: keep one of them first`)
    }
    return from(picked, b.heads.length)
  }
  if (b.unfetched) throw new EnvSaveError(`the latest change to ${env} could not be fetched (${b.reason}); try again`)
  throw new EnvSaveError(`the latest change to ${env} can't be read by you, so it can't be changed from here. Ask a maintainer who can read it to make the change, or to save it again for you.`)
}

/** A fresh environment id: 16 random bytes as 32 lowercase hex digits (forge-core `Base::id_or_new`). */
export function newEnvId(): string {
  return bytesToHex(randomBytes(16))
}

/** Someone's highest-id usable encryption key (forge-core `recipient_key`). */
export interface PersonKey {
  readonly keyId: number
  /** Compressed secp256k1 public key, 33 bytes. */
  readonly publicKey: Uint8Array
}

/** The writer: slot 0, sealed from their own key. */
export interface Sender extends PersonKey {
  readonly identity: string
}

/** Who a snapshot goes to: its `to` and `toKeys`, the letter's slots, and who was left out. */
export interface Recipients {
  readonly to: readonly string[]
  readonly toKeys: readonly number[]
  readonly slots: readonly LetterRecipient[]
  /** People of the audience with no usable encryption key: left out. */
  readonly skipped: readonly string[]
}

/**
 * The recipients of a snapshot for `people`: the writer at slot 0, then every other person in
 * id order (forge-core's `BTreeSet<String>`), each with their key from `keys` (absent or `null`:
 * left out).
 */
export function recipientsOf(sender: Sender, people: Iterable<string>, keys: ReadonlyMap<string, PersonKey | null>): Recipients {
  const to = [sender.identity]
  const toKeys = [sender.keyId]
  const slots: LetterRecipient[] = [{ identityId: privateId(sender.identity), publicKey: sender.publicKey }]
  const skipped: string[] = []
  for (const p of [...new Set(people)].filter((p) => p !== sender.identity).sort(cmp)) {
    const k = keys.get(p) ?? null
    if (k === null) {
      skipped.push(p)
      continue
    }
    to.push(p)
    toKeys.push(k.keyId)
    slots.push({ identityId: privateId(p), publicKey: k.publicKey })
  }
  return { to, toKeys, slots, skipped }
}

/** A snapshot ready to seal (forge-core `Draft`). */
export interface Draft {
  readonly env: string
  readonly id: string
  readonly audience: Audience
  readonly vars: ReadonlyMap<string, EnvVar>
  readonly supersedes: readonly string[]
  /** Set when saving a removed maintainer's values again for them. */
  readonly savedFor?: string
  readonly markedChanged: readonly string[]
  /** The people the audience resolves to (the writer is added). */
  readonly people: ReadonlySet<string>
}

/** The "too many" sentence (DESIGN §10). */
export function tooManyText(audience: Audience, n: number): string {
  return `${audienceLabel(audience)} is ${n} people. An environment can be shared with at most ${MAX_RECIPIENTS}. Choose a smaller group or specific people.`
}

/** The version-2 snapshot `draft` makes for `r` at `generatedAt`. */
export function draftSnapshot(draft: Draft, r: Recipients, generatedAt: number): Snapshot {
  return {
    version: 2,
    env: draft.env,
    audience: draft.audience,
    id: draft.id,
    generatedAt,
    ...(draft.savedFor !== undefined ? { savedFor: draft.savedFor } : {}),
    to: r.to,
    toKeys: r.toKeys,
    markedChanged: draft.markedChanged,
    vars: draft.vars,
  }
}

/** The browser's reads and writes a save makes. */
export interface EnvSaver {
  /** The signer (base58). */
  readonly me: string
  /** Refuse anyone but a current maintainer before anything is sealed. */
  requireMaintainer(): Promise<void>
  /** The signer's slot: the newest usable encryption key this browser holds. */
  sender(): Promise<Sender>
  /** Each person's usable encryption key (`null`: none). */
  keysOf(ids: readonly string[]): Promise<ReadonlyMap<string, PersonKey | null>>
  /** Seal `snapshot` to `slots` (slot 0 is the sender) as a DFPK 0x02 artifact. */
  seal(slots: readonly LetterRecipient[], snapshot: Snapshot): Promise<Uint8Array>
  /** Store `sealed` as one chunk and record its kind-8 manifest. */
  store(sealed: Uint8Array, supersedes: readonly string[]): Promise<{ readonly id: string; readonly packHash: string }>
}

/** A sealed snapshot not yet written (forge-core `Prepared`). */
export interface Prepared {
  readonly draft: Draft
  readonly sealed: Uint8Array
  readonly to: readonly string[]
  readonly skipped: readonly string[]
  readonly credits: number
}

/**
 * Seal `draft` as the next snapshot of its environment: refused unless the signer is a current
 * maintainer, past {@link MAX_RECIPIENTS} people or past one chunk. Nothing is written.
 */
export async function prepareSave(saver: EnvSaver, draft: Draft, now: number = Date.now()): Promise<Prepared> {
  await saver.requireMaintainer()
  const sender = await saver.sender()
  const others = [...draft.people].filter((p) => p !== sender.identity)
  const keys = await saver.keysOf(others)
  const r = recipientsOf(sender, draft.people, keys)
  if (r.to.length > MAX_RECIPIENTS) throw new EnvSaveError(tooManyText(draft.audience, r.to.length))
  const snapshot = draftSnapshot(draft, r, now)
  const sealed = await saver.seal(r.slots, snapshot)
  if (sealed.length > MAX_SEALED) {
    throw new EnvSaveError(
      `${draft.vars.size} values for ${r.to.length} people don't fit one save (${sealed.length} bytes encrypted; one save holds at most ${MAX_SEALED}). Split it into two environments, or share it with fewer people.`,
    )
  }
  return { draft, sealed, to: r.to, skipped: r.skipped, credits: snapshotCredits(sealed.length) }
}

/** What {@link storeSave} wrote. */
export interface Saved {
  readonly id: string
  readonly packHash: string
  readonly to: readonly string[]
  readonly skipped: readonly string[]
}

export async function storeSave(saver: EnvSaver, p: Prepared): Promise<Saved> {
  const { id, packHash } = await saver.store(p.sealed, p.draft.supersedes)
  return { id, packHash, to: p.to, skipped: p.skipped }
}

/**
 * The sealed size of `snap` saved again for `n` people, estimated before sealing (dg `Pin::new`):
 * the plaintext grows by about one id per added recipient, the header by one slot each.
 */
export function estimatedSealedSize(snap: Snapshot, n: number): number {
  const people = Math.max(1, n)
  let plain = 512
  try {
    plain = encodeSnapshot(snap).length
  } catch {
    // an estimate only
  }
  plain = Math.ceil((plain + 48 * Math.max(0, people - snap.to.length)) / 512) * 512
  return plain + artifactHeaderLength(people) + 16
}
