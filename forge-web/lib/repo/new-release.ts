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
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { Network } from '../constants'
import type { WriteAuth, WriteResult } from '../sdk'
import {
  artifactKey,
  externalTargets,
  storeFile,
  type StoragePolicy,
  type StorageProfile,
  type TargetFailure,
  type UploadEvent,
} from '../storage'
import { gatewayUrl } from '../storage/ipfs'
import { publicObjectUrl, s3Uri } from '../storage/s3'
import { sha256Hex } from '../storage/sigv4'
import type { RepoRef } from './contract'
import { invalidateMembers, readViewerPermissions } from './members'
import { createRelease, releaseAssetsJson, type ReleaseAsset } from './writes'

/** The `release` schema's limits (forge-core `release`: `maxLength` characters, `maxBytes`). */
export const RELEASE_LIMITS = {
  tagName: { chars: 63, bytes: 63 },
  name: { chars: 120, bytes: 480 },
  notes: { chars: 5120, bytes: 5120 },
} as const

/** The largest single asset the browser reads into memory; bigger ones go through the CLI. */
export const MAX_ASSET_BYTES = 256 * 1024 * 1024
/** The web reader refuses longer asset names (`parseReleaseAssets`). */
export const MAX_ASSET_NAME = 255

const utf8 = (s: string): number => new TextEncoder().encode(s).length
const chars = (s: string): number => [...s].length

function fits(field: string, s: string, limit: { chars: number; bytes: number }): string | null {
  if (chars(s) > limit.chars) return `${field} holds at most ${limit.chars} characters`
  if (utf8(s) > limit.bytes) return `${field} holds at most ${limit.bytes} bytes (accented letters and emoji take more than one)`
  return null
}

/** Why `tag` cannot name a release, or null (git's `check-ref-format` rules for a tag). */
/** Why a private repo's release takes no assets (parity with `dg release`). */
export const PRIVATE_ASSETS_REFUSED = 'release assets cannot be attached to a private repo: they would be uploaded unencrypted'

