/**
 * Publishing a release from the browser (`ux-dx-spec.md` §5.9, parity with `dg release create
 * --asset`): the signer's maintainer role is re-read first (nothing is uploaded for a write
 * consensus would refuse); each asset is then uploaded to the publisher's own storage, verified,
 * and recorded as `{name, sha256, sizeBytes, uris}`; then one `release` document names them.
 * A newer release for the same tag supersedes the older one.
 *
 * Everything that can be checked before uploading is: the tag, title and notes against the
 * `release` schema, each asset's name and size, and the whole asset list against the
 * document's 4096 bytes, sized from the entries the uploads will produce (their URLs are
 * deterministic: a content-addressed key per SHA-256, a fixed-length CID).
 *
 * The tag need not exist yet (GitHub's "Create new tag on publish", P1-4): with `createTag` the
 * publish first writes `refs/tags/<tag>` as a lightweight tag at the chosen commit (one ref update
 * from the browser's push writer, no pack: the commit is already stored), after the role check
 * and before anything uploads. A retry finds the tag at that commit and writes nothing.
 *
 * A private repo's release is a sealed revision (`private-repos.md` §16, `sealed-release.ts`):
 * its files are sealed before they leave the browser and stored under their sealed hash, the
 * asset list is a sealed kind-4 manifest, and the document holds only `enc`.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { WriteAuth, WriteResult } from '../sdk'
import type { ReleaseAsset as SealedAsset } from '../private'
import {
  NO_EXTERNAL_STORAGE,
  artifactKey,
  externalTargets,
  policyForRepo,
  storeFile,
  type StorageConfig,
  type StoragePolicy,
  type StorageProfile,
  type TargetFailure,
  type UploadEvent,
} from '../storage'
import { gatewayUrl } from '../storage/ipfs'
import { publicObjectUrl, s3Uri } from '../storage/s3'
import { sha256Hex } from '../storage/sigv4'
import type { RepoRef } from './contract'
import { requireMaintainer } from './members'
import { readReleases, type ReleaseAssetView } from './releases'
import type { ResolvedSealedRelease, SealedReleaseEvent, SealedReleaseWarning } from './sealed-release'
import { ensureTag, readRefNow } from './ref-admin'
import { createRelease, releaseAssetsJson, type ReleaseAsset } from './writes'
import { isLongBody, longBodyField } from './long-body'
import { isRc1TagName } from '../rules'
import { ASSET_NAME_WHY, assetNamesProblem, sameFileKey } from '../rules/asset-name'

/** The `release` schema's limits (forge-core `release`: `maxLength` characters, `maxBytes`). */
export const RELEASE_LIMITS = {
  tagName: { chars: 63, bytes: 63 },
  name: { chars: 120, bytes: 480 },
  notes: { chars: 5120, bytes: 5120 },
} as const

/** The largest single asset the browser reads into memory; bigger ones go through the CLI. */
export const MAX_ASSET_BYTES = 256 * 1024 * 1024

const utf8 = (s: string): number => new TextEncoder().encode(s).length
const chars = (s: string): number => [...s].length

function fits(field: string, s: string, limit: { chars: number; bytes: number }): string | null {
  if (chars(s) > limit.chars) return `${field} holds at most ${limit.chars} characters`
  if (utf8(s) > limit.bytes) return `${field} holds at most ${limit.bytes} bytes (accented letters and emoji take more than one)`
  return null
}

/**
 * Why `tag` cannot name a release, or null: the contract's `tagName` grammar (RC1 R-01) plus what
 * it leaves to git (any whitespace, `@` alone, a leading `-`, a `.lock` component).
 */
export function tagProblem(tag: string): string | null {
  if (tag === '') return 'a tag is needed (e.g. v1.0.0)'
  const size = fits('a tag', tag, RELEASE_LIMITS.tagName)
  if (size) return size
  const bad = /\s/.test(tag) || tag === '@' || tag.startsWith('-') || /\.lock(\/|$)/.test(tag)
  return bad || !isRc1TagName(tag) ? 'that is not a valid git tag name' : null
}

