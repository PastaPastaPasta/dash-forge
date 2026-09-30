/**
 * A private repo's release revisions (`docs/security/private-repos.md` §16; forge-core
 * `collab::v2::create_sealed_release`, which this mirrors).
 *
 * A revision is sealed under the write epoch of a fresh read of the anchors (§5.3, §16.4). It is a
 * complete statement (§16.3): what the writer does not change is carried forward from the tag's
 * newest readable revision, the yank and the draft and pre-release flags included. New files are
 * sealed (§3) and stored on the publisher's own storage named by their SEALED hash, then listed
 * in a sealed kind-4 manifest recorded as a `packManifest` that publishes nothing about the list
 * (§16.5); notes over the 1507-byte budget continue in that manifest. If a final re-read of the
 * anchors finds the write key moved during the upload, everything new is sealed and stored again
 * under the new one (at most twice). The document is exactly `{repoId, tagName, vis: "private",
 * delta: 0, epoch, enc}`, with no `oneLive` retry: consensus keeps no ledger for a sealed tag,
 * so the tag is read again after the write and a revision that is not its newest is reported.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import { decodeIdentifier } from '../auth/base58'
import { PACK_KIND, STORAGE } from '../constants'
import {
  EpochKeys,
  MalformedError,
  PLACEHOLDER_ASSET_MANIFEST,
  RELEASE_MAX_PLAINTEXT,
  TooLargeError,
  bytesEqual,
  canonicalJson,
  encodeReleaseTlv,
  fitReleaseNotes,
  sealPack,
  sealRelease,
  sealReleaseManifest,
  type EpochKeyring,
  type ReleaseAsset as SealedAsset,
  type ReleaseFields,
  type ReleaseManifest,
} from '../private'
import { isRc1TagName } from '../rules'
import { previewCredits, type CostPreview, type WriteAuth, type WriteResult } from '../sdk'
import { admissionFor, estimateBytesCredits } from '../sdk/cost'
import { storeFile, type StoragePolicy, type StorageProfile, type StoredFile, type TargetFailure, type UploadEvent } from '../storage'
import { DOC, type RepoRef } from './contract'
import { requireMaintainer } from './members'
import { PrivateWriteError, privateWriter, privateWriterWithSession, sealedIntent } from './private-writes'
import { repoContentWritten, writePackManifest } from './push'
import { readReleases, type ReleaseList, type ReleaseView } from './releases'
import { writeRepoDoc } from './writes'

/** What the CLI and the composer say the sealed budget holds (§16.2 "Budget"). */
export const SEALED_RELEASE_BUDGET = `a private release holds ${RELEASE_MAX_PLAINTEXT} bytes of tag, name, notes preview and provenance`

/** A file to seal and store as an asset (a browser `File`). */
export interface SealedReleaseFile {
  readonly name: string
  readonly size: number
  arrayBuffer(): Promise<ArrayBuffer>
}

/**
 * A revision as one attempt resolved it: the sealed fields (the asset list's hash included) and
 * the write key. A retry of an unconfirmed write passes it back and re-signs exactly it, under
 * the same key, uploading nothing.
 */
export interface ResolvedSealedRelease {
  readonly fields: ReleaseFields
  readonly epoch: number
  /** The write key's check value (hex): a rotation that reused the epoch number is still a move. */
  readonly kcv: string
  /** The entries of the asset list this revision built (empty when it built none: none named, or the carried one kept). */
  readonly assets: readonly SealedAsset[]
}

/** What a sealed revision states; absent fields are carried from the tag's newest revision. */
export interface SealedReleaseInput {
  readonly tagName: string
  /** Absent or empty: carried. */
  readonly name?: string
  /** Absent or empty: carried (with the asset list they may continue in). */
  readonly notes?: string
  readonly prerelease?: boolean
  readonly draft?: boolean
  /** Absent: carried; only an explicit yank or un-yank changes it. */
  readonly yanked?: boolean
  /** Stated per revision: absent is a revision that does not unpublish. */
  readonly unpublished?: boolean
  /** New files; one of a kept asset's name replaces it. */
  readonly files?: readonly SealedReleaseFile[]
  /** The action's intent: a retry of the same content finishes the same signed write. */
  readonly intent?: string
  /** Retry an unconfirmed write: exactly this revision, nothing uploaded. */
  readonly resolved?: ResolvedSealedRelease
}

