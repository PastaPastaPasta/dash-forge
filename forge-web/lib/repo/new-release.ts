/**
 * Publishing a release from the browser (`ux-dx-spec.md` §5.9, parity with `dg release create
 * --asset`): each asset is uploaded to the publisher's own storage, verified, and recorded as
 * `{name, sha256, sizeBytes, uris}`; then one `release` document (maintainers only, at
 * consensus) names them. A newer release for the same tag supersedes the older one.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { WriteAuth, WriteResult } from '../sdk'
import { storeFile, type StoragePolicy, type StorageProfile, type UploadEvent } from '../storage'
import type { V2RepoRef } from './contract'
import { RELEASE_ASSETS_MAX_BYTES, createRelease, type ReleaseAsset } from './writes'

/** The `release` schema's limits (forge-core `release`). */
export const RELEASE_LIMITS = { tagName: 63, name: 480, notes: 5120 } as const

const utf8 = (s: string): number => new TextEncoder().encode(s).length

/** A git tag name a release can carry (the ref-name rules git applies, kept simple). */
export function tagProblem(tag: string): string | null {
  if (tag === '') return 'a tag is needed (e.g. v1.0.0)'
  if (utf8(tag) > RELEASE_LIMITS.tagName) return `a tag holds at most ${RELEASE_LIMITS.tagName} bytes`
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(tag) || tag.includes('..') || tag.includes('@{') || /^[-/.]|[/.]$|\.lock$/.test(tag)) return 'that is not a valid git tag name'
  return null
}

/** Why the release text does not fit its document, or null. */
export function releaseTextProblem(input: { name: string; notes: string }): string | null {
  if (utf8(input.name) > RELEASE_LIMITS.name) return `the title holds at most ${RELEASE_LIMITS.name} bytes`
  if (utf8(input.notes) > RELEASE_LIMITS.notes) return `the notes hold at most ${RELEASE_LIMITS.notes} bytes`
  return null
}

/** Why a set of asset names cannot be published, or null. */
export function assetNamesProblem(names: readonly string[]): string | null {
  if (new Set(names).size !== names.length) return 'two assets have the same name'
  if (names.some((n) => n === '' || n.includes('/') || n.includes('\\') || n === '.' || n === '..')) return 'an asset name must be a plain file name'
  return null
}

/** The `assets` JSON for `assets`, or an error when it exceeds the document's 4096 bytes. */
export function assetsJson(assets: readonly ReleaseAsset[]): string {
  const json = JSON.stringify(assets)
  if (utf8(json) > RELEASE_ASSETS_MAX_BYTES) {
    throw new Error(`the asset list takes ${utf8(json)} bytes and a release holds ${RELEASE_ASSETS_MAX_BYTES}: use fewer assets, or shorter names and URLs`)
  }
  return json
}

/** One file to attach. */
export interface AssetFile {
  readonly name: string
  readonly bytes: Uint8Array
}

/** Progress of a publish: which step and which asset. */
export type PublishEvent =
  | { readonly step: 'upload'; readonly asset: string; readonly event: UploadEvent }
  | { readonly step: 'uploaded'; readonly asset: string; readonly stored: ReleaseAsset }
  | { readonly step: 'release' }

/**
 * Upload every asset (each verified on the policy's external storage), then write the release.
 * An upload failure stops before anything is written to Platform; the uploaded files stay in
 * the user's storage (content-addressed, so a retry re-verifies rather than re-uploads).
 */
export async function publishRelease(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: V2RepoRef,
  input: { readonly tagName: string; readonly name: string; readonly notes: string; readonly files: readonly AssetFile[]; readonly intent?: string },
  storage: { readonly policy: StoragePolicy | null; readonly profiles: readonly StorageProfile[] },
  onEvent?: (e: PublishEvent) => void,
): Promise<{ readonly release: WriteResult; readonly assets: readonly ReleaseAsset[] }> {
  const tag = tagProblem(input.tagName) ?? releaseTextProblem(input) ?? assetNamesProblem(input.files.map((f) => f.name))
  if (tag) throw new Error(tag)
  const assets: ReleaseAsset[] = []
  for (const f of input.files) {
    const stored = await storeFile(f.bytes, { ...storage, onStep: (event) => onEvent?.({ step: 'upload', asset: f.name, event }) })
    const asset: ReleaseAsset = { name: f.name, sha256: stored.sha256, sizeBytes: stored.sizeBytes, uris: stored.uris }
    assets.push(asset)
    onEvent?.({ step: 'uploaded', asset: f.name, stored: asset })
  }
  assetsJson(assets)
  onEvent?.({ step: 'release' })
  const release = await createRelease(sdk, auth, repo, {
    tagName: input.tagName,
    ...(input.name ? { name: input.name } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    ...(assets.length > 0 ? { assets } : {}),
    ...(input.intent ? { intent: input.intent } : {}),
  })
  return { release, assets }
}