/** Why the release text does not fit its document, or null. */
export function releaseTextProblem(input: { name: string; notes: string }): string | null {
  return fits('the title', input.name, RELEASE_LIMITS.name) ?? fits('the notes', input.notes, RELEASE_LIMITS.notes)
}

/**
 * Why a set of asset files cannot be published, or null. Each name must be one a download saves
 * as itself (`../rules/asset-name`, as `dg release create` checks), and no two assets of the
 * release, the `kept` ones a public revision carries included, may save as one file on a
 * case-insensitive disk. A kept name is not checked itself: it was published before.
 */
export function assetFilesProblem(
  files: readonly { readonly name: string; readonly size: number }[],
  kept: readonly { readonly name: string }[] = [],
): string | null {
  const names = assetNamesProblem(files.map((f) => f.name))
  if (names !== null && 'problem' in names) {
    return `${names.name.slice(0, 40)}: ${ASSET_NAME_WHY[names.problem]}, so a download would not save it under that name: rename the file`
  }
  if (names !== null) {
    return names.name === names.sameFileAs ? 'two assets have the same name' : `${names.name} and ${names.sameFileAs} save as the same file on a case-insensitive disk: rename one`
  }
  const keptKeys = new Map(kept.map((a) => [sameFileKey(a.name), a.name]))
  for (const f of files) {
    const other = keptKeys.get(sameFileKey(f.name))
    if (other !== undefined) return `${f.name} saves as the same file as this release's asset ${other}: name it ${other} to replace that asset, or rename it`
  }
  for (const f of files) {
    if (f.size === 0) return `${f.name} is empty`
    if (f.size > MAX_ASSET_BYTES) return `${f.name} is over ${MAX_ASSET_BYTES / 1024 / 1024} MiB: publish large assets with dg release create`
  }
  return null
}

/** A placeholder SHA-256 (same length as a real one) for sizing an entry before hashing. */
const PLACEHOLDER_HASH = 'f'.repeat(64)
/** A CIDv1 base32 sha2-256 is 59 characters (`bafy…` / `bafk…`). */
const PLACEHOLDER_CID = `bafy${'x'.repeat(55)}`

/**
 * The asset entry `name` of `size` bytes will get once stored under `policy`, with a
 * placeholder hash: the URLs a copy records are deterministic in length, so this sizes the
 * release document (for the cost preview and the 4096-byte check) before anything uploads.
 */
export function plannedAsset(name: string, size: number, policy: StoragePolicy | null, profiles: readonly StorageProfile[]): ReleaseAsset {
  const byName = new Map(profiles.map((p) => [p.name, p]))
  const https: string[] = []
  const rest: string[] = []
  for (const t of externalTargets(policy, profiles)) {
    const s = byName.get(t)?.settings
    if (s?.kind === 's3') {
      const key = artifactKey(s, PLACEHOLDER_HASH)
      https.push(publicObjectUrl(s, key))
      rest.push(s3Uri(s, key))
    } else if (s?.kind === 'ipfs-kubo' || s?.kind === 'ipfs-pinning-service') {
      if (s.publicGateway !== '') https.push(gatewayUrl(s.publicGateway, PLACEHOLDER_CID))
      rest.push(`ipfs://${PLACEHOLDER_CID}`)
    }
  }
  let uris = [...https, ...rest]
  if (uris.length > 4) uris = uris.filter((u) => !u.startsWith('s3://'))
  return { name, sha256: PLACEHOLDER_HASH, sizeBytes: size, uris: uris.slice(0, 4) }
}

/** Why release assets have no storage of the publisher's own to go to, and where that is fixed. */
export interface ReleaseStorageGap {
  readonly reason: 'no-profiles' | 'no-default' | 'platform-only'
  /** `account`: `/settings/storage`; `repo`: this repo's Settings → Storage override. */
  readonly fix: 'account' | 'repo'
  readonly message: string
}