/**
 * What a sealed writer says once the revision is written (§16.3, §16.5; forge-core
 * `sealed_write_warnings`): it carried forward from a view that misses a newer revision; it is
 * not the tag's newest (or that could not be checked); a rotation left copies under an old key.
 */
export interface SealedReleaseWarning {
  readonly message: string
  /** The tag's newest revision, when it is another maintainer's (a lost update, or a clock behind). */
  readonly newer?: ReleaseView
}

export interface SealedReleaseWritten {
  readonly release: WriteResult
  readonly resolved: ResolvedSealedRelease
  readonly warnings: readonly SealedReleaseWarning[]
  /**
   * The sealed hashes of objects stored under a key that moved before signing (§16.5): they name
   * nothing, and hold content a removed member could open.
   */
  readonly orphaned: readonly string[]
}

/** Progress of a sealed publish. */
export type SealedReleaseEvent =
  | { readonly step: 'role' }
  | { readonly step: 'upload'; readonly asset: string; readonly event: UploadEvent }
  | { readonly step: 'uploaded'; readonly asset: string; readonly entry: SealedAsset; readonly copies: number; readonly failures: readonly TargetFailure[] }
  | { readonly step: 'resealing'; readonly epoch: number }
  | { readonly step: 'release'; readonly resolved: ResolvedSealedRelease }

/** What a sealed revision reads and stores through: the signer's fresh sessions and own storage. */
export interface SealedReleaseEnv {
  /** Re-read the signer's role, uncached: nothing is uploaded for a write consensus refuses. */
  requireMaintainer(): Promise<void>
  /** The write epoch's keys, from a fresh read of the anchors (§5.3). */
  writeKeys(): Promise<EpochKeys>
  /** Every release of the repo, read now with a fresh session, and the keys it opened them with. */
  releases(): Promise<{ readonly list: ReleaseList; readonly keys: EpochKeyring }>
  /** The kind-4 asset list `fields` names, opened by the §16.5 reader rules. */
  openManifest(fields: ReleaseFields, keys: EpochKeyring): Promise<ReleaseManifest>
  /** Store sealed bytes on the user's own storage, named by their own SHA-256. */
  store(sealed: Uint8Array, onStep: (e: UploadEvent) => void): Promise<StoredFile>
}

/** The storage the files and the asset list go to (the repo's browser-push policy). */
interface SealedReleaseStorage {
  readonly policy: StoragePolicy | null
  readonly profiles: readonly StorageProfile[]
}

/** What {@link createRelease} (`writes.ts`) takes besides the fields, for a private repo. */
export interface SealedReleaseOptions {
  readonly files?: readonly SealedReleaseFile[]
  readonly storage?: SealedReleaseStorage | null
  readonly resolved?: ResolvedSealedRelease
  readonly onEvent?: (e: SealedReleaseEvent) => void
  /** Replaces the default reads and storage (tests). */
  readonly env?: SealedReleaseEnv
}

/** A sealed asset entry holds at most 8 URIs (§16.5). */
const ASSET_MAX_URIS = 8

/** The default {@link SealedReleaseEnv}: fresh sessions of `auth`, and `storage` (none: nothing can be stored). */
export function sealedReleaseEnv(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  storage: SealedReleaseStorage | null,
): SealedReleaseEnv {
  return {
    requireMaintainer: () => requireMaintainer(sdk, repo, auth.identityId, auth.network),
    writeKeys: async () => (await privateWriter(sdk, auth, repo)).keys,
    releases: async () => {
      const { session } = await privateWriterWithSession(sdk, auth, repo)
      try {
        return { list: await readReleases(sdk, { ...repo, session }), keys: session.ctx.keys }
      } finally {
        session.close()
      }
    },
    // Loaded when needed: the browse plane's reader imports this module's own writers.
    openManifest: async (fields, keys) => (await import('../view/release-download')).loadReleaseManifest(sdk, repo, fields, keys),
    store: (sealed, onStep) => storeFile(sealed, { policy: storage?.policy ?? null, profiles: storage?.profiles ?? [], maxUris: ASSET_MAX_URIS, onStep }),
  }
}

