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

import { Time } from '@/components/repo/byline'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, Download, FileArchive, Loader2, Lock, Tag, XCircle } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { formatBytes, plural, tipOidOf } from '@/lib/view'
import type { ReleaseAssetView, ReleaseView, RepoRef } from '@/lib/repo'
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
import { NOT_VERIFIED_YET, UNVERIFIABLE_ASSET, assetVerifiable, importedAssetUrl, isDraft, isPrereleaseView, latestRelease, type OmittedAssets, type ReleaseList } from '@/lib/repo/releases'
import { useReleases } from '@/hooks/use-repo-chrome'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { Author } from '@/components/author'
import { MarkdownView, type MarkdownLinks } from '@/components/markdown-view'
import { sourceUrl, useRepoLinks } from '@/components/repo/target-href'
import { Button } from '@/components/ui/button'
import { CopyLinkButton } from '@/components/ui/copy-link'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { EditReleaseButton, NewReleaseButton } from '@/components/repo/new-release'
import { SealedAssets, useSealedManifest } from '@/components/repo/sealed-release-assets'
import { useSdk } from '@/hooks/use-sdk'
import { invalidateSessionCache } from '@/lib/view/session-cache'
import { repoKey } from '@/lib/repo'
import { errorMessage, cn } from '@/lib/utils'

/** L-49: releases per page, with a "Show more" button for the rest. */
const PAGE_SIZE = 10