/** No storage of one's own at all (also what the dialog says before the settings are read). */
export const NO_STORAGE_GAP: ReleaseStorageGap = {
  reason: 'no-profiles',
  fix: 'account',
  message: 'Add storage of your own (S3 or IPFS) to attach assets: they never go to Platform.',
}

/**
 * What stops release assets for `repoId` under `config`, or null when they have somewhere to go
 * (L-10). The dialog used to say only "no storage chosen" when a profile existed but no default
 * did, which read as a bug: it now names the missing step and links to it.
 */
export function releaseStorageGap(config: StorageConfig, repoId: string): ReleaseStorageGap | null {
  const override = config.repoPolicies[repoId] ?? null
  const policy = policyForRepo(config, repoId)
  if (externalTargets(policy, config.profiles).length > 0) return null
  const own = config.profiles.filter((p) => p.settings.kind !== 'platform').map((p) => p.name)
  if (own.length === 0) return NO_STORAGE_GAP
  if (policy === null) {
    return {
      reason: 'no-default',
      fix: 'account',
      message: `You have storage (${own.join(', ')}) but no default for browser pushes: tick it under "Where browser pushes go" to attach assets.`,
    }
  }
  return override !== null
    ? { reason: 'platform-only', fix: 'repo', message: "This repo's storage choice has only Platform, and release assets never go there: choose your own storage for it." }
    : { reason: 'platform-only', fix: 'account', message: `Your default for browser pushes has only Platform, and release assets never go there: tick ${own.join(', ')} instead.` }
}

/**
 * Why these files cannot be published under `policy`, checked before any upload: no external
 * storage for them, or an asset list the release document cannot hold.
 */