const hex256 = (b: Uint8Array): string => bytesToHex(sha256(b))
const nonEmpty = (s: string | undefined): string | undefined => (s === undefined || s === '' ? undefined : s)

/** `f` without absent options or `false` flags: the vectors' form, and a stable digest. */
function statement(f: ReleaseFields): ReleaseFields {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== false)) as unknown as ReleaseFields
}

/** Whether two write keys are the same key: the epoch and its key check value (§5.3). */
function sameKey(a: EpochKeys, b: EpochKeys): boolean {
  return a.epoch === b.epoch && bytesEqual(a.kcv, b.kcv)
}

/**
 * The newest readable revision of `tag`: its release when live, else the newest of its history
 * (an unpublished tag's included). forge-core `newest_revision`.
 */
export function newestRevision(list: ReleaseList, tag: string): ReleaseView | undefined {
  return list.current.find((r) => r.tagName === tag) ?? list.previous.find((r) => r.tagName === tag)
}

/**
 * The warning a sealed writer gives when its revision `ours` is not the newest of `tag` after the
 * write (§16.3; forge-core `not_newest_warning`): a concurrent revision (a lost update) or a clock
 * behind another writer's, since `$createdAt` is client-set. When the read does not show `ours`
 * yet (or failed: `after` null), the check could not be made, and the warning says so. Null when
 * it is the newest.
 */
export function notNewestWarning(after: ReleaseList | null, tag: string, ours: string): SealedReleaseWarning | null {
  const newest = after === null ? undefined : newestRevision(after, tag)
  if (newest?.id === ours) return null
  if (newest !== undefined && after?.previous.some((r) => r.id === ours) === true) {
    return {
      message: `Your revision of release ${tag} is older than another maintainer's: they wrote one meanwhile, or your clock is behind theirs. Check the release, and publish again if theirs dropped your change.`,
      newer: newest,
    }
  }
  return { message: `Your revision of release ${tag} is not visible yet, so whether it is the newest could not be checked: reload the releases in a moment.` }
}

/** Everything a sealed writer says once the revision `ours` of `tag` is written ({@link SealedReleaseWarning}). */
export function sealedWriteWarnings(tag: string, before: ReleaseList, after: ReleaseList | null, ours: string, orphaned: readonly string[]): SealedReleaseWarning[] {
  const warnings: SealedReleaseWarning[] = []
  if (before.stale === true || before.unknownTags?.includes(tag) === true) {
    warnings.push({
      message: `Release ${tag} was carried forward from the newest revision you can read; a newer one exists that you can't read yet, and this revision may undo its changes.`,
    })
  }
  const notNewest = notNewestWarning(after, tag, ours)
  if (notNewest !== null) warnings.push(notNewest)
  if (orphaned.length > 0) {
    warnings.push({
      message: `This repo's key epoch moved during the upload, so the release was sealed again. The first copies, under the old key, are still in your storage and name nothing: ${orphaned.join(', ')}`,
    })
  }
  return warnings
}

/**
 * The fields a revision states before its notes and asset list are fitted (§16.3): the input's,
 * else the tag's newest readable revision's. The target and the provenance are always carried;
 * `unpublished` is stated per revision.
 */
export function carriedFields(input: SealedReleaseInput, carried: ReleaseFields | undefined): ReleaseFields {
  return statement({
    tag: input.tagName,
    name: nonEmpty(input.name) ?? carried?.name,
    notes: carried?.notes,
    targetOid: carried?.targetOid,
    prerelease: input.prerelease ?? carried?.prerelease,
    draft: input.draft ?? carried?.draft,
    yanked: input.yanked ?? carried?.yanked,
    unpublished: input.unpublished,
    notesContinue: carried?.notesContinue,
    importedAuthor: carried?.importedAuthor,
    importedUrl: carried?.importedUrl,
    importedCreatedAt: carried?.importedCreatedAt,
    assetManifest: carried?.assetManifest,
  })
}

/**
 * How a revision treats its asset list: `keep` names the carried one as it is (an edit of the
 * name or the flags), `reuse` too with new notes that fit whole beside it (its list holds no
 * notes to change), and `rebuild` seals and stores a new one (new files, notes that continue in
 * it, or new notes replacing the ones it continued).
 */