export function ReleasesContent({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const { data, error, reload } = useReleases(home.repo)
  const links = useRepoLinks(addr, home.description)
  const [showPrevious, setShowPrevious] = useState(false)
  const [shown, setShown] = useState(PAGE_SIZE)
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
  // L-48: the one release GitHub would mark "Latest" — the newest non-prerelease, non-yanked one.
  const latest = data ? latestRelease(data) : undefined

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
      ) : data.locked === true ? (
        <EmptyState icon={Lock} title="Releases are encrypted" body="This private repo's releases are readable only by its members, with their keys." />
      ) : data.current.length === 0 ? (
        <>
          <EmptyState
            icon={Tag}
            title="No releases yet"
            body="A maintainer publishes one with dg release create --tag v1 --asset ./dist/app.tar.gz."
          />
          <SealedListNotes list={data} />
        </>
      ) : (
        <>
          <SealedListNotes list={data} />
          <ul className="space-y-3">
            {data.current.slice(0, shown).map((r) => (
              <li key={r.id}>
                <ReleaseCard
                  release={r}
                  repo={home.repo}
                  addr={addr}
                  links={links}
                  tagTip={releaseTagTip(home, r.tagName)}
                  isLatest={r.id === latest?.id}
                  stateUnknown={data.unknownTags?.includes(r.tagName) === true}
                  actions={r.sealed ? <EditReleaseButton home={home} releases={data} tag={r.tagName} onPublished={refreshAfterPublish} /> : null}
                />
              </li>
            ))}
          </ul>
          {data.current.length > shown ? (
            <button
              type="button"
              onClick={() => setShown((n) => n + PAGE_SIZE)}
              className="text-dense text-anvil-600 underline dark:text-anvil-300"
            >
              Show {Math.min(PAGE_SIZE, data.current.length - shown)} more (of {plural(data.current.length - shown, 'release')} left)
            </button>
          ) : null}
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
                      <ReleaseCard release={r} repo={home.repo} addr={addr} links={links} previous />
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

/**
 * What a private repo's list could not show (§16.3): newer revisions under a key the reader does
 * not hold yet, and revisions that do not open. Nothing for a public repo's list.
 */
function SealedListNotes({ list }: { list: ReleaseList }): JSX.Element | null {
  const hidden = list.hidden ?? 0
  if (list.stale !== true && hidden === 0) return null
  return (
    <div className="space-y-1 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="releases-incomplete">
      {list.stale === true ? (
        <p className="flex items-center gap-1 text-caution-700 dark:text-caution-400">
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden /> Releases may be out of date: newer revisions are under a key you don&apos;t hold yet.
        </p>
      ) : null}
      {hidden > 0 ? <p>{plural(hidden, 'release revision')} could not be read.</p> : null}
    </div>
  )
}

/** The tip of a release's tag (a commit, or an annotated tag object), or null when no live tag has the name. */
function releaseTagTip(home: RepoHome, tag: string): string | null {
  return tipOidOf(home.tags.find((t) => t.refName === `refs/tags/${tag}`))
}

export function ReleaseContent({ home, addr, tag }: { home: RepoHome; addr: RepoAddress; tag: string }): JSX.Element {
  const { data, error, reload } = useReleases(home.repo)
  const links = useRepoLinks(addr, home.description)
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
      <SealedListNotes list={data} />
      <ReleaseCard
        release={release}
        repo={home.repo}
        addr={addr}
        links={links}
        full
        tagTip={releaseTagTip(home, tag)}
        isLatest={release.id === latestRelease(data)?.id}
        stateUnknown={data.unknownTags?.includes(tag) === true}
        actions={release.sealed ? <EditReleaseButton home={home} releases={data} tag={tag} onPublished={reload} /> : null}
      />
      {previous.length > 0 ? (
        <section aria-label="Previous revisions" className="space-y-3">
          <h2 className="text-prose">Previous revisions of {tag}</h2>
          {previous.map((r) => (
            <ReleaseCard key={r.id} release={r} repo={home.repo} addr={addr} links={links} previous />
          ))}
        </section>
      ) : null}
    </div>
  )
}

function ReleaseCard({
  release: r,
  repo,
  addr,
  links,
  previous = false,
  full = false,
  tagTip = null,
  isLatest = false,
  stateUnknown = false,
  actions = null,
}: {
  release: ReleaseView
  repo: RepoRef
  addr: RepoAddress
  links: MarkdownLinks
  previous?: boolean
  full?: boolean
  /** The release tag's tip (a commit or a tag object); null when no live tag has its name. */
  tagTip?: string | null
  /** L-48: this is the release GitHub would mark "Latest" (never true for a superseded revision). */
  isLatest?: boolean
  /** A newer revision of this sealed release could not be read (§16.3). */
  stateUnknown?: boolean
  /** A maintainer's controls for this release (a sealed one's edit, yank and unpublish). */
  actions?: ReactNode
}): JSX.Element {
  const [assetsOpen, setAssetsOpen] = useState(false)
  const prerelease = isPrereleaseView(r)
  const sealedFields = r.sealed?.fields
  const accesses = r.assets.map(assetAccess)
  // A sealed revision's assets, and notes that continue, are in its encrypted asset list (§16.5):
  // opened on the release's page, or when its assets are shown.
  const sealedList = sealedFields?.assetManifest !== undefined
  const manifest = useSealedManifest(repo, sealedFields, sealedList && (full || assetsOpen))
  const continued = sealedFields?.notesContinue === true
  const notes = full && continued && manifest.data?.notes !== undefined ? manifest.data.notes : r.notesBody
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
        {/* L-79: the name repeats the tag on most releases (`v24.0.0-rc.1 v24.0.0-rc.1`); only show it when it says more. */}
        {r.name && r.name !== r.tagName ? <span className="text-prose text-anvil-700 dark:text-anvil-200">{r.name}</span> : null}
        {/* latestRelease() falls back to the newest release when every one is a pre-release
            (so the rail still names something); that fallback should not draw a "Latest" badge
            here, since GitHub shows none in that case either. */}
        {isLatest && !prerelease ? (
          <span className="rounded bg-verify-100 px-1.5 text-[11px] font-medium uppercase text-verify-700 dark:bg-verify-900/40 dark:text-verify-400">
            Latest
          </span>
        ) : prerelease ? (
          <span className="rounded bg-anvil-100 px-1.5 text-[11px] uppercase text-anvil-600 dark:bg-anvil-800 dark:text-anvil-300">Pre-release</span>
        ) : null}
        {isDraft(r) ? (
          <span className="rounded bg-anvil-100 px-1.5 text-[11px] uppercase text-anvil-600 dark:bg-anvil-800 dark:text-anvil-300" data-testid="release-draft">
            Draft
          </span>
        ) : null}
        {previous ? (
          <span className="rounded bg-anvil-100 px-1.5 text-[11px] uppercase text-anvil-600 dark:bg-anvil-800 dark:text-anvil-300">previous</span>
        ) : null}
        {r.yanked ? (
          <span className="inline-flex items-center gap-1 rounded bg-caution/10 px-1.5 text-[11px] uppercase text-caution-700 dark:text-caution-400">
            <AlertTriangle className="h-3 w-3" aria-hidden /> yanked
          </span>
        ) : null}
        {actions || full ? (
          <span className="ml-auto flex items-center gap-1.5">
            {actions}
            {full ? <CopyLinkButton repo={addr} target={{ kind: 'release', tag: r.tagName }} /> : null}
          </span>
        ) : null}
      </header>
      <p className="mt-1 flex flex-wrap items-center gap-1 text-[12px] text-anvil-600 dark:text-anvil-300">
        {r.published !== null ? (
          <>
            Published <Time ms={r.published.at} dateOnly /> on {r.published.host}
            {r.published.author ? <> by <span className="font-medium text-anvil-800 dark:text-anvil-100">@{r.published.author}</span></> : null} · mirrored by{' '}
            <Author identityId={r.publisher} /> <Time ms={r.createdAt} />
          </>
        ) : (
          <>
            Published by <Author identityId={r.publisher} /> · <Time ms={r.createdAt} />
          </>
        )}
        {/* Only for a live tag of that name: a release's tag may be missing or deleted. */}
        {previous || tagTip === null ? null : (
          <>
            {' · '}
            <Link href={repoHref('/repo', addr, { ref: `tags/${r.tagName}` })} className="underline hover:text-forge-800 dark:hover:text-forge-400" data-testid="release-browse">
              Browse files
            </Link>
            {full ? (
              <>
                {' · '}
                {/* The commit page peels an annotated tag to the commit it names (L-01). */}
                <Link href={repoHref('/repo/commit', addr, { oid: tagTip })} className="underline hover:text-forge-800 dark:hover:text-forge-400" data-testid="release-commit">
                  View commit
                </Link>
              </>
            ) : null}
          </>
        )}
      </p>
      {notes && (full || !previous) ? (
        <div className={cn('mt-3 text-prose', !full && 'line-clamp-6')}>
          {/* A mirror's release notes are the source's (its import copied them): their mentions are that forge's. */}
          <MarkdownView source={notes} images="auto" links={links} imported={sourceUrl(links)} />
        </div>
      ) : null}
      {continued && (full || !previous) && notes === r.notesBody ? (
        <p className="mt-1 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="release-notes-continue">
          {full && manifest.error !== null
            ? 'These are the first part of the notes: the rest is in the encrypted asset list, which could not be opened.'
            : full
              ? 'The notes continue in the encrypted asset list…'
              : 'The notes continue on the release’s page.'}
        </p>
      ) : null}
      {/* L-79: line-clamp-6 silently cuts notes with no way back to the rest. */}
      {notes && !full && !previous ? (
        <Link
          href={repoHref('/repo/release', addr, { tag: r.tagName })}
          className="mt-1 inline-block text-dense text-anvil-600 underline dark:text-anvil-300"
        >
          Full release notes
        </Link>
      ) : null}
      {r.assets.length > 0 ? (
        full ? (
          <AssetList assets={r.assets} accesses={accesses} className="mt-3" />
        ) : (
          // L-49: 2,039 asset rows fully expanded is most of a 238,000 px page; collapsed by default in the list.
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setAssetsOpen((o) => !o)}
              aria-expanded={assetsOpen}
              className="text-dense text-anvil-600 underline dark:text-anvil-300"
            >
              {assetsOpen ? 'Hide' : 'Show'} {plural(r.assets.length, 'asset')}
            </button>
            {assetsOpen ? <AssetList assets={r.assets} accesses={accesses} className="mt-2" /> : null}
          </div>
        )
      ) : null}
      {stateUnknown ? (
        <p className="mt-2 flex items-center gap-1 text-[12px] text-caution-700 dark:text-caution-400" data-testid="release-state-unknown">
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden /> A newer revision of this release could not be read; its state is unknown.
        </p>
      ) : null}
      {sealedList && full ? <SealedAssets repo={repo} state={manifest} className="mt-3" /> : null}
      {sealedList && !full ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setAssetsOpen((o) => !o)}
            aria-expanded={assetsOpen}
            className="inline-flex items-center gap-1 text-dense text-anvil-600 underline dark:text-anvil-300"
          >
            <Lock className="h-3 w-3 shrink-0" aria-hidden />
            {assetsOpen ? 'Hide' : 'Show'} {manifest.data ? plural(manifest.data.assets.length, 'asset') : 'assets'}
          </button>
          {assetsOpen ? <SealedAssets repo={repo} state={manifest} className="mt-2" /> : null}
        </div>
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

/** A card's asset rows, with one shared {@link AssetsNote} under them instead of a notice on each row. */
function AssetList({
  assets,
  accesses,
  className,
}: {
  assets: readonly ReleaseAssetView[]
  accesses: readonly AssetAccess[]
  className: string
}): JSX.Element {
  return (
    <>
      <ul
        className={cn(className, 'divide-y divide-anvil-100 rounded-md border border-anvil-200 dark:divide-anvil-850 dark:border-anvil-800')}
        aria-label="Assets"
      >
        {assets.map((a, i) => (
          <AssetRow key={`${a.name}${a.sha256}`} asset={a} access={accesses[i]} notice={false} />
        ))}
      </ul>
      <AssetsNote accesses={accesses} />
    </>
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

/**
 * One shared explanation per card instead of the same boilerplate on every asset row (L-50: "no
 * SHA-256 is recorded … a maintainer fixes it" repeated 8 times per card). Only the two unhashed
 * states and the unreachable state are folded here — `origin`'s per-row "not checked yet" line
 * stays on each row: L-13's `import-release-fidelity.spec.ts` f2 and `markdown-render.spec.ts`
 * md-4 both read it there, so deduping it needs a design that does not move it off the row.
 * `browser`'s per-asset download progress also stays on its own row, where it belongs.
 */
function AssetsNote({ accesses }: { accesses: readonly AssetAccess[] }): JSX.Element | null {
  const has = (a: AssetAccess): boolean => accesses.includes(a)
  if (!has('unverified') && !has('unverifiable') && !has('none')) return null
  return (
    <ul className="mt-2 space-y-1 text-[12px]" aria-label="About these downloads">
      {has('unverified') ? <AssetsNoteItem>{NOT_VERIFIED_YET}</AssetsNoteItem> : null}
      {has('unverifiable') ? <AssetsNoteItem>{UNVERIFIABLE_ASSET}</AssetsNoteItem> : null}
      {has('none') ? (
        <AssetsNoteItem>
          Some assets have no copy at an address a browser may download from (a public https URL, or an IPFS CID with a gateway). Use{' '}
          <span className="font-mono">dg release download</span> with a storage profile for their host.
        </AssetsNoteItem>
      ) : null}
    </ul>
  )
}

function AssetsNoteItem({ children }: { children: ReactNode }): JSX.Element {
  return (
    <li className="flex items-start gap-1 text-caution-700 dark:text-caution-400">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> <span>{children}</span>
    </li>
  )
}

type AssetState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working'; readonly progress: DownloadProgress | null }
  | { readonly kind: 'saved' }
  | { readonly kind: 'mismatch'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string }

/**
 * One asset of a release: how this page can offer it, and the download or its fallback.
 * `access` lets a caller that already computed every row's access (ReleaseCard, to render one
 * shared {@link AssetsNote}) skip recomputing it; standalone use computes it here. `notice`
 * turns off this row's own copy of a fixed explanation {@link AssetsNote} already covers
 * (ReleaseCard passes `false`); a standalone row (e.g. a test) keeps it, since there is then no
 * card-level note to fall back on.
 */
export function AssetRow({
  asset,
  access: knownAccess,
  notice = true,
}: {
  asset: ReleaseAssetView
  access?: AssetAccess
  notice?: boolean
}): JSX.Element {
  const [state, setState] = useState<AssetState>({ kind: 'idle' })
  const access = knownAccess ?? assetAccess(asset)
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
  const unhashed = access === 'unverifiable' || access === 'unverified'
  return (
    <li
      data-testid="release-asset"
      data-state={access === 'browser' ? state.kind : access}
      className={cn('flex flex-wrap items-center gap-2 px-3 py-2 text-dense', bad && 'bg-danger/5')}
    >
      <FileArchive className={cn('h-4 w-4 shrink-0', bad ? 'text-danger-700 dark:text-danger-400' : 'text-anvil-500 dark:text-anvil-400')} aria-hidden />
      {/* L-07: 12 of 15 names clip at 1440 px, 16 of 16 clip on a phone, with no way to read the rest. */}
      <span className="min-w-0 flex-1 truncate font-mono" title={asset.name}>
        {asset.name}
      </span>
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
        // L-80's dedup applies here (a shared AssetsNote covers this when notice=false): unlike
        // 'origin' below, no e2e spec pins this exact row to a status role or text (only L-13's
        // md-4 and f2 pin the 'origin' catch-all), so it is safe to move to the card level.
        notice ? (
          <p role="status" className="basis-full text-[12px] text-caution-700 dark:text-caution-400">
            <span className="inline-flex items-start gap-1">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                No copy of this asset is at an address a browser may download from (a public https URL, or an IPFS CID with a gateway). Use{' '}
                <span className="font-mono">dg release download</span> with a storage profile for its host.
              </span>
            </span>
          </p>
        ) : null
      ) : unhashed ? (
        notice ? (
          <p role="status" className="basis-full text-[12px] text-caution-700 dark:text-caution-400">
            <span className="inline-flex items-start gap-1">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{' '}
              {access === 'unverified' ? NOT_VERIFIED_YET : UNVERIFIABLE_ASSET}
            </span>
          </p>
        ) : null
      ) : (
        // 'origin': kept unconditional (L-13, D-056) — import-release-fidelity.spec.ts f2 and
        // markdown-render.spec.ts md-4 both pin this exact row's status to "not checked yet".
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
