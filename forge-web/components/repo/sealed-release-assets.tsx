'use client'

/**
 * A sealed release's asset list, for a member (`docs/security/private-repos.md` §16.5): the
 * kind-4 manifest its TLV 21 names, opened with the reader's keys. A sealed asset downloads
 * verified (the sealed bytes against `sealedSha256`, opened with the key of its header's epoch,
 * truncated to its size, then the file against its `sha256`) and is saved only on a match. An
 * external link (an import whose source file could not be sealed) is marked external and not
 * verified, and opening it asks first: it contacts the source's host.
 */

import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Download, ExternalLink, FileArchive, Loader2, Lock, XCircle } from 'lucide-react'
import type { RepoRef } from '@/lib/repo'
import type { ReleaseAsset, ReleaseFields, ReleaseManifest } from '@/lib/private'
import { formatBytes, plural } from '@/lib/view'
import { urlHost } from '@/lib/view/format'
import {
  AssetHashMismatchError,
  SealedAssetCorruptError,
  browserReadable,
  directDownloadUrls,
  downloadSealedAsset,
  isSealedAsset,
  loadReleaseManifest,
  saveBytes,
  type DownloadProgress,
} from '@/lib/view/release-download'
import { useAsync, type AsyncState } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { Button } from '@/components/ui/button'
import { cn, errorMessage } from '@/lib/utils'
import { repoContractIds, repoKey } from '@/lib/repo'

/** The asset list `fields` names, read once `enabled` (null data: none named). */
export function useSealedManifest(repo: RepoRef, fields: ReleaseFields | undefined, enabled: boolean): AsyncState<ReleaseManifest> {
  const { sdk, ready } = useSdk(repoContractIds(repo))
  const keys = repo.session?.ctx.keys
  return useAsync(
    () => loadReleaseManifest(sdk!, repo, fields as ReleaseFields, keys!),
    [ready, repoKey(repo), fields?.assetManifest, fields?.tag],
    { enabled: enabled && ready && sdk !== null && keys !== undefined && fields?.assetManifest !== undefined },
  )
}

/** The rows of a sealed release's opened asset list, or why it is unavailable. */
export function SealedAssets({ repo, state, className }: { repo: RepoRef; state: AsyncState<ReleaseManifest>; className?: string }): JSX.Element {
  if (state.error !== null) {
    return (
      <p className={cn('flex items-start gap-1 text-[12px] text-caution-700 dark:text-caution-400', className)} data-testid="release-assets-unavailable">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          Asset list unavailable: {state.error}.{' '}
          <button type="button" onClick={state.reload} className="underline">
            Try again
          </button>
        </span>
      </p>
    )
  }
  const manifest = state.data
  if (manifest === null) {
    return (
      <p className={cn('flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400', className)}>
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Opening the encrypted asset list…
      </p>
    )
  }
  if (manifest.assets.length === 0) return <></>
  const external = manifest.assets.some((a) => !isSealedAsset(a))
  return (
    <div className={className}>
      <ul className="divide-y divide-anvil-100 rounded-md border border-anvil-200 dark:divide-anvil-850 dark:border-anvil-800" aria-label="Assets" data-testid="release-sealed-assets">
        {manifest.assets.map((a) =>
          isSealedAsset(a) ? <SealedAssetRow key={`${a.name}${a.sealedSha256}`} repo={repo} asset={a} /> : <ExternalAssetRow key={`${a.name}${a.uris[0]}`} asset={a} />,
        )}
      </ul>
      <p className="mt-1.5 flex items-center gap-1 text-[11px] text-anvil-500 dark:text-anvil-400">
        <Lock className="h-3 w-3 shrink-0" aria-hidden /> {plural(manifest.assets.length, 'asset')}, encrypted to this repo&apos;s members
        {external ? '; external links are not encrypted copies and are not verified' : ''}.
      </p>
    </div>
  )
}

type RowState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working'; readonly progress: DownloadProgress | null }
  | { readonly kind: 'saved' }
  | { readonly kind: 'mismatch'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string }