export function assetListPlan(base: ReleaseFields, newNotes: string | undefined, files: number): 'keep' | 'reuse' | 'rebuild' {
  if (files > 0) return 'rebuild'
  if (newNotes === undefined) return 'keep'
  if (base.notesContinue === true) return 'rebuild'
  return fitReleaseNotes(base, newNotes).notesContinue ? 'rebuild' : 'reuse'
}

/**
 * The budget a revision's sealed fields use (§16.2): the TLV records of `fields` with `notes`
 * fitted, against {@link RELEASE_MAX_PLAINTEXT}; `notesContinue` when the notes do not fit whole
 * and continue in the asset list. `hasAssets`: the revision names an asset list.
 */
export function sealedReleaseBudget(fields: ReleaseFields, notes: string, hasAssets: boolean): { readonly used: number; readonly limit: number; readonly notesContinue: boolean } {
  const withList = hasAssets ? { ...fields, assetManifest: fields.assetManifest ?? PLACEHOLDER_ASSET_MANIFEST } : { ...fields, assetManifest: undefined }
  const fit = fitReleaseNotes(withList, notes)
  return { used: encodeReleaseTlv(fit.fields).length, limit: RELEASE_MAX_PLAINTEXT, notesContinue: fit.notesContinue }
}

/** A sealed revision's `enc` for `tlvBytes` of records: padded to 32-byte buckets, plus 29 of framing. */
function encLength(tlvBytes: number): number {
  const padded = tlvBytes + 3 > RELEASE_MAX_PLAINTEXT ? tlvBytes : Math.min(Math.ceil((tlvBytes + 3) / 32) * 32, RELEASE_MAX_PLAINTEXT)
  return padded + 29
}

/** The cost of a sealed release document whose TLV records take `tlvBytes` (its `enc`, a 43-character `tagName`). */
export function sealedReleaseCost(tlvBytes: number): CostPreview {
  const enc = encLength(tlvBytes)
  const credits = estimateBytesCredits(DOC.release, enc, { tagName: 'x'.repeat(43), vis: 'private', delta: 0, epoch: 0 })
  return previewCredits(credits, admissionFor(DOC.release, enc, credits))
}

/** A new revision's asset list, sealed and stored under `keys` (§16.5). */
interface BuiltList {
  readonly fields: ReleaseFields
  readonly assets: SealedAsset[]
  /** The sealed hashes this attempt stored (the files', then the list's). */
  readonly stored: string[]
}

/**
 * A revision's new asset list under `keys` (forge-core `rebuild_asset_list`): the previous list's
 * assets but those a new file replaces, then the new files sealed and stored, then the notes
 * fitted (TLV 21 counted when there is a list) and the list sealed, stored and recorded as a
 * kind-4 `packManifest` with `objectCount` 0, no `tips` and no `supersedes`. No list at all when
 * there is no asset and the notes fit whole.
 */
