'use client'

/**
 * Releases (`ux-dx-spec.md` §5.9): the newest `release` per tag, with superseded revisions
 * listed as "previous", and one release's page. "Published by <maintainer>" is always shown:
 * a revoked maintainer can still delete their own release. Every asset download is streamed
 * through SHA-256 and saved only on a match; a mismatch turns the row red and nothing is
 * saved.
 *
 * A maintainer publishes one from the header ({@link NewReleaseButton}): assets go to their own
 * storage, hashed and verified, then one `release` document names them.
 */

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, Download, FileArchive, Loader2, Tag, XCircle } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { formatBytes, plural, timeAgo } from '@/lib/view'
import type { ReleaseAssetView, ReleaseView } from '@/lib/repo'
import {
  AssetHashMismatchError,
  browserReadable,
  checkDownloadedFile,
  directDownloadUrls,
  downloadVerifiedAsset,
  type DownloadedFileCheck,
  saveBytes,
  type DownloadProgress,
} from '@/lib/view/release-download'
import { urlHost } from '@/lib/view/format'
import { NOT_VERIFIED_YET, UNVERIFIABLE_ASSET, assetVerifiable, importedAssetUrl, type OmittedAssets } from '@/lib/repo/releases'
import { useReleases } from '@/hooks/use-repo-chrome'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { Author } from '@/components/author'
import { MarkdownView } from '@/components/markdown-view'
import { Button } from '@/components/ui/button'
import { CopyLinkButton } from '@/components/ui/copy-link'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { NewReleaseButton } from '@/components/repo/new-release'
import { useSdk } from '@/hooks/use-sdk'
import { invalidateSessionCache } from '@/lib/view/session-cache'
import { repoKey } from '@/lib/repo'
import { errorMessage, cn } from '@/lib/utils'

