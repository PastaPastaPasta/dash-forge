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

import { useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, Download, FileArchive, Loader2, Tag, XCircle } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { formatBytes, timeAgo } from '@/lib/view'
import type { ReleaseAssetView, ReleaseView } from '@/lib/repo'
import { AssetHashMismatchError, downloadVerifiedAsset, saveBytes, type DownloadProgress } from '@/lib/view/release-download'
import { useReleases } from '@/hooks/use-repo-chrome'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { Author } from '@/components/author'
import { MarkdownView } from '@/components/markdown-view'
import { Button } from '@/components/ui/button'
import { CopyLinkButton } from '@/components/ui/copy-link'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { NewReleaseButton } from '@/components/repo/new-release'
import { errorMessage, cn } from '@/lib/utils'

export function ReleasesContent({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const { data, error, reload } = useReleases(home.repo)
  const [showPrevious, setShowPrevious] = useState(false)

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl">Releases</h1>
        <div className="ml-auto flex items-center gap-2">
          <CopyLinkButton repo={addr} target={{ kind: 'releases' }} />
          <NewReleaseButton home={home} onPublished={reload} />
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
                {showPrevious ? 'Hide' : 'Show'} {data.previous.length} previous{' '}
                {data.previous.length === 1 ? 'revision' : 'revisions'}
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
        <Tag className="h-4 w-4 text-anvil-400" aria-hidden />
        <Link
          href={repoHref('/repo/release', addr, { tag: r.tagName })}
          className="font-mono text-prose font-semibold text-anvil-900 hover:text-forge-600 dark:text-anvil-50 dark:hover:text-forge-400"
        >
          {r.tagName}
        </Link>
        {r.name ? <span className="text-prose text-anvil-700 dark:text-anvil-200">{r.name}</span> : null}
        {previous ? (
          <span className="rounded bg-anvil-100 px-1.5 text-[11px] uppercase text-anvil-600 dark:bg-anvil-800 dark:text-anvil-300">previous</span>
        ) : null}
        {r.yanked ? (
          <span className="inline-flex items-center gap-1 rounded bg-caution/10 px-1.5 text-[11px] uppercase text-caution-700 dark:text-caution">
            <AlertTriangle className="h-3 w-3" aria-hidden /> yanked
          </span>
        ) : null}
        {full ? <CopyLinkButton repo={addr} target={{ kind: 'release', tag: r.tagName }} className="ml-auto" /> : null}
      </header>
      <p className="mt-1 flex flex-wrap items-center gap-1 text-[12px] text-anvil-600 dark:text-anvil-300">
        Published by <Author identityId={r.publisher} /> · {timeAgo(r.createdAt)}
      </p>
      {r.notes && (full || !previous) ? (
        <div className={cn('mt-3 text-prose', !full && 'line-clamp-6')}>
          <MarkdownView source={r.notes} />
        </div>
      ) : null}
      {r.assets.length > 0 ? (
        <ul className="mt-3 divide-y divide-anvil-100 rounded-md border border-anvil-200 dark:divide-anvil-850 dark:border-anvil-800" aria-label="Assets">
          {r.assets.map((a) => (
            <AssetRow key={`${a.name}${a.sha256}`} asset={a} />
          ))}
        </ul>
      ) : null}
      {r.badAssets > 0 ? (
        <p className="mt-2 text-[12px] text-caution-700 dark:text-caution">
          {r.badAssets} {r.badAssets === 1 ? 'asset entry is' : 'asset entries are'} unreadable and not shown.
        </p>
      ) : null}
    </article>
  )
}

type AssetState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working'; readonly progress: DownloadProgress | null }
  | { readonly kind: 'saved' }
  | { readonly kind: 'mismatch'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string }

function AssetRow({ asset }: { asset: ReleaseAssetView }): JSX.Element {
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
  return (
    <li
      data-testid="release-asset"
      data-state={state.kind}
      className={cn('flex flex-wrap items-center gap-2 px-3 py-2 text-dense', bad && 'bg-danger/5')}
    >
      <FileArchive className={cn('h-4 w-4 shrink-0', bad ? 'text-danger' : 'text-anvil-400')} aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono">{asset.name}</span>
      {asset.size !== null ? <span className="text-[12px] text-anvil-500 dark:text-anvil-400">{formatBytes(asset.size)}</span> : null}
      <span className="font-mono text-[11px] text-anvil-500 dark:text-anvil-400" title={`SHA-256 ${asset.sha256}`}>
        sha256 {asset.sha256.slice(0, 10)}…
      </span>
      <Button size="sm" onClick={() => void run()} disabled={state.kind === 'working' || bad} aria-label={`Download ${asset.name}`}>
        {state.kind === 'working' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />}
        Download
      </Button>
      <p role="status" className="basis-full text-[12px]">
        {state.kind === 'working' ? (
          <span className="text-anvil-500 dark:text-anvil-400">
            Checking SHA-256 as it downloads
            {state.progress ? ` · ${formatBytes(state.progress.bytes)}${state.progress.total ? ` of ${formatBytes(state.progress.total)}` : ''}` : ''}
          </span>
        ) : state.kind === 'saved' ? (
          <span className="inline-flex items-center gap-1 text-verify-700 dark:text-verify">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Verified: the SHA-256 matched, saved.
          </span>
        ) : state.kind === 'mismatch' ? (
          <span className="inline-flex items-center gap-1 font-medium text-danger">
            <XCircle className="h-3.5 w-3.5" aria-hidden /> Failed: {state.message}. Not saved.
          </span>
        ) : state.kind === 'error' ? (
          <span className="inline-flex items-center gap-1 text-caution-700 dark:text-caution">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Couldn&apos;t download: {state.message}
          </span>
        ) : null}
      </p>
    </li>
  )
}