async function buildAssetList(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  env: SealedReleaseEnv,
  keys: EpochKeys,
  from: { readonly base: ReleaseFields; readonly notes: string; readonly files: readonly SealedReleaseFile[]; readonly prev: ReleaseManifest | null; readonly intent: string | undefined },
  onEvent: (e: SealedReleaseEvent) => void,
): Promise<BuiltList> {
  const replaced = new Set(from.files.map((f) => f.name))
  const assets: SealedAsset[] = (from.prev?.assets ?? []).filter((a) => !replaced.has(a.name))
  const stored: string[] = []
  for (const f of from.files) {
    // One file in memory at a time, with its sealed copy.
    const plain = new Uint8Array(await f.arrayBuffer())
    const plainHash = hex256(plain)
    const sealed = await sealPack(keys, plain)
    plain.fill(0)
    const sealedHash = hex256(sealed)
    const copy = await env.store(sealed, (event) => onEvent({ step: 'upload', asset: f.name, event }))
    stored.push(sealedHash)
    const entry: SealedAsset = {
      name: f.name,
      sha256: plainHash,
      sizeBytes: plain.length,
      uris: copy.uris.slice(0, ASSET_MAX_URIS),
      sealedSha256: sealedHash,
      sealedSizeBytes: sealed.length,
    }
    assets.push(entry)
    onEvent({ step: 'uploaded', asset: f.name, entry, copies: copy.confirmed.length, failures: copy.failures })
  }
  // TLV 21's 35 bytes are counted before the notes are fitted when there will be a list.
  const fit = fitReleaseNotes({ ...from.base, assetManifest: assets.length > 0 ? PLACEHOLDER_ASSET_MANIFEST : undefined }, from.notes)
  if (assets.length === 0 && !fit.notesContinue) return { fields: statement({ ...fit.fields, assetManifest: undefined }), assets, stored }
  const manifest: ReleaseManifest = {
    v: 1,
    tag: from.base.tag,
    total: assets.length,
    ...(from.prev?.source !== undefined ? { source: from.prev.source } : {}),
    ...(fit.notesContinue ? { notes: from.notes } : {}),
    assets,
  }
  const { sealed } = await sealReleaseManifest(keys, manifest)
  const packHash = hex256(sealed)
  const copy = await env.store(sealed, (event) => onEvent({ step: 'upload', asset: 'the asset list', event }))
  stored.push(packHash)
  await writePackManifest(
    sdk,
    auth,
    repo,
    { packHash, kind: PACK_KIND.RELEASE_ASSETS, sizeBytes: sealed.length, objectCount: 0, chunkCount: 0, storage: STORAGE.EXTERNAL, uris: copy.uris },
    from.intent === undefined ? undefined : `${from.intent}:${packHash}`,
  )
  return { fields: statement({ ...fit.fields, assetManifest: packHash }), assets, stored }
}

/** The sealed revision's document, written as `{repoId, tagName, vis: "private", delta: 0, epoch, enc}`. */
async function writeSealed(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, keys: EpochKeys, fields: ReleaseFields, intent: string | undefined): Promise<WriteResult> {
  let sealed: { readonly tagName: string; readonly enc: Uint8Array }
  try {
    sealed = await sealRelease(keys, decodeIdentifier(auth.identityId), fields)
  } catch (e) {
    if (e instanceof TooLargeError) throw new PrivateWriteError(`release ${fields.tag} not written: ${SEALED_RELEASE_BUDGET}, and this one does not fit (a shorter name)`)
    if (e instanceof MalformedError) throw new PrivateWriteError(`release ${fields.tag} can't be written to a private repo: ${e.message}`)
    throw e
  }
  // The content the retry cache compares (the enc is sealed afresh on every attempt), and an
  // intent bound to it and to the key: a retry after a rotation signs afresh (§5.5).
  const digest = hex256(new TextEncoder().encode(canonicalJson(statement(fields)))).slice(0, 32)
  try {
    // delta 0 always (`oneLive`), and no retry against a ledger there is none of (§16.3)
    return await writeRepoDoc(
      sdk,
      auth,
      repo,
      DOC.release,
      { tagName: sealed.tagName, delta: 0, epoch: keys.epoch, enc: sealed.enc },
      sealedIntent(intent === undefined ? undefined : `${intent}:${digest}`, keys),
      undefined,
      `release:${digest}`,
    )
  } finally {
    repoContentWritten(repo)
  }
}

/**
 * Write a private repo's release revision (§16.3–§16.5; see the module doc). Maintainers only.
 * Throws {@link PrivateWriteError} for what the seal refuses and when the write key moved twice
 * during the upload; nothing is signed then.
 */