/** A sealed asset: downloaded, decrypted and checked in this tab, then saved. */
function SealedAssetRow({ repo, asset }: { repo: RepoRef; asset: ReleaseAsset }): JSX.Element {
  const [state, setState] = useState<RowState>({ kind: 'idle' })
  const keys = repo.session?.ctx.keys
  const readable = browserReadable(asset)
  const run = async (): Promise<void> => {
    if (keys === undefined) return
    setState({ kind: 'working', progress: null })
    try {
      const bytes = await downloadSealedAsset(asset, keys, (progress) => setState({ kind: 'working', progress }))
      saveBytes(bytes, asset.name)
      setState({ kind: 'saved' })
    } catch (e) {
      setState(e instanceof AssetHashMismatchError || e instanceof SealedAssetCorruptError ? { kind: 'mismatch', message: e.message } : { kind: 'error', message: errorMessage(e) })
    }
  }
  const bad = state.kind === 'mismatch'
  return (
    <li data-testid="release-asset" data-sealed="" data-state={readable ? state.kind : 'none'} className={cn('flex flex-wrap items-center gap-2 px-3 py-2 text-dense', bad && 'bg-danger/5')}>
      <FileArchive className={cn('h-4 w-4 shrink-0', bad ? 'text-danger-700 dark:text-danger-400' : 'text-anvil-500 dark:text-anvil-400')} aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono" title={asset.name}>
        {asset.name}
      </span>
      <span className="text-[12px] text-anvil-500 dark:text-anvil-400">{formatBytes(asset.sizeBytes)}</span>
      <span className="font-mono text-[11px] text-anvil-500 dark:text-anvil-400" title={`SHA-256 ${asset.sha256}`}>
        sha256 {asset.sha256.slice(0, 10)}…
      </span>
      {readable ? (
        <Button size="sm" onClick={() => void run()} disabled={state.kind === 'working' || bad || keys === undefined} aria-label={`Download ${asset.name}`}>
          {state.kind === 'working' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />}
          Download
        </Button>
      ) : null}
      <p role="status" className="basis-full text-[12px]">
        {!readable ? (
          <span className="text-caution-700 dark:text-caution-400">
            No copy is at an address a browser may download from. Use <span className="font-mono">dg release download</span> with a storage profile for its host.
          </span>
        ) : state.kind === 'working' ? (
          <span className="text-anvil-500 dark:text-anvil-400">
            Checking and decrypting as it downloads
            {state.progress ? ` · ${formatBytes(state.progress.bytes)}${state.progress.total ? ` of ${formatBytes(state.progress.total)}` : ''}` : ''}
          </span>
        ) : state.kind === 'saved' ? (
          <span className="inline-flex items-center gap-1 text-verify-700 dark:text-verify-400">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Verified: decrypted, and the SHA-256 matched. Saved.
          </span>
        ) : state.kind === 'mismatch' ? (
          <span className="inline-flex items-center gap-1 font-medium text-danger-700 dark:text-danger-400">
            <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden /> Failed: {state.message}. Not saved.
          </span>
        ) : state.kind === 'error' ? (
          <span className="inline-flex items-center gap-1 text-caution-700 dark:text-caution-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden /> Couldn&apos;t download in the browser: {state.message}
          </span>
        ) : null}
      </p>
    </li>
  )
}

/**
 * An external link (§16.5): the source's file, never sealed here, so neither encrypted nor
 * verified. Its address is inside the sealed list, so opening it is the first time the source's
 * host hears of this reader: asked first.
 */
function ExternalAssetRow({ asset }: { asset: ReleaseAsset }): JSX.Element {
  const [asking, setAsking] = useState(false)
  const urls = directDownloadUrls(asset)
  return (
    <li data-testid="release-asset" data-state="external" className="flex flex-wrap items-center gap-2 px-3 py-2 text-dense">
      <FileArchive className="h-4 w-4 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono" title={asset.name}>
        {asset.name}
      </span>
      {asset.sizeBytes > 0 ? <span className="text-[12px] text-anvil-500 dark:text-anvil-400">{formatBytes(asset.sizeBytes)}</span> : null}
      <span className="text-[11px] font-medium text-caution-700 dark:text-caution-400">external · not verified</span>
      {urls.length > 0 ? (
        <Button size="sm" variant="ghost" onClick={() => setAsking((a) => !a)} aria-expanded={asking} aria-label={`Open ${asset.name} at its source`}>
          <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Open at source
        </Button>
      ) : null}
      {asking ? (
        <div role="note" className="basis-full space-y-1 rounded-md border border-caution/30 bg-caution/5 px-2.5 py-2 text-[12px] text-caution-700 dark:text-caution-400">
          <p className="flex items-start gap-1">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              This file is not an encrypted copy: opening it contacts its source&apos;s host, which then learns someone is downloading it, and this page can&apos;t check what it serves.
            </span>
          </p>
          <p className="flex flex-wrap gap-x-3">
            {urls.map((u) => (
              <a key={u} href={u} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="font-medium underline">
                Open at {urlHost(u)}
              </a>
            ))}
          </p>
        </div>
      ) : urls.length === 0 ? (
        <p className="basis-full text-[12px] text-anvil-500 dark:text-anvil-400">No address a browser may open is recorded for it.</p>
      ) : null}
    </li>
  )
}