export function assetPlanProblem(
  files: readonly { readonly name: string; readonly size: number }[],
  policy: StoragePolicy | null,
  profiles: readonly StorageProfile[],
  kept: readonly ReleaseAsset[] = [],
): string | null {
  if (files.length === 0) return null
  if (externalTargets(policy, profiles).length === 0) return 'choose your own storage (S3 or IPFS) for this repo first: Settings → Storage. Release assets never go to Platform.'
  try {
    releaseAssetsJson([...kept, ...files.map((f) => plannedAsset(f.name, f.size, policy, profiles))])
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/**
 * The intent of a publish: the dialog's draft token bound to a digest of the exact content, so a
 * retry of the same content finishes the same signed write, and edited content can never
 * replay a transition signed for something else.
 */
export async function releaseIntent(
  draft: string,
  input: { readonly tagName: string; readonly name: string; readonly notes: string; readonly yanked?: boolean },
  assets: readonly ReleaseAsset[],
): Promise<string> {
  const content = JSON.stringify([input.tagName, input.name, input.notes, input.yanked === true, assets.map((a) => [a.name, a.sha256, a.sizeBytes, a.uris])])
  return `${draft}:${(await sha256Hex(new TextEncoder().encode(content))).slice(0, 32)}`
}

/**
 * The current release's assets a new revision of the same tag keeps (D-504): all of them,
 * except any a new upload of the same name replaces. The newest release per tag wins, so a
 * revision that left them out (a yank, an edit of the notes) would drop the files. Returned in
 * the writer's shape, so they are written back exactly as recorded.
 */
export function carriedAssets(
  existing: { readonly assets: readonly ReleaseAssetView[] } | null,
  uploads: readonly { readonly name: string }[],
): ReleaseAsset[] {
  const replaced = new Set(uploads.map((f) => f.name))
  return (existing?.assets ?? [])
    .filter((a) => !replaced.has(a.name))
    .map((a) => ({ name: a.name, sha256: a.sha256, sizeBytes: a.size ?? 0, uris: a.uris }))
}

/** Progress of a publish. */
export type PublishEvent =
  | { readonly step: 'role' }
  /** The tag is being created (`createTag`). */
  | { readonly step: 'tag' }
  | { readonly step: 'upload'; readonly asset: string; readonly event: UploadEvent }
  | { readonly step: 'uploaded'; readonly asset: string; readonly stored: ReleaseAsset; readonly copies: number; readonly failures: readonly TargetFailure[] }
  | { readonly step: 'release' }
  /** A private repo's key moved during the upload: every file is sealed and uploaded again. */
  | { readonly step: 'resealing' }
  /** A private repo's re-run found the asset list (and files) an earlier attempt stored: nothing is uploaded (§16.5). */
  | { readonly step: 'reused' }

/** The release write failed after every asset was stored: say so, as the CLI does. */
export class ReleaseWriteError extends Error {
  constructor(
    readonly cause: unknown,
    /** The release the write named, as resolved (carried title, notes and assets included). */
    readonly resolved: ResolvedRelease,
    /** How many files this attempt uploaded (never the kept ones, nor a retry's reused ones). */
    readonly assetsStored: number,
  ) {
    super('the release was not saved')
    this.name = 'ReleaseWriteError'
  }

  /** The assets the release names (kept ones included). */
  get assets(): readonly ReleaseAsset[] {
    return this.resolved.assets
  }
}

/**
 * A release as one attempt resolved it: title and notes (the given ones, else the carried ones)
 * and every asset. A retry of an unconfirmed write passes it back as `stored` and re-signs
 * exactly it: the same content, the same intent, so a write that did land is not signed twice.
 */
export interface ResolvedRelease {
  readonly name: string
  readonly notes: string
  readonly assets: readonly ReleaseAsset[]
  /** A private repo's revision: its sealed fields and write key, re-signed as they are. */
  readonly sealed?: ResolvedSealedRelease
}

/** What a publish wrote. */
export interface Published {
  readonly release: WriteResult
  readonly assets: readonly ReleaseAsset[]
  /** What a private repo's sealed writer says once the revision is written (§16.3, §16.5). */
  readonly warnings?: readonly SealedReleaseWarning[]
  /** A private repo's objects stored under a key that moved before signing (named by nothing). */
  readonly orphaned?: readonly string[]
}

/** The sealed-only flags of a private repo's revision (§16.2, §16.3); absent ones are carried. */
export interface SealedFlags {
  readonly prerelease?: boolean
  readonly draft?: boolean
  readonly unpublished?: boolean
}

/** What {@link publishRelease} publishes. */
interface PublishInput {
  readonly tagName: string
  readonly name: string
  readonly notes: string
  readonly files: readonly { readonly name: string; readonly size: number; arrayBuffer(): Promise<ArrayBuffer> }[]
  /** The dialog's draft token; bound to the content digest here. */
  readonly draft: string
  /**
   * Assets already stored by an attempt whose release write went unconfirmed: the retry
   * writes the release with exactly these (same content, same intent: the same signed write)
   * and uploads nothing.
   */
  readonly stored?: ResolvedRelease
  /**
   * Publish it yanked (withdrawn): shown with a warning, its assets kept. A public release
   * states it (absent: not yanked); a private repo's revision carries it when absent.
   */
  readonly yanked?: boolean
  /** A private repo's sealed-only flags. */
  readonly sealed?: SealedFlags
  /**
   * Create the tag at this commit (hex) first, when it does not exist (a lightweight tag). A tag
   * that exists at another commit refuses the publish before anything uploads.
   */
  readonly createTag?: { readonly target: string }
  /**
   * The existing tag's tip as the page read it (hex). The publish reads the tip again and refuses
   * when it moved (the person chose a release of what they saw), else records it: provenance checks
   * the tag's history against it. With `createTag`, the new tag's target is recorded.
   */
  readonly tagTip?: string
}

/**
 * The tag's tip now, read fresh: what a public release records as its target. Refused when the page
 * showed another tip (`shown`): the tag moved while the form was open, and recording either would
 * mislabel the release. Undefined when the tag names nothing for sure (deleted, or two pushes race).
 */
export async function currentTagTip(sdk: EvoSDK, repo: RepoRef, tag: string, shown: string | undefined): Promise<string | undefined> {
  const { state } = await readRefNow(sdk, repo, `refs/tags/${tag}`)
  const now = state?.state === 'resolved' ? state.oid.toLowerCase() : undefined
  if (shown !== undefined && now !== shown.toLowerCase()) {
    throw new Error(`${tag} moved after this page loaded${now !== undefined ? ` (it is at ${now.slice(0, 7)} now)` : ''}. Reload the page and publish again.`)
  }
  return now
}

/** Create the tag a publish names, when asked to: once the role is known, before any upload. */
async function createTagFirst(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, input: PublishInput, onEvent?: (e: PublishEvent) => void): Promise<void> {
  if (input.createTag === undefined) return
  onEvent?.({ step: 'tag' })
  // The intent is the draft's: a retry of this publish finishes the same tag write.
  await ensureTag(sdk, auth, repo, { tag: input.tagName, target: input.createTag.target, intent: `${input.draft}:tag:${input.createTag.target}` })
}

/** Where {@link publishRelease} stores the files: the repo's browser-push policy and the user's profiles. */
interface PublishStorage {
  readonly policy: StoragePolicy | null
  readonly profiles: readonly StorageProfile[]
}

/** A sealed manifest entry as the dialog's progress shows it. */
function entryAsset(e: SealedAsset): ReleaseAsset {
  return { name: e.name, sha256: e.sha256, sizeBytes: e.sizeBytes, uris: e.uris }
}

/**
 * {@link publishRelease} for a private repo: a sealed revision ({@link createRelease} seals it,
 * `sealed-release.ts`). Checked before anything is read or uploaded: the tag, the text given, the
 * files, and storage for them.
 */
async function publishSealedRelease(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: PublishInput,
  storage: PublishStorage,
  onEvent?: (e: PublishEvent) => void,
): Promise<Published> {
  const retry = input.stored?.sealed
  const files = retry ? [] : input.files
  const problem =
    tagProblem(input.tagName) ??
    (retry ? null : (releaseTextProblem(input) ?? assetFilesProblem(files))) ??
    (files.length > 0 && externalTargets(storage.policy, storage.profiles).length === 0 ? NO_EXTERNAL_STORAGE : null)
  if (problem) throw new Error(problem)
  if (input.createTag !== undefined) {
    // The sealed writer checks the role itself, after this: a non-maintainer's tag is refused here.
    onEvent?.({ step: 'role' })
    await requireMaintainer(sdk, repo, auth.identityId, auth.network)
    await createTagFirst(sdk, auth, repo, input, onEvent)
  }
  let resolved: ResolvedSealedRelease | null = null
  let uploaded = 0
  const onSealed = (e: SealedReleaseEvent): void => {
    if (e.step === 'role' || e.step === 'upload') onEvent?.(e)
    else if (e.step === 'reused') onEvent?.({ step: 'reused' })
    else if (e.step === 'resealing') {
      uploaded = 0
      onEvent?.({ step: 'resealing' })
    } else if (e.step === 'uploaded') {
      uploaded += 1
      onEvent?.({ step: 'uploaded', asset: e.asset, stored: entryAsset(e.entry), copies: e.copies, failures: e.failures })
    } else if (e.step === 'release') {
      resolved = e.resolved
      onEvent?.({ step: 'release' })
    }
  }
  try {
    // A blank title or notes, and an absent flag, are carried from the tag's newest revision.
    const release = await createRelease(
      sdk,
      auth,
      repo,
      { tagName: input.tagName, name: input.name, notes: input.notes, yanked: input.yanked, ...input.sealed, intent: input.draft },
      { files, storage, onEvent: onSealed, resolved: retry },
    )
    const written = release.sealed
    return { release, assets: (written?.resolved.assets ?? []).map(entryAsset), warnings: written?.warnings ?? [], orphaned: written?.orphaned ?? [] }
  } catch (e) {
    // Signed (or about to be): the retry re-signs exactly this revision, uploading nothing.
    const r = resolved as ResolvedSealedRelease | null
    if (r === null) throw e
    throw new ReleaseWriteError(e, { name: r.fields.name ?? '', notes: r.fields.notes ?? '', assets: r.assets.map(entryAsset), sealed: r }, uploaded)
  }
}

/**
 * Upload every asset (each verified on the policy's external storage), then write the release.
 * Files are read one at a time. An upload failure stops before anything is written to
 * Platform; stored files stay in the user's storage (content-addressed, so a retry re-verifies
 * rather than re-uploads). A failure of the release write itself is a {@link ReleaseWriteError}.
 */
export async function publishRelease(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: PublishInput,
  storage: PublishStorage,
  onEvent?: (e: PublishEvent) => void,
): Promise<Published> {
  if (repo.visibility === 'private') return publishSealedRelease(sdk, auth, repo, input, storage, onEvent)
  const early = tagProblem(input.tagName) ?? (input.stored ? null : assetFilesProblem(input.files))
  if (early) throw new Error(early)
  onEvent?.({ step: 'role' })
  await requireMaintainer(sdk, repo, auth.identityId, auth.network)
  // The release this one supersedes, read now (never a list the page may not have loaded):
  // its assets, title and notes carry forward unless given (D-504, as `dg release create`).
  const existing = input.stored ? null : ((await readReleases(sdk, repo)).current.find((r) => r.tagName === input.tagName) ?? null)
  const name = input.stored?.name ?? (input.name || existing?.name || '')
  const typed = input.stored?.notes ?? (input.notes || existing?.notes || '')
  // New notes longer than the field are stored whole first (forge-v2.md §6.3); carried notes and a
  // retry's are the field as written before.
  const longNotes = !input.stored && input.notes !== '' && isLongBody(repo, 'release', input.notes)
  const keep = carriedAssets(existing, input.files)
  const problem =
    releaseTextProblem({ name, notes: longNotes ? '' : typed }) ??
    (input.stored ? null : (assetFilesProblem(input.files, keep) ?? assetPlanProblem(input.files, storage.policy, storage.profiles, keep)))
  if (problem) throw new Error(problem)
  const target = input.createTag?.target ?? (await currentTagTip(sdk, repo, input.tagName, input.tagTip))
  await createTagFirst(sdk, auth, repo, input, onEvent)

  // A retry of an unconfirmed write re-signs exactly what it named (kept assets included) and
  // uploads nothing; otherwise the kept assets come first, then this attempt's uploads.
  const assets: ReleaseAsset[] = input.stored ? [...input.stored.assets] : [...keep]
  let uploaded = 0
  for (const f of input.stored ? [] : input.files) {
    // One file in memory at a time.
    const bytes = new Uint8Array(await f.arrayBuffer())
    const hash = await sha256Hex(bytes)
    const stored = await storeFile(bytes, { ...storage, sha256Hex: hash, onStep: (event) => onEvent?.({ step: 'upload', asset: f.name, event }) })
    const asset: ReleaseAsset = { name: f.name, sha256: stored.sha256, sizeBytes: stored.sizeBytes, uris: stored.uris }
    assets.push(asset)
    uploaded += 1
    onEvent?.({ step: 'uploaded', asset: f.name, stored: asset, copies: stored.confirmed.length, failures: stored.failures })
  }
  onEvent?.({ step: 'release' })
  const notes = longNotes ? await longBodyField(sdk, auth, repo, 'release', typed, {}, input.draft) : typed
  const intent = await releaseIntent(input.draft, { ...input, name, notes }, assets)
  try {
    const release = await createRelease(sdk, auth, repo, {
      tagName: input.tagName,
      ...(input.yanked ? { yanked: true } : {}),
      ...(name ? { name } : {}),
      ...(notes ? { notes } : {}),
      ...(assets.length > 0 ? { assets } : {}),
      ...(target !== undefined ? { targetOid: target } : {}),
      intent,
    })
    return { release, assets }
  } catch (e) {
    throw new ReleaseWriteError(e, { name, notes, assets }, uploaded)
  }
}