export function ReleasesContent({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const { data, error, reload } = useReleases(home.repo)
  const [showPrevious, setShowPrevious] = useState(false)
  const { network } = useSdk()
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])
  // After a publish the node answering may be a block behind: re-read a few times.
  const refreshAfterPublish = (): void => {
    timers.current.forEach(clearTimeout)
    timers.current = [0, 3000, 8000].map((delay) =>
      setTimeout(() => {
        invalidateSessionCache(`releases:${network}:${repoKey(home.repo)}`)
        reload()
      }, delay),
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl">Releases</h1>
        <div className="ml-auto flex items-center gap-2">
          <CopyLinkButton repo={addr} target={{ kind: 'releases' }} />
          <NewReleaseButton home={home} releases={data} onPublished={refreshAfterPublish} />
        </div>
      </div>
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : data === null ? (
        <LoadingBlock label="Reading releases" />
      ) : data.current.length === 0 ? (
        <EmptyState
          icon={Tag}
          title="No releases yet"
          body="A maintainer publishes one with dg release create --tag v1 --asset ./dist/app.tar.gz."
        />
      ) : (
        <>
          <ul className="space-y-3">
            {data.current.map((r) => (
              <li key={r.id}>
                <ReleaseCard release={r} addr={addr} />
              </li>
            ))}
          </ul>
          {data.previous.length > 0 ? (
            <section aria-label="Previous revisions">
              <button
                type="button"
                onClick={() => setShowPrevious((s) => !s)}
                aria-expanded={showPrevious}
                className="text-dense text-anvil-600 underline dark:text-anvil-300"
              >
                {showPrevious ? 'Hide' : 'Show'} {plural(data.previous.length, 'previous revision')}
              </button>
              {showPrevious ? (
                <ul className="mt-2 space-y-3">
                  {data.previous.map((r) => (
                    <li key={r.id}>
                      <ReleaseCard release={r} addr={addr} previous />
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </>
      )}
    </div>
  )
}

export function ReleaseContent({ home, addr, tag }: { home: RepoHome; addr: RepoAddress; tag: string }): JSX.Element {
  const { data, error, reload } = useReleases(home.repo)
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (data === null) return <LoadingBlock label="Reading releases" />
  const release = data.current.find((r) => r.tagName === tag)
  const previous = data.previous.filter((r) => r.tagName === tag)
  if (release === undefined) {
    return (
      <EmptyState
        icon={Tag}
        title="Release not found"
        body={`No release is published for ${tag}.`}
        action={
          <Link href={repoHref('/repo/releases', addr)}>
            <Button variant="primary">All releases</Button>
          </Link>
        }
      />
    )
  }
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href={repoHref('/repo/releases', addr)} className="text-dense text-anvil-600 underline dark:text-anvil-300">
        ← All releases
      </Link>
      <ReleaseCard release={release} addr={addr} full />
      {previous.length > 0 ? (
        <section aria-label="Previous revisions" className="space-y-3">
          <h2 className="text-prose">Previous revisions of {tag}</h2>
          {previous.map((r) => (
            <ReleaseCard key={r.id} release={r} addr={addr} previous />
          ))}
        </section>
      ) : null}
    </div>
  )
}

function ReleaseCard({
  release: r,
  addr,
  previous = false,
  full = false,
}: {
  release: ReleaseView
  addr: RepoAddress
  previous?: boolean
  full?: boolean
}): JSX.Element {
  return (
    <article
      data-testid="release"
      className={cn(
        'rounded-lg border bg-white p-4 dark:bg-anvil-900',
        previous ? 'border-dashed border-anvil-300 dark:border-anvil-700' : 'border-anvil-200 dark:border-anvil-750',
      )}
    >
      <header className="flex flex-wrap items-center gap-2">
        <Tag className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />
        <Link
          href={repoHref('/repo/release', addr, { tag: r.tagName })}
          className="hit-area font-mono text-prose font-semibold text-anvil-900 hover:text-forge-800 dark:text-anvil-50 dark:hover:text-forge-400"
        >
          {r.tagName}
        </Link>
        {r.name ? <span className="text-prose text-anvil-700 dark:text-anvil-200">{r.name}</span> : null}
        {previous ? (
          <span className="rounded bg-anvil-100 px-1.5 text-[11px] uppercase text-anvil-600 dark:bg-anvil-800 dark:text-anvil-300">previous</span>
        ) : null}
        {r.yanked ? (
          <span className="inline-flex items-center gap-1 rounded bg-caution/10 px-1.5 text-[11px] uppercase text-caution-700 dark:text-caution-400">
            <AlertTriangle className="h-3 w-3" aria-hidden /> yanked
          </span>
        ) : null}
        {full ? <CopyLinkButton repo={addr} target={{ kind: 'release', tag: r.tagName }} className="ml-auto" /> : null}
      </header>
      <p className="mt-1 flex flex-wrap items-center gap-1 text-[12px] text-anvil-600 dark:text-anvil-300">
        Published by <Author identityId={r.publisher} /> · {timeAgo(r.createdAt)}
      </p>
      {r.notesBody && (full || !previous) ? (
        <div className={cn('mt-3 text-prose', !full && 'line-clamp-6')}>
          <MarkdownView source={r.notesBody} images="auto" />
        </div>
      ) : null}
      {r.assets.length > 0 ? (
        <ul className="mt-3 divide-y divide-anvil-100 rounded-md border border-anvil-200 dark:divide-anvil-850 dark:border-anvil-800" aria-label="Assets">
          {r.assets.map((a) => (
            <AssetRow key={`${a.name}${a.sha256}`} asset={a} />
          ))}
        </ul>
      ) : null}
      {r.omitted ? <OmittedAssetsNote omitted={r.omitted} /> : null}
      {r.badAssets > 0 ? (
        <p className="mt-2 text-[12px] text-caution-700 dark:text-caution-400">
          {plural(r.badAssets, 'asset entry', 'asset entries')} {r.badAssets === 1 ? 'is' : 'are'} unreadable and not shown.
        </p>
      ) : null}
    </article>
  )
}

/**
 * An imported release whose source has more assets than a release lists (4,096 bytes of them):
 * how many are not mirrored here, and where the originals are. forge-import kept the checksum
 * files, signatures and common platform builds first.
 */
export function OmittedAssetsNote({ omitted }: { omitted: OmittedAssets }): JSX.Element {
  return (
    <p data-testid="release-assets-omitted" className="mt-2 flex flex-wrap items-center gap-x-1 text-[12px] text-caution-700 dark:text-caution-400">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        {plural(omitted.count, 'more asset')} not mirrored ({omitted.total - omitted.count} of {omitted.total} listed here).
      </span>
      {omitted.sourceUrl ? (
        <a href={omitted.sourceUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="font-medium underline">
          All assets at {urlHost(omitted.sourceUrl)}
        </a>
      ) : null}
    </p>
  )
}

/**
 * How this page can offer an asset. `unverified`: an IMPORTED asset with no recorded hash yet
 * (the import's hashing budget ran out; a later run records it), known by its URL being a
 * GitHub or GitLab release download ({@link importedAssetUrl}; never by text in the notes, which
 * any publisher writes): linked there, marked not verified. `unverifiable`: any other asset with no recorded hash
 * (D-517): never handed out, so a release published here can never offer an unchecked file. `browser`: the page reads it
 * and verifies as it downloads. `origin`: only a host that sends no CORS header has it (GitHub and
 * GitLab release downloads, L-13), so the page links to it and the hash check is a step on the
 * downloaded file. `none`: no copy this browser may fetch at all (a private address, plain http,
 * an IPFS CID with no gateway).
 */
type AssetAccess = 'unverified' | 'unverifiable' | 'browser' | 'origin' | 'none'

function assetAccess(asset: ReleaseAssetView): AssetAccess {
  const linkable = directDownloadUrls(asset).length > 0
  if (!assetVerifiable(asset)) return asset.uris.some(importedAssetUrl) && linkable ? 'unverified' : 'unverifiable'
  if (browserReadable(asset)) return 'browser'
  return linkable ? 'origin' : 'none'
}

type AssetState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working'; readonly progress: DownloadProgress | null }
  | { readonly kind: 'saved' }
  | { readonly kind: 'mismatch'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string }

/** One asset of a release: how this page can offer it, and the download or its fallback. */
export function AssetRow({ asset }: { asset: ReleaseAssetView }): JSX.Element {
  const [state, setState] = useState<AssetState>({ kind: 'idle' })
  const run = async (): Promise<void> => {
    setState({ kind: 'working', progress: null })
    try {
      const bytes = await downloadVerifiedAsset(asset, (progress) => setState({ kind: 'working', progress }))
      saveBytes(bytes, asset.name)
      setState({ kind: 'saved' })
    } catch (e) {
      setState(
        e instanceof AssetHashMismatchError
          ? { kind: 'mismatch', message: e.message }
          : { kind: 'error', message: errorMessage(e) },
      )
    }
  }
  const bad = state.kind === 'mismatch'
  const access = assetAccess(asset)
  const unhashed = access === 'unverifiable' || access === 'unverified'
  return (
    <li
      data-testid="release-asset"
      data-state={access === 'browser' ? state.kind : access}
      className={cn('flex flex-wrap items-center gap-2 px-3 py-2 text-dense', bad && 'bg-danger/5')}
    >
      <FileArchive className={cn('h-4 w-4 shrink-0', bad ? 'text-danger-700 dark:text-danger-400' : 'text-anvil-500 dark:text-anvil-400')} aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono">{asset.name}</span>
      {asset.size !== null ? <span className="text-[12px] text-anvil-500 dark:text-anvil-400">{formatBytes(asset.size)}</span> : null}
      {unhashed ? (
        <span className="text-[11px] font-medium text-caution-700 dark:text-caution-400">
          {access === 'unverified' ? 'not verified yet' : 'no sha256 recorded'}
        </span>
      ) : (
        <span className="font-mono text-[11px] text-anvil-500 dark:text-anvil-400" title={`SHA-256 ${asset.sha256}`}>
          sha256 {asset.sha256.slice(0, 10)}…
        </span>
      )}
      {access === 'browser' ? (
        <Button size="sm" onClick={() => void run()} disabled={state.kind === 'working' || bad} aria-label={`Download ${asset.name}`}>
          {state.kind === 'working' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />}
          Download
        </Button>
      ) : access === 'origin' || access === 'unverified' ? (
        <OriginLinks asset={asset} primary />
      ) : null}
      {access === 'browser' ? (
        <p role="status" className="basis-full text-[12px]">
          {state.kind === 'working' ? (
            <span className="text-anvil-500 dark:text-anvil-400">
              Checking SHA-256 as it downloads
              {state.progress ? ` · ${formatBytes(state.progress.bytes)}${state.progress.total ? ` of ${formatBytes(state.progress.total)}` : ''}` : ''}
            </span>
          ) : state.kind === 'saved' ? (
            <span className="inline-flex items-center gap-1 text-verify-700 dark:text-verify-400">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Verified: the SHA-256 matched, saved.
            </span>
          ) : state.kind === 'mismatch' ? (
            <span className="inline-flex items-center gap-1 font-medium text-danger-700 dark:text-danger-400">
              <XCircle className="h-3.5 w-3.5" aria-hidden /> Failed: {state.message}. Not saved.
            </span>
          ) : state.kind === 'error' ? (
            <span className="inline-flex items-center gap-1 text-caution-700 dark:text-caution-400">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Couldn&apos;t download in the browser: {state.message}
            </span>
          ) : null}
        </p>
      ) : access === 'none' ? (
        <p role="status" className="basis-full text-[12px] text-caution-700 dark:text-caution-400">
          <span className="inline-flex items-start gap-1">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              No copy of this asset is at an address a browser may download from (a public https URL, or an IPFS CID with a gateway). Use{' '}
              <span className="font-mono">dg release download</span> with a storage profile for its host.
            </span>
          </span>
        </p>
      ) : unhashed ? (
        <p role="status" className="basis-full text-[12px] text-caution-700 dark:text-caution-400">
          <span className="inline-flex items-start gap-1">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{' '}
            {access === 'unverified' ? NOT_VERIFIED_YET : UNVERIFIABLE_ASSET}
          </span>
        </p>
      ) : (
        <p role="status" className="basis-full text-[12px] text-anvil-500 dark:text-anvil-400">
          {urlHost(directDownloadUrls(asset)[0] ?? '')} doesn&apos;t let pages read its files, so the download comes straight from it and is not checked yet.
        </p>
      )}
      {access === 'origin' ? <DirectDownload asset={asset} linksShown /> : null}
      {access === 'browser' && state.kind === 'error' ? <DirectDownload asset={asset} /> : null}
    </li>
  )
}

/** Links that download an asset straight from where it is stored (the browser saves it). */
function OriginLinks({ asset, primary = false }: { asset: ReleaseAssetView; primary?: boolean }): JSX.Element {
  return (
    <>
      {directDownloadUrls(asset).map((u) =>
        primary ? (
          <a
            key={u}
            href={u}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
            aria-label={`Download ${asset.name} from ${urlHost(u)}`}
            className="inline-flex items-center gap-1 rounded-md border border-anvil-300 px-2.5 py-1 text-dense font-medium text-anvil-800 hover:bg-anvil-100 dark:border-anvil-700 dark:text-anvil-100 dark:hover:bg-anvil-800"
          >
            <Download className="h-3.5 w-3.5" aria-hidden /> Download from {urlHost(u)}
          </a>
        ) : (
          <a key={u} href={u} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="font-mono text-forge-700 underline dark:text-forge-400">
            {urlHost(u)}
          </a>
        ),
      )}
    </>
  )
}

/**
 * The fallback when this page cannot read an asset itself (D-056): many hosts, GitHub's release
 * downloads among them, send no CORS header, so the page may link to the file but not fetch
 * it. The browser downloads it from the origin directly, and the person can then check the
 * downloaded file against the published SHA-256 here, locally.
 */
function DirectDownload({ asset, linksShown = false }: { asset: ReleaseAssetView; linksShown?: boolean }): JSX.Element | null {
  const urls = directDownloadUrls(asset)
  const [check, setCheck] = useState<DownloadedFileCheck | 'checking' | 'unreadable' | null>(null)
  const latest = useRef(0)
  if (urls.length === 0) return null
  const pick = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    const token = ++latest.current // a slower earlier pick must not overwrite a later one
    setCheck('checking')
    try {
      const result = await checkDownloadedFile(file, asset)
      if (latest.current === token) setCheck(result)
    } catch {
      if (latest.current === token) setCheck('unreadable')
    }
  }
  return (
    <div className="basis-full space-y-1 text-[12px] text-anvil-600 dark:text-anvil-300" data-testid="direct-download">
      {linksShown ? null : (
        <p className="flex flex-wrap items-center gap-x-2">
          Download from the origin instead:
          <OriginLinks asset={asset} />
        </p>
      )}
      <label className="inline-flex cursor-pointer items-center gap-1.5">
        <span className="underline">Check a downloaded file</span>
        <span>against the published SHA-256 (read in this tab, not uploaded)</span>
        <input
          type="file"
          className="sr-only"
          onChange={(e) => {
            void pick(e.target.files?.[0])
            e.target.value = '' // picking the same file again still checks it
          }}
        />
      </label>
      {check === 'checking' ? (
        <p>Checking…</p>
      ) : check === 'unreadable' ? (
        <p className="text-caution-700 dark:text-caution-400">That file could not be read.</p>
      ) : check?.kind === 'match' ? (
        <p className="inline-flex items-center gap-1 text-verify-700 dark:text-verify-400">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Verified: the file matches the published SHA-256.
        </p>
      ) : check ? (
        <p className="inline-flex items-center gap-1 font-medium text-danger-700 dark:text-danger-400">
          <XCircle className="h-3.5 w-3.5" aria-hidden />
          {check.kind === 'wrong-size'
            ? `Does not match: it is ${check.size.toLocaleString('en-US')} bytes (${formatBytes(check.size)}), not the published ${check.want.toLocaleString('en-US')} bytes (${formatBytes(check.want)}).`
            : `Does not match: its SHA-256 is ${check.sha256.slice(0, 12)}…, not ${asset.sha256.slice(0, 12)}….`}{' '}
          Do not use it.
        </p>
      ) : null}
    </div>
  )
}