export function tagProblem(tag: string): string | null {
  if (tag === '') return 'a tag is needed (e.g. v1.0.0)'
  const size = fits('a tag', tag, RELEASE_LIMITS.tagName)
  if (size) return size
  const bad =
    /[\s~^:?*[\\\x00-\x1f\x7f]/.test(tag) ||
    tag.includes('..') ||
    tag.includes('@{') ||
    tag === '@' ||
    tag.includes('//') ||
    /^[-/]|\/$|\.$/.test(tag) ||
    /(^|\/)\./.test(tag) ||
    /\.lock(\/|$)/.test(tag)
  return bad ? 'that is not a valid git tag name' : null
}

/** Why the release text does not fit its document, or null. */
export function releaseTextProblem(input: { name: string; notes: string }): string | null {
  return fits('the title', input.name, RELEASE_LIMITS.name) ?? fits('the notes', input.notes, RELEASE_LIMITS.notes)
}

/** C0 controls, DEL, bidi embeddings/overrides/isolates, LRM/RLM and ALM: they disguise a name. */
const DISGUISING = /[\u0000-\u001f\u007f‪-‮⁦-⁩‎‏؜]/

/** Why a set of asset files cannot be published, or null. */
export function assetFilesProblem(files: readonly { readonly name: string; readonly size: number }[]): string | null {
  const names = files.map((f) => f.name)
  if (new Set(names).size !== names.length) return 'two assets have the same name'
  for (const f of files) {
    if (f.name === '' || f.name.includes('/') || f.name.includes('\\') || f.name === '.' || f.name === '..') return 'an asset name must be a plain file name'
    // Control and text-direction characters disguise a file name.
    if (DISGUISING.test(f.name)) return `${f.name}: the name holds control or text-direction characters`
    // UTF-16 length, as the reader's zod `.max(255)` counts it.
    if (f.name.length > MAX_ASSET_NAME) return `${f.name.slice(0, 40)}…: asset names hold at most ${MAX_ASSET_NAME} characters`
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

/**
 * Why these files cannot be published under `policy`, checked before any upload: no external
 * storage for them, or an asset list the release document cannot hold.
 */
export function assetPlanProblem(files: readonly { readonly name: string; readonly size: number }[], policy: StoragePolicy | null, profiles: readonly StorageProfile[]): string | null {
  if (files.length === 0) return null
  if (externalTargets(policy, profiles).length === 0) return 'choose your own storage (S3 or IPFS) for this repo first: Settings → Storage. Release assets never go to Platform.'
  try {
    releaseAssetsJson(files.map((f) => plannedAsset(f.name, f.size, policy, profiles)))
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
  input: { readonly tagName: string; readonly name: string; readonly notes: string },
  assets: readonly ReleaseAsset[],
): Promise<string> {
  const content = JSON.stringify([input.tagName, input.name, input.notes, assets.map((a) => [a.name, a.sha256, a.sizeBytes, a.uris])])
  return `${draft}:${(await sha256Hex(new TextEncoder().encode(content))).slice(0, 32)}`
}

/** Progress of a publish. */
export type PublishEvent =
  | { readonly step: 'role' }
  | { readonly step: 'upload'; readonly asset: string; readonly event: UploadEvent }
  | { readonly step: 'uploaded'; readonly asset: string; readonly stored: ReleaseAsset; readonly copies: number; readonly failures: readonly TargetFailure[] }
  | { readonly step: 'release' }

/** The release write failed after every asset was stored: say so, as the CLI does. */
export class ReleaseWriteError extends Error {
  constructor(
    readonly cause: unknown,
    /** The assets stored for this release: a retry writes the release with exactly these. */
    readonly assets: readonly ReleaseAsset[],
  ) {
    super('the release document was not written')
    this.name = 'ReleaseWriteError'
  }

  get assetsStored(): number {
    return this.assets.length
  }
}

/**
 * Re-read the signer's role, uncached (the CLI's `require_role` before uploading): a maintainer
 * revoked since the page loaded must not upload for a write consensus will refuse.
 */
export async function requireMaintainer(sdk: EvoSDK, repo: RepoRef, identityId: string, network: Network): Promise<void> {
  invalidateMembers(repo, network)
  const holdings = await readViewerPermissions(sdk, repo, identityId, network)
  if (holdings === null) throw new Error("couldn't read this repo's members to confirm you are a maintainer; try again")
  if (!holdings.maintain) throw new Error('you are no longer a maintainer of this repo: only maintainers can publish releases')
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
  input: {
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
    readonly stored?: readonly ReleaseAsset[]
  },
  storage: { readonly policy: StoragePolicy | null; readonly profiles: readonly StorageProfile[] },
  onEvent?: (e: PublishEvent) => void,
): Promise<{ readonly release: WriteResult; readonly assets: readonly ReleaseAsset[] }> {
  // A private repo's release assets would be uploaded unencrypted: refused, as `dg release` does.
  if (repo.visibility === 'private' && (input.files.length > 0 || (input.stored?.length ?? 0) > 0)) {
    throw new Error(PRIVATE_ASSETS_REFUSED)
  }
  const problem =
    tagProblem(input.tagName) ??
    releaseTextProblem(input) ??
    (input.stored ? null : assetFilesProblem(input.files) ?? assetPlanProblem(input.files, storage.policy, storage.profiles))
  if (problem) throw new Error(problem)
  onEvent?.({ step: 'role' })
  await requireMaintainer(sdk, repo, auth.identityId, auth.network)

  const assets: ReleaseAsset[] = input.stored ? [...input.stored] : []
  for (const f of input.stored ? [] : input.files) {
    // One file in memory at a time.
    const bytes = new Uint8Array(await f.arrayBuffer())
    const hash = await sha256Hex(bytes)
    const stored = await storeFile(bytes, { ...storage, sha256Hex: hash, onStep: (event) => onEvent?.({ step: 'upload', asset: f.name, event }) })
    const asset: ReleaseAsset = { name: f.name, sha256: stored.sha256, sizeBytes: stored.sizeBytes, uris: stored.uris }
    assets.push(asset)
    onEvent?.({ step: 'uploaded', asset: f.name, stored: asset, copies: stored.confirmed.length, failures: stored.failures })
  }
  onEvent?.({ step: 'release' })
  const intent = await releaseIntent(input.draft, input, assets)
  try {
    const release = await createRelease(sdk, auth, repo, {
      tagName: input.tagName,
      ...(input.name ? { name: input.name } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
      ...(assets.length > 0 ? { assets } : {}),
      intent,
    })
    return { release, assets }
  } catch (e) {
    throw new ReleaseWriteError(e, assets)
  }
}