export async function createSealedRelease(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: SealedReleaseInput,
  env: SealedReleaseEnv,
  onEvent: (e: SealedReleaseEvent) => void = () => undefined,
): Promise<SealedReleaseWritten> {
  if (repo.visibility !== 'private') throw new Error('a sealed release is for a private repo')
  const tag = input.tagName
  const files = input.files ?? []
  refuseSealedInput(input, files)

  if (input.resolved !== undefined) {
    // An unconfirmed write, finished: exactly its revision, under exactly its key.
    const keys = await env.writeKeys()
    if (keys.epoch !== input.resolved.epoch || bytesToHex(keys.kcv) !== input.resolved.kcv) {
      throw new PrivateWriteError(`release ${tag} not retried: the key epoch moved since the unconfirmed write, whose assets are under the old key; publish it again`)
    }
    onEvent({ step: 'release', resolved: input.resolved })
    const release = await writeSealed(sdk, auth, repo, keys, input.resolved.fields, input.intent)
    return { release, resolved: input.resolved, warnings: [notNewestWarning(await readAfter(env), tag, release.documentId)].filter((w) => w !== null), orphaned: [] }
  }

  onEvent({ step: 'role' })
  await env.requireMaintainer()
  // Every revision of the tag, read now (§16.3): what this one does not change is carried.
  const before = await env.releases()
  const carried = newestRevision(before.list, tag)?.sealed?.fields
  const base = carriedFields(input, carried)
  const newNotes = nonEmpty(input.notes)
  const plan = assetListPlan(base, newNotes, files.length)
  const prev = plan === 'rebuild' && carried?.assetManifest !== undefined ? await env.openManifest(carried, before.keys) : null
  // The full notes this revision states.
  const notes = newNotes ?? (carried?.notesContinue === true ? (prev?.notes ?? '') : (carried?.notes ?? ''))

  const orphaned: string[] = []
  let keys: EpochKeys
  let fields: ReleaseFields
  // Only a rebuilt list's entries: a kept or reused list is not opened.
  let assets: readonly SealedAsset[] = []
  for (let attempt = 1; ; attempt++) {
    // The write epoch of keys read now (§5.3).
    const w = await env.writeKeys()
    if (plan !== 'rebuild') {
      keys = w
      fields = plan === 'reuse' ? statement(fitReleaseNotes(base, notes).fields) : base
      break
    }
    const built = await buildAssetList(sdk, auth, repo, env, w, { base, notes, files, prev, intent: input.intent }, onEvent)
    // The final anchor re-read before signing (§5.3, §16.5): a rotation during the upload would
    // leave the new artifacts readable to the member it removed.
    const now = await env.writeKeys()
    if (sameKey(now, w)) {
      keys = now
      fields = built.fields
      assets = built.assets
      break
    }
    orphaned.push(...built.stored)
    if (attempt >= 2) {
      throw new PrivateWriteError(
        `release ${tag} not written: this repo's key epoch moved twice while its assets were uploaded; publish it again. Stored under a key no longer current, and named by nothing: ${orphaned.join(', ')}`,
      )
    }
    onEvent({ step: 'resealing', epoch: now.epoch })
  }
  const resolved: ResolvedSealedRelease = { fields, epoch: keys.epoch, kcv: bytesToHex(keys.kcv), assets }
  onEvent({ step: 'release', resolved })
  const release = await writeSealed(sdk, auth, repo, keys, fields, input.intent)
  return { release, resolved, warnings: sealedWriteWarnings(tag, before.list, await readAfter(env), release.documentId, orphaned), orphaned }
}

/** The repo's releases read again after the write (§16.3), or null when that read fails. */
async function readAfter(env: SealedReleaseEnv): Promise<ReleaseList | null> {
  try {
    return (await env.releases()).list
  } catch {
    return null
  }
}

/** Code points, as the contract's `maxLength` counts them. */
const chars = (s: string): number => [...s].length
const bytes = (s: string): number => new TextEncoder().encode(s).length

/**
 * What a sealed writer refuses before anything is read or stored (forge-core
 * `check_sealed_input`): the tag grammar, the name (120 characters, 480 bytes) and notes (5120
 * of each) caps, and two files of one name.
 */
function refuseSealedInput(input: SealedReleaseInput, files: readonly SealedReleaseFile[]): void {
  if (!isRc1TagName(input.tagName)) throw new Error(`${JSON.stringify(input.tagName)} is not a tag name git accepts`)
  const name = input.name ?? ''
  const notes = input.notes ?? ''
  if (chars(name) > 120 || bytes(name) > 480) throw new Error('the title holds at most 120 characters and 480 bytes')
  if (chars(notes) > 5120 || bytes(notes) > 5120) throw new Error('the notes hold at most 5120 characters and 5120 bytes')
  const names = files.map((f) => f.name)
  if (new Set(names).size !== names.length) throw new Error('two assets have the same name')
}
