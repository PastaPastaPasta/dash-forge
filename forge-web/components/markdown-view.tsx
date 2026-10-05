'use client'

/**
 * MarkdownView — renders the safe Markdown AST (lib/view/markdown) as React elements.
 *
 * Only known elements with escaped text are emitted (no raw HTML injection), so untrusted
 * README / issue bodies are XSS-safe by construction. Prose is set at 15px with foundry link
 * accents; code blocks render monospace in an inset surface.
 *
 * Where the Markdown came from decides two things:
 * - `repo` (a README or other file in a repo): relative links go to that repo's blob/tree
 *   views, and relative images are read from the repo's own hash-checked objects (D-051).
 *   Without it (comments, issues, PRs) a relative link has no meaning and is dropped.
 * - `images`: `'auto'` loads remote images at once (the repo's own README and release notes);
 *   `'ask'` (the default: comments, issues, PRs, written by anyone) shows a placeholder until
 *   the viewer loads that host's images, once or always (D-053). Every image is fetched with
 *   `referrerpolicy=no-referrer`.
 */

import Link from 'next/link'
import { createContext, Fragment, memo, useContext, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { ImageOff, Info, Lightbulb, MessageSquareWarning, OctagonAlert, TriangleAlert, Workflow } from 'lucide-react'
import {
  formatBytes,
  headingSlug,
  isRelativeHref,
  MARKDOWN_MAX_CHARS,
  parseMarkdown,
  splitRefs,
  type Block,
  type Inline,
  type TableAlignment,
  type TreeEntry,
} from '@/lib/view'
import { splitUrls, type AlertKind, type Footnote, type RefPiece } from '@/lib/view/markdown'
import { highlightFence } from '@/lib/view/highlight'
import { importedHost, refTarget, type ForgeRepo, type RefContext, type RefTarget } from '@/lib/view/ref-targets'
import { MODE_TREE } from '@/lib/browse'
import { imagePreviewType } from '@/lib/view/blob-view'
import { resolveRepoPath, splitHref, upgradeHttp, urlHostOf } from '@/lib/view/markdown-links'
import { allowHost, useHostAllowed } from '@/hooks/use-image-hosts'
import { readBlob, commitRootTree, treeAtPath, findEntry, knownMinSize } from '@/lib/view/tree-nav'
import type { BrowseReader } from '@/lib/browse'
import { bytesToBase64 } from '@/lib/sdk/query'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { ScrollRegion } from '@/components/ui/scroll-region'
import { cn } from '@/lib/utils'

/** The repo file a Markdown document is part of, for relative links and images. */
export interface MarkdownRepoContext {
  readonly addr: RepoAddress
  /** The `?ref=` the page shows ('' = default branch). */
  readonly refParam: string
  /** Directory of the Markdown file ('' = repo root). */
  readonly dir: string
  /** Reads the commit the page shows, to inline relative images. */
  readonly reader?: BrowseReader
  readonly tipOid?: string
}

/**
 * Where `#n`, `owner/name#n`, commit ids and `@name` in plain text link to (GitHub's
 * autolinks, D-223, FG-2). Omitted: they stay text. Build it with `repoLinks`
 * (`components/repo/target-href`), the one place those routes are made.
 */
export interface MarkdownLinks {
  /** The href of a reference ({@link refTarget} decides what it is). */
  readonly href: (target: RefTarget) => string
  /** The repository this repo mirrors (its owner-written description names it), or null. */
  readonly source: ForgeRepo | null
}

/**
 * A review comment's ```` ```suggestion ```` blocks (review-parity R5, §4.5): the lines they
 * would replace, so each block renders as a diff (the lines removed, then the suggested ones).
 * Null: the lines are not known (another head, an old side), and the block shows as suggested
 * text only.
 */
export interface SuggestionContext {
  readonly original: readonly string[] | null
}

interface RenderContext {
  readonly repo: MarkdownRepoContext | null
  readonly images: 'auto' | 'ask'
  readonly links: MarkdownLinks | null
  readonly suggestion: SuggestionContext | null
  /** How references resolve: the mirror's source, and the forge the content was copied from. */
  readonly refs: RefContext
  /** Prefix of this document's footnote ids, unique on the page (several bodies may say `[^1]`). */
  readonly notes: string
  /** Autolinks this document may still render ({@link MAX_AUTOLINKS}); spent as text nodes render. */
  readonly budget: { left: number }
}

const EMPTY_CTX: RenderContext = { repo: null, images: 'ask', links: null, suggestion: null, refs: { source: null, imported: null }, notes: '', budget: { left: 0 } }
const Ctx = createContext<RenderContext>(EMPTY_CTX)

/** How references resolve for `links`, in content whose `imported.url` is `imported`. */
const refsOf = (links: MarkdownLinks | null, imported: string | null): RefContext => {
  const source = links?.source ?? null
  return { source, imported: importedHost(imported, source) }
}

/** A suggestion block as a diff: the replaced lines, then the suggested ones. */
function SuggestionBlock({ text }: { text: string }): JSX.Element {
  const { suggestion } = useContext(Ctx)
  const added = text === '' ? [] : text.split('\n')
  const removed = suggestion?.original ?? null
  return (
    <div className="my-3 overflow-hidden rounded-md border border-anvil-200 text-[13px] dark:border-anvil-800" data-testid="suggestion">
      <div className="border-b border-anvil-200 bg-anvil-50 px-3 py-1 text-[12px] font-medium text-anvil-600 dark:border-anvil-800 dark:bg-anvil-900 dark:text-anvil-300">
        Suggested change
      </div>
      {/* Keyboard-scrollable when a line is wider than the comment (WCAG 2.1.1). */}
      <ScrollRegion as="pre" label="Suggested change" className="overflow-x-auto font-mono">
        {removed?.map((l, i) => (
          <div key={`r${i}`} className="bg-danger/10 px-3 text-danger-800 dark:text-danger-300" data-kind="removed">
            <span aria-hidden className="select-none">- </span>
            {l || ' '}
          </div>
        ))}
        {added.map((l, i) => (
          <div key={`a${i}`} className="bg-verify/10 px-3 text-verify-800 dark:text-verify-300" data-kind="added">
            <span aria-hidden className="select-none">+ </span>
            {l || ' '}
          </div>
        ))}
        {added.length === 0 ? <div className="px-3 italic text-anvil-500 dark:text-anvil-400">(deletes the lines)</div> : null}
      </ScrollRegion>
    </div>
  )
}

function tableAlignClass(align: TableAlignment | 'left' | 'center' | 'right'): string {
  if (align === 'center') return 'text-center'
  if (align === 'right') return 'text-right'
  return 'text-left'
}

const LINK = 'text-forge-700 underline decoration-forge-700/30 underline-offset-2 hover:decoration-forge-700 dark:text-forge-400'

/** How a reference reads: as written, with a commit id shortened as GitHub shows it. */
function refLabel(p: Exclude<RefPiece, { t: 'text' }>): string {
  const repo = p.t !== 'mention' && p.repo !== undefined ? `${p.repo.owner}/${p.repo.name}` : ''
  if (p.t === 'ref') return `${repo}#${p.n}`
  if (p.t === 'commit') return repo === '' ? p.oid.slice(0, 7) : `${repo}@${p.oid.slice(0, 7)}`
  return `@${p.label}${p.bot ? '[bot]' : ''}`
}

/** One autolinked reference: an in-app link, or a link to the forge the content came from. */
function RefLink({ piece, links }: { piece: Exclude<RefPiece, { t: 'text' }>; links: MarkdownLinks }): JSX.Element {
  const { refs } = useContext(Ctx)
  const target = refTarget(piece, refs)
  const label = refLabel(piece)
  if (target === null) return <>{label}</>
  const cls = cn(LINK, piece.t === 'mention' && 'font-medium', piece.t === 'commit' && 'font-mono text-[0.9em]')
  if (target.kind === 'external') {
    return (
      <a href={target.url} target="_blank" rel="noreferrer noopener" className={cls} data-autolink={piece.t} title={`On ${new URL(target.url).host}`}>
        {label}
      </a>
    )
  }
  return (
    <Link href={links.href(target)} className={cls} data-autolink={piece.t}>
      {label}
    </Link>
  )
}

/**
 * Most autolinked references one document renders (each is an element; a hostile body of
 * `abc1234 abc1234 …` would otherwise make hundreds of thousands). Past it, text stays text.
 */
export const MAX_AUTOLINKS = 1000

/** Longest plain text {@link LinkifiedText} links (a commit message); longer is shown as written. */
const MAX_LINKIFIED_CHARS = 64 * 1024

/** Plain text with its references linked (when the page gave `links`). */
function AutolinkedText({ text }: { text: string }): JSX.Element {
  const { links, budget } = useContext(Ctx)
  if (links === null || budget.left <= 0) return <>{text}</>
  const pieces = splitRefs(text)
  if (pieces.length === 1 && pieces[0]?.t === 'text') return <>{text}</>
  budget.left -= pieces.length
  if (budget.left < 0) return <>{text}</>
  return (
    <>
      {pieces.map((p, i) => (p.t === 'text' ? <Fragment key={i}>{p.v}</Fragment> : <RefLink key={i} piece={p} links={links} />))}
    </>
  )
}

/**
 * A plain-text body (a commit message) with its URLs and references linked, as GitHub links a
 * commit message: no Markdown, the text as written.
 */
export function LinkifiedText({ text, links, imported = null }: { text: string; links: MarkdownLinks; imported?: string | null }): JSX.Element {
  const ctx = useMemo<RenderContext>(() => ({ ...EMPTY_CTX, links, refs: refsOf(links, imported), budget: { left: MAX_AUTOLINKS } }), [links, imported])
  ctx.budget.left = MAX_AUTOLINKS
  // A commit message is unbounded git data: past this, it is shown as written, unlinked.
  if (text.length > MAX_LINKIFIED_CHARS) return <>{text}</>
  return (
    <Ctx.Provider value={ctx}>
      {splitUrls(text).map((p, i) =>
        p.t === 'url' ? (
          <a key={i} href={p.href} target="_blank" rel="noreferrer noopener" className={cn(LINK, WRAP)}>
            {p.href}
          </a>
        ) : (
          <AutolinkedText key={i} text={p.v} />
        ),
      )}
    </Ctx.Provider>
  )
}

/** A link: an in-page anchor, a repo path (to the blob or tree view), or an external URL. */
function MdLink({ href, id, children }: { href: string; id?: string; children: ReactNode }): JSX.Element {
  const ctx = useContext(Ctx)
  // Text inside a link is not autolinked (as on GitHub): no `<a>` inside an `<a>`.
  const inner = useMemo<RenderContext>(() => (ctx.links === null ? ctx : { ...ctx, links: null }), [ctx])
  return (
    <LinkTarget href={href} id={id}>
      <Ctx.Provider value={inner}>{children}</Ctx.Provider>
    </LinkTarget>
  )
}

function LinkTarget({ href, id, children }: { href: string; id?: string; children: ReactNode }): JSX.Element {
  const { repo, refs } = useContext(Ctx)
  // An `<a href name>` is also an in-page target; a link that goes nowhere keeps only that.
  const target = id === undefined ? undefined : anchorTarget(id)
  if (href === '#') return target === undefined ? <>{children}</> : <a id={target}>{children}</a>
  if (href.startsWith('#')) {
    // GitHub prefixes heading and `<a name>` ids with `user-content-`; so do the targets here.
    const to = anchorTarget(decodeURIComponentSafe(href.slice(1)))
    return (
      <a id={target} href={`#${to}`} className={LINK}>
        {children}
      </a>
    )
  }
  if (isRepoPath(repo, href)) {
    const path = repo ? repoPathOf(repo, href) : null
    if (repo === null || path === null) return target === undefined ? <>{children}</> : <a id={target}>{children}</a>
    return (
      <RepoPathLink id={target} repo={repo} path={path} href={href}>
        {children}
      </RepoPathLink>
    )
  }
  // A site path in content copied from another forge (`/owner/repo/pull/1`) is that forge's.
  if (href.startsWith('/') && refs.imported !== null) {
    return (
      <a id={target} href={`https://${refs.imported}${href}`} target="_blank" rel="noreferrer noopener" className={LINK}>
        {children}
      </a>
    )
  }
  return (
    <a id={target} href={href} target={href.startsWith('http') ? '_blank' : undefined} rel="noreferrer noopener" className={LINK}>
      {children}
    </a>
  )
}

/**
 * The repo path a link or image names: a `/`-rooted one (`/doc/build-unix.md`) from the repo
 * root, as GitHub resolves it in a repo file; a relative one from the file's directory. Null
 * when it climbs out of the repo.
 */
function repoPathOf(repo: MarkdownRepoContext, href: string): string | null {
  const { path } = splitHref(href)
  return resolveRepoPath(path.startsWith('/') ? '' : repo.dir, path)
}

/** Whether a link or image names a path in the repo: relative, or `/`-rooted in a repo file. */
function isRepoPath(repo: MarkdownRepoContext | null, href: string): boolean {
  return isRelativeHref(href) || (repo !== null && href.startsWith('/'))
}

/** A last path segment with no extension (`doc`, `test`): perhaps a directory, so worth looking up. */
const MAYBE_DIR = /(^|\/)[^./]+$/

/** Most distinct directories a commit's Markdown links may read to tell a folder from a file. */
const MAX_DIR_LOOKUPS = 32

/** Directories looked up per (reader, commit), so hundreds of `/a/b/c` links cost a bounded number of reads. */
const dirLookups = new WeakMap<BrowseReader, Map<string, Set<string>>>()

/** Whether `path`'s parent may be read (already read, or under the cap). Past it, a link is a blob link. */
function mayLookUp(reader: BrowseReader, tipOid: string, path: string): boolean {
  const byTip = dirLookups.get(reader) ?? new Map<string, Set<string>>()
  dirLookups.set(reader, byTip)
  const dirs = byTip.get(tipOid) ?? new Set<string>()
  byTip.set(tipOid, dirs)
  const dir = path.slice(0, Math.max(0, path.lastIndexOf('/')))
  if (dirs.has(dir)) return true
  if (dirs.size >= MAX_DIR_LOOKUPS) return false
  dirs.add(dir)
  return true
}

/**
 * A link to a path in the repo: the tree view when the path is a directory (written with a
 * trailing `/`, or found to be one in the commit's tree), else the blob view. Only an
 * extensionless path is looked up, in its parent's tree (the root's is read for the page
 * already), so a README's many file links cost no reads.
 */
function RepoPathLink({ repo, path, href, id, children }: { repo: MarkdownRepoContext; path: string; href: string; id?: string; children: ReactNode }): JSX.Element {
  const written = /\/$/.test(href.split(/[?#]/)[0] ?? '')
  const lookup =
    !written &&
    path !== '' &&
    MAYBE_DIR.test(path) &&
    repo.reader !== undefined &&
    repo.tipOid !== undefined &&
    mayLookUp(repo.reader, repo.tipOid, path)
  const [isDir, setIsDir] = useState<{ key: string; dir: boolean } | null>(null)
  const key = `${repo.tipOid ?? ''}:${path}`
  useEffect(() => {
    if (!lookup || repo.reader === undefined || repo.tipOid === undefined) return
    let active = true
    entryAt(repo.reader, repo.tipOid, path).then(
      (entry) => active && setIsDir({ key, dir: entry?.mode === MODE_TREE }),
      () => undefined, // unknown: the blob view it is
    )
    return () => {
      active = false
    }
  }, [lookup, repo.reader, repo.tipOid, path, key])
  const tree = path === '' || written || (isDir?.key === key && isDir.dir)
  const fragment = splitHref(href).fragment
  const to = `${repoPathHref(repo, path, tree ? '/repo/tree' : '/repo/blob')}${fragment ? `#${fragment}` : ''}`
  return (
    <Link id={id} href={to} className={LINK}>
      {children}
    </Link>
  )
}

/** The page for `path` in the repo the Markdown came from, at the ref the page shows. */
function repoPathHref(repo: MarkdownRepoContext, path: string, route: '/repo/blob' | '/repo/tree' = '/repo/blob'): string {
  return repoHref(route, repo.addr, { path, ...(repo.refParam ? { ref: repo.refParam } : {}) })
}

/** The DOM id an in-page anchor (a heading slug, `<a name>` or `id`) renders with, as on GitHub. */
function anchorTarget(name: string): string {
  return `user-content-${name.toLowerCase()}`
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const IMG = 'my-2 inline-block max-w-full rounded align-middle'

interface ImageProps {
  readonly src: string
  readonly alt: string
  readonly width?: number
  readonly height?: number
}

/** An image that cannot be shown here: its alt text, muted (or nothing). */
function AltText({ alt }: { alt: string }): JSX.Element | null {
  return alt ? <span className="text-anvil-500 dark:text-anvil-400">{alt}</span> : null
}

function MdImage(props: ImageProps): JSX.Element | null {
  const ctx = useContext(Ctx)
  const { src } = props
  if (src === '#') return <AltText alt={props.alt} />
  if (isRepoPath(ctx.repo, src)) return <RepoImage {...props} />
  if (src.startsWith('/') || src.startsWith('#')) return null // a site path means nothing here
  return ctx.images === 'auto' ? <RemoteImg {...props} /> : <GatedImage {...props} />
}

/**
 * A remote image. `http:` is asked for as `https:` (the page is https, so the browser would
 * block or upgrade it anyway, and a host that serves both answers the same). When it still
 * fails to load (a dead host, a removed upload), the image becomes a link to its URL rather
 * than a blank box.
 */
function RemoteImg({ src, alt, width, height }: ImageProps): JSX.Element {
  const url = upgradeHttp(src)
  const [failed, setFailed] = useState<string | null>(null)
  if (failed === url) {
    return (
      <a href={url} target="_blank" rel="noreferrer noopener" referrerPolicy="no-referrer" className={cn(LINK, 'text-[12px]')} data-testid="image-failed">
        <ImageOff className="mr-1 inline h-3.5 w-3.5 align-[-2px]" aria-hidden />
        {alt || 'Image'} (did not load from {urlHostOf(url) ?? 'its host'})
      </a>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      width={width}
      height={height}
      className={IMG}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(url)}
    />
  )
}

/**
 * An image in Markdown anyone could write: it is not fetched until the viewer asks, because
 * the fetch tells the image's host the viewer's IP address and when they looked (D-053).
 */
function GatedImage(props: ImageProps): JSX.Element {
  const { alt } = props
  const host = urlHostOf(props.src)
  const allowed = useHostAllowed(host)
  if (allowed) return <RemoteImg {...props} />
  return (
    <span
      data-testid="gated-image"
      className="my-1 inline-flex flex-wrap items-center gap-2 rounded-md border border-dashed border-anvil-300 px-2 py-1 align-middle text-[12px] text-anvil-600 dark:border-anvil-700 dark:text-anvil-300"
    >
      <ImageOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        Image{alt ? ` “${alt}”` : ''} from <span className="font-mono">{host ?? 'an unknown host'}</span>
      </span>
      {host !== null ? (
        <>
          <button type="button" className="font-medium text-forge-700 hover:underline dark:text-forge-400" onClick={() => allowHost(host, false)}>
            Load images from {host}
          </button>
          <button type="button" className="text-anvil-600 hover:underline dark:text-anvil-300" onClick={() => allowHost(host, true)}>
            Always allow
          </button>
        </>
      ) : null}
    </span>
  )
}

/** Blobs a relative image may be read from (a larger file is linked, not inlined). */
export const REPO_IMAGE_MAX_BYTES = 5 * 1024 * 1024

/**
 * Tree walks in flight or done, per (reader, commit, directory): a README with ten images in
 * `docs/` reads the root and `docs` trees once, not ten times in parallel.
 */
const treeWalks = new WeakMap<BrowseReader, Map<string, Promise<TreeEntry[]>>>()

function entriesAt(reader: BrowseReader, tipOid: string, dir: string): Promise<TreeEntry[]> {
  const walks = treeWalks.get(reader) ?? new Map<string, Promise<TreeEntry[]>>()
  treeWalks.set(reader, walks)
  const key = `${tipOid}:${dir}`
  let walk = walks.get(key)
  if (walk === undefined) {
    walk = commitRootTree(reader, tipOid).then(({ tree }) => treeAtPath(reader, tree, dir))
    walks.set(key, walk)
    walk.catch(() => walks.delete(key)) // a failed walk is retried by the next image
  }
  return walk
}

/** The tree entry at `path` (through the shared per-directory walk), or undefined. */
async function entryAt(reader: BrowseReader, tipOid: string, path: string): Promise<TreeEntry | undefined> {
  const slash = path.lastIndexOf('/')
  return findEntry(await entriesAt(reader, tipOid, slash === -1 ? '' : path.slice(0, slash)), path.slice(slash + 1))
}

/**
 * Read a relative image's blob, never more than {@link REPO_IMAGE_MAX_BYTES}: the reader
 * refuses an object whose header says it is larger before inflating it, and `readBlob` checks
 * the result. (A stored entry's length is only a hint: a delta or a run of zeros is tiny in
 * the pack and huge once inflated, so it is trusted only to skip an undeltified blob early.)
 */
export async function readRepoImage(reader: BrowseReader, tipOid: string, path: string): Promise<{ bytes: Uint8Array; type: string }> {
  const entry = await entryAt(reader, tipOid, path)
  if (entry === undefined) throw new Error('not found')
  if (((await knownMinSize(reader, entry.oid)) ?? 0) > REPO_IMAGE_MAX_BYTES) throw new Error('too large')
  const bytes = await readBlob(reader, entry.oid, REPO_IMAGE_MAX_BYTES)
  const type = imagePreviewType(path, bytes)
  if (type === null) throw new Error('not an image')
  return { bytes, type }
}

/** A relative image: read from the repo's own objects (hash-checked), never fetched from a host. */
function RepoImage({ src, alt, width, height }: ImageProps): JSX.Element | null {
  const { repo } = useContext(Ctx)
  const path = repo ? repoPathOf(repo, src) : null
  const reader = repo?.reader
  const tipOid = repo?.tipOid
  const key = path === null || reader === undefined || tipOid === undefined ? null : `${tipOid}:${path}`
  // The URL is kept with the key it was read for, so a new path or commit never shows the old image.
  const [shown, setShown] = useState<{ key: string; url: string | 'failed' } | null>(null)
  useEffect(() => {
    if (key === null || path === null || reader === undefined || tipOid === undefined) return
    let active = true
    let objectUrl: string | null = null
    readRepoImage(reader, tipOid, path).then(
      ({ bytes, type }) => {
        if (!active) return
        // An SVG stays a data: URL: as a blob: URL it would be a same-origin document if
        // opened. Raster images use a blob: URL (no multi-MiB base64 string), revoked on unmount.
        if (type === 'image/svg+xml') {
          setShown({ key, url: `data:${type};base64,${bytesToBase64(bytes)}` })
        } else {
          objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
          setShown({ key, url: objectUrl })
        }
      },
      () => active && setShown({ key, url: 'failed' }),
    )
    return () => {
      active = false
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [key, path, reader, tipOid])
  if (repo === null || path === null) return <AltText alt={alt} />
  let url: string | null = null
  if (key === null) url = 'failed' // no reader for this page
  else if (shown?.key === key) url = shown.url
  if (url === null) return <span className={cn(IMG, 'inline-block h-5 w-16 animate-pulse bg-anvil-100 dark:bg-anvil-800')} aria-label={alt} />
  if (url === 'failed') {
    // No reader for this page, or the blob is missing, too large or not an image: link to it.
    return (
      <Link href={repoPathHref(repo, path)} className={LINK} data-testid="repo-image-link">
        {alt || path}
      </Link>
    )
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt} width={width} height={height} className={IMG} data-testid="repo-image" />
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderInline(nodes: readonly Inline[], keyPrefix: string): ReactNode {
  return nodes.map((n, i) => {
    const key = `${keyPrefix}-${i}`
    switch (n.t) {
      case 'text':
        return <AutolinkedText key={key} text={n.v} />
      case 'strong':
        return <strong key={key} className="font-semibold">{renderInline(n.c, key)}</strong>
      case 'em':
        return <em key={key}>{renderInline(n.c, key)}</em>
      case 'del':
        return <del key={key} className="text-anvil-500 dark:text-anvil-400">{renderInline(n.c, key)}</del>
      case 'code':
        return (
          <code key={key} className={cn('rounded bg-anvil-100 px-1 py-0.5 text-[0.9em] dark:bg-anvil-800', WRAP)}>
            {n.v}
          </code>
        )
      case 'fnref':
        return <FootnoteRef key={key} n={n.n} label={n.label} k={n.k} />
      case 'link':
        return (
          <MdLink key={key} href={n.href} id={n.id}>
            {renderInline(n.c, key)}
          </MdLink>
        )
      case 'image':
        return <MdImage key={key} src={n.src} alt={n.alt} width={n.width} height={n.height} />
      case 'anchor':
        return <a key={key} id={anchorTarget(n.id)}>{renderInline(n.c, key)}</a>
      case 'br':
        return <br key={key} />
      case 'tag':
        return n.tag === 'kbd' ? (
          <kbd key={key} className="rounded border border-anvil-300 bg-anvil-50 px-1 py-0.5 font-mono text-[0.85em] dark:border-anvil-700 dark:bg-anvil-850">
            {renderInline(n.c, key)}
          </kbd>
        ) : n.tag === 'sub' ? (
          <sub key={key}>{renderInline(n.c, key)}</sub>
        ) : (
          <sup key={key}>{renderInline(n.c, key)}</sup>
        )
      default:
        return null
    }
  })
}

/** Plain text of inline nodes, for heading ids. */
function textOf(nodes: readonly Inline[]): string {
  return nodes
    .map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'image' ? n.alt : n.t === 'br' ? ' ' : n.t === 'fnref' ? '' : textOf(n.c)))
    .join('')
}

/**
 * Long unbroken runs (a magnet URI, a 128-hex hash) wrap anywhere rather than widen the page
 * (L-52). `overflow-wrap: anywhere` also lets a flex or table cell shrink below such a word.
 */
const WRAP = '[overflow-wrap:anywhere]'

/** A footnote's DOM ids: GitHub's `user-content-fn-…`, with this document's prefix (unique per body on a page). */
function footnoteIds(notes: string, label: string, k = 1): { note: string; ref: string } {
  const safe = encodeURIComponent(label)
  return { note: `user-content-fn-${notes}${safe}`, ref: `user-content-fnref-${notes}${safe}${k > 1 ? `-${k}` : ''}` }
}

function FootnoteRef({ n, label, k }: { n: number; label: string; k: number }): JSX.Element {
  const { notes } = useContext(Ctx)
  const ids = footnoteIds(notes, label, k)
  return (
    <sup>
      <a href={`#${ids.note}`} id={ids.ref} className={LINK} data-footnote-ref aria-describedby={`footnote-label-${notes}`}>
        {n}
      </a>
    </sup>
  )
}

function Footnotes({ items, keyPrefix, slugs }: { items: readonly Footnote[]; keyPrefix: string; slugs: Map<string, number> }): JSX.Element {
  const { notes } = useContext(Ctx)
  return (
    <section data-footnotes className="mt-6 border-t border-anvil-200 pt-3 text-[0.9em] dark:border-anvil-800">
      <h2 id={`footnote-label-${notes}`} className="sr-only">
        Footnotes
      </h2>
      <ol className="list-decimal space-y-1 pl-6">
        {items.map((f) => {
          const ids = footnoteIds(notes, f.label)
          return (
            <li key={f.label} id={ids.note}>
              {f.c.map((b, i) => renderBlock(b, `${keyPrefix}-${f.n}-${i}`, slugs))}
              {Array.from({ length: f.refs }, (_, k) => (
                <a
                  key={k}
                  href={`#${footnoteIds(notes, f.label, k + 1).ref}`}
                  className={cn(LINK, 'ml-1 no-underline')}
                  data-footnote-backref
                  aria-label={`Back to reference ${f.n}${k > 0 ? `-${k + 1}` : ''}`}
                >
                  ↩{k > 0 ? <sup>{k + 1}</sup> : null}
                </a>
              ))}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

const ALERTS: Readonly<Record<AlertKind, { title: string; icon: typeof Info; box: string; head: string }>> = {
  note: { title: 'Note', icon: Info, box: 'border-dash-500', head: 'text-dash-600 dark:text-dash-400' },
  tip: { title: 'Tip', icon: Lightbulb, box: 'border-verify', head: 'text-verify-700 dark:text-verify-400' },
  important: { title: 'Important', icon: MessageSquareWarning, box: 'border-forge-500', head: 'text-forge-700 dark:text-forge-400' },
  warning: { title: 'Warning', icon: TriangleAlert, box: 'border-caution', head: 'text-caution-700 dark:text-caution-400' },
  caution: { title: 'Caution', icon: OctagonAlert, box: 'border-danger', head: 'text-danger-700 dark:text-danger-400' },
}

const CODE_BLOCK = 'overflow-x-auto rounded-md border border-anvil-200 bg-anvil-50 p-3 text-[13px] dark:border-anvil-800 dark:bg-anvil-950'

/**
 * A fenced code block: plain at once, then highlighted when the fence names a language
 * (```python, QW2-058), as GitHub renders them; the highlighter loads lazily in its own chunk.
 */
function CodeBlock({ text, lang }: { text: string; lang: string }): JSX.Element {
  const [html, setHtml] = useState<{ for: string; html: string } | null>(null)
  const want = `${lang}\n${text}`
  useEffect(() => {
    if (lang.trim() === '') return
    let live = true
    void highlightFence(text, lang).then((h) => {
      if (live && h !== null) setHtml({ for: want, html: h })
    })
    return () => {
      live = false
    }
  }, [text, lang, want])
  const shown = html !== null && html.for === want ? html.html : null
  return (
    <ScrollRegion as="pre" label="Code block" className={cn('my-3', CODE_BLOCK)}>
      {shown === null ? (
        <code data-lang={lang || undefined}>{text}</code>
      ) : (
        <code className="hljs" data-lang={lang} data-highlighted="true" dangerouslySetInnerHTML={{ __html: shown }} />
      )}
    </ScrollRegion>
  )
}

/** A mermaid diagram's source, shown as code: rendering it needs mermaid's ~1 MB of script, which would draw attacker-written SVG. */
function MermaidBlock({ source }: { source: string }): JSX.Element {
  return (
    <figure className="my-3" data-testid="mermaid">
      <ScrollRegion as="pre" label="Mermaid diagram source" className={CODE_BLOCK}>
        <code>{source}</code>
      </ScrollRegion>
      <figcaption className="mt-1 flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400">
        <Workflow className="h-3.5 w-3.5" aria-hidden /> Mermaid diagram, shown as its source: Forge does not draw diagrams.
      </figcaption>
    </figure>
  )
}

const HEADING_CLASS: Readonly<Record<number, string>> = {
  1: 'mt-6 mb-3 border-b border-anvil-200 pb-2 text-2xl dark:border-anvil-800',
  2: 'mt-6 mb-3 border-b border-anvil-200 pb-1.5 text-xl dark:border-anvil-800',
}

function renderBlock(b: Block, key: string, slugs: Map<string, number>): ReactNode {
  switch (b.t) {
    case 'heading': {
      const cls = HEADING_CLASS[b.level] ?? 'mt-5 mb-2 text-lg'
      const content = renderInline(b.c, key)
      // GitHub's anchors: slug, numbered on repeats, prefixed `user-content-`.
      const base = headingSlug(textOf(b.c))
      const n = slugs.get(base) ?? 0
      slugs.set(base, n + 1)
      const id = anchorTarget(n === 0 ? base : `${base}-${n}`)
      if (b.level <= 2) return <h2 key={key} id={id} className={cls}>{content}</h2>
      if (b.level === 3) return <h3 key={key} id={id} className={cls}>{content}</h3>
      return <h4 key={key} id={id} className={cls}>{content}</h4>
    }
    case 'paragraph':
      return <p key={key} className={cn('my-3 leading-relaxed', WRAP)}>{renderInline(b.c, key)}</p>
    case 'inline':
      return <Fragment key={key}>{renderInline(b.c, key)}</Fragment>
    case 'code':
      if (b.lang === 'suggestion') return <SuggestionBlock key={key} text={b.v} />
      if (b.lang === 'mermaid') return <MermaidBlock key={key} source={b.v} />
      return <CodeBlock key={key} text={b.v} lang={b.lang} />
    case 'list': {
      const tasks = b.tasks
      const items = b.items.map((it, i) => {
        const task = tasks?.[i] ?? null
        const checkbox =
          task !== null ? <input type="checkbox" checked={task} disabled aria-label={task ? 'Done' : 'Not done'} className="mr-1.5 -ml-5 align-middle" /> : null
        const content = (
          <>
            {checkbox}
            {renderInline(it, `${key}-${i}`)}
          </>
        )
        return (
          <li key={i} className={cn(WRAP, task !== null && 'list-none')}>
            {/* A loose list's items hold paragraphs (GitHub's spacing); a tight one's, bare text. */}
            {b.loose && it.length > 0 ? <p className="my-2 leading-relaxed">{content}</p> : content}
            {b.blocks?.[i]?.map((inner, j) => renderBlock(inner, `${key}-${i}-${j}`, slugs))}
          </li>
        )
      })
      // Nested lists sit snug under their item (`[&_ul]:my-1`), as GitHub spaces them.
      const cls = '[&_ol]:my-1 [&_ul]:my-1 my-3 space-y-1 pl-6'
      return b.ordered ? (
        <ol key={key} start={b.start} className={cn(cls, 'list-decimal')}>{items}</ol>
      ) : (
        <ul key={key} className={cn(cls, 'list-disc')}>{items}</ul>
      )
    }
    case 'quote':
      return (
        <blockquote key={key} className="my-3 border-l-2 border-forge-500/40 pl-4 text-anvil-500 dark:text-anvil-400">
          {b.c.map((inner, i) => renderBlock(inner, `${key}-${i}`, slugs))}
        </blockquote>
      )
    case 'alert': {
      const a = ALERTS[b.kind]
      const Icon = a.icon
      return (
        <div key={key} className={cn('my-3 border-l-4 py-1 pl-4', a.box)} data-alert={b.kind} role="note" aria-label={a.title}>
          <p className={cn('mb-1 flex items-center gap-1.5 font-medium', a.head)}>
            <Icon className="h-4 w-4" aria-hidden /> {a.title}
          </p>
          {b.c.map((inner, i) => renderBlock(inner, `${key}-${i}`, slugs))}
        </div>
      )
    }
    case 'footnotes':
      return <Footnotes key={key} items={b.items} keyPrefix={key} slugs={slugs} />
    case 'table':
      return (
        <ScrollRegion key={key} label="Table" className="my-4 max-w-full overflow-x-auto rounded-md border border-anvil-200 dark:border-anvil-800">
          <table className="min-w-full border-collapse text-dense leading-5">
            <thead className="bg-anvil-50 text-anvil-900 dark:bg-anvil-900 dark:text-anvil-50">
              <tr>
                {b.header.map((cell, i) => (
                  <th
                    key={i}
                    scope="col"
                    className={cn(
                      'border-b border-r border-anvil-200 px-3 py-2 font-semibold last:border-r-0 dark:border-anvil-800',
                      tableAlignClass(b.align[i] ?? null),
                    )}
                  >
                    {renderInline(cell, `${key}-header-${i}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-anvil-200 dark:divide-anvil-800">
              {b.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="align-top even:bg-anvil-50/50 dark:even:bg-anvil-900/40">
                  {row.map((cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      className={cn(
                        'border-r border-anvil-200 px-3 py-2 last:border-r-0 dark:border-anvil-800',
                        tableAlignClass(b.align[cellIndex] ?? null),
                      )}
                    >
                      {renderInline(cell, `${key}-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )
    case 'hr':
      return <hr key={key} className="my-5 border-anvil-200 dark:border-anvil-800" />
    case 'element':
      return renderElement(b, key, slugs)
    default:
      return null
  }
}

/**
 * A table's children, with bare `<tr>` rows put in a `<tbody>` (as a browser's parser would),
 * so React never nests a row directly in a table.
 */
function wrapRows(blocks: readonly Block[], kids: readonly ReactNode[]): ReactNode {
  const isRow = (b: Block | undefined): boolean => b?.t === 'element' && b.tag === 'tr'
  if (!blocks.some(isRow)) return kids
  const out: ReactNode[] = []
  let rows: ReactNode[] = []
  const flushRows = (): void => {
    if (rows.length > 0) out.push(<tbody key={`rows-${out.length}`}>{rows}</tbody>)
    rows = []
  }
  kids.forEach((kid, i) => {
    if (isRow(blocks[i])) rows.push(kid)
    else {
      flushRows()
      out.push(kid)
    }
  })
  flushRows()
  return out
}

/** An allowlisted HTML container. Only its tag, alignment, `open`, an `id` and a checked `href` survive. */
function renderElement(b: Extract<Block, { t: 'element' }>, key: string, slugs: Map<string, number>): ReactNode {
  const kids = b.c.map((inner, i) => renderBlock(inner, `${key}-${i}`, slugs))
  const align = b.align === null ? undefined : tableAlignClass(b.align)
  // An `id` (or an `<a name>`) is an in-page target, on the element itself (GitHub's prefix).
  const id = b.id === undefined ? undefined : anchorTarget(b.id)
  switch (b.tag) {
    case 'details':
      return (
        <details key={key} id={id} open={b.open} className="my-3 rounded-md border border-anvil-200 px-3 py-2 dark:border-anvil-800">
          {kids}
        </details>
      )
    case 'summary':
      return <summary key={key} id={id} className="cursor-pointer font-medium">{kids}</summary>
    case 'a':
      return <MdLink key={key} href={b.href ?? '#'} id={b.id}>{kids}</MdLink>
    case 'p':
      return <p key={key} id={id} className={cn('my-3 leading-relaxed', align)}>{kids}</p>
    case 'blockquote':
      return <blockquote key={key} id={id} className="my-3 border-l-2 border-forge-500/40 pl-4 text-anvil-500 dark:text-anvil-400">{kids}</blockquote>
    case 'table':
      return (
        <ScrollRegion key={key} label="Table" className="my-4 max-w-full overflow-x-auto">
          <table id={id} className={cn('min-w-full border-collapse text-dense', align)}>{wrapRows(b.c, kids)}</table>
        </ScrollRegion>
      )
    case 'thead':
      return <thead key={key} id={id}>{kids}</thead>
    case 'tbody':
      return <tbody key={key} id={id}>{kids}</tbody>
    case 'tfoot':
      return <tfoot key={key} id={id}>{kids}</tfoot>
    case 'tr':
      return <tr key={key} id={id} className="align-top">{kids}</tr>
    case 'td':
      return <td key={key} id={id} className={cn('px-3 py-2', align)}>{kids}</td>
    case 'th':
      return <th key={key} id={id} className={cn('px-3 py-2 font-semibold', align)}>{kids}</th>
    case 'ul':
      return <ul key={key} id={id} className="my-3 list-disc space-y-1 pl-6">{kids}</ul>
    case 'ol':
      return <ol key={key} id={id} className="my-3 list-decimal space-y-1 pl-6">{kids}</ol>
    case 'li':
      return <li key={key} id={id}>{kids}</li>
    case 'dl':
      return <dl key={key} id={id} className="my-3">{kids}</dl>
    case 'dt':
      return <dt key={key} id={id} className="font-semibold">{kids}</dt>
    case 'dd':
      return <dd key={key} id={id} className="ml-6">{kids}</dd>
    case 'h1':
    case 'h2':
      return <h2 key={key} id={id} className={cn(HEADING_CLASS[b.tag === 'h1' ? 1 : 2], align)}>{kids}</h2>
    case 'h3':
      return <h3 key={key} id={id} className={cn('mt-5 mb-2 text-lg', align)}>{kids}</h3>
    case 'h4':
    case 'h5':
    case 'h6':
      return <h4 key={key} id={id} className={cn('mt-5 mb-2 text-lg', align)}>{kids}</h4>
    default:
      return <div key={key} id={id} className={align}>{kids}</div>
  }
}

/**
 * Memoized on its props, so a page that re-renders on every composer keystroke does not
 * re-parse and re-render each issue, comment and README body it shows.
 */
export const MarkdownView = memo(function MarkdownView({
  source,
  className,
  repo = null,
  images = 'ask',
  links = null,
  suggestion = null,
  mode = repo === null ? 'comment' : 'document',
  imported = null,
}: {
  source: string
  className?: string
  /** The repo file this Markdown is from (README, a `.md` blob): resolves relative links and images. */
  repo?: MarkdownRepoContext | null
  /** `auto` for Markdown the repo itself publishes (README, release notes); `ask` for anyone's. */
  images?: 'auto' | 'ask'
  /** Link `#n`, commit ids and `@name` (repo pages, `repoLinks`); keep it referentially stable (memo). */
  links?: MarkdownLinks | null
  /** Render ```suggestion blocks as diffs (review comments); keep it referentially stable. */
  suggestion?: SuggestionContext | null
  /**
   * GitHub's two renderings: `comment` (issues, PRs, comments, reviews, release notes) makes a
   * single newline a line break; `document` (a README or `.md` file) makes it a space. Defaults
   * to `document` for a repo file, else `comment`.
   */
  mode?: 'comment' | 'document'
  /**
   * The `imported.url` of the document this body is from (an issue, PR, comment or review
   * copied from another forge), or null for one written here: its `@mentions` and other repos'
   * references then go to that forge, never to a Forge profile anyone could register (L-38).
   */
  imported?: string | null
}): JSX.Element {
  const notes = useId().replace(/[^a-zA-Z0-9]/g, '')
  const ctx = useMemo<RenderContext>(
    () => ({ repo, images, links, suggestion, refs: refsOf(links, imported), notes: `${notes}-`, budget: { left: MAX_AUTOLINKS } }),
    [repo, images, links, suggestion, imported, notes],
  )
  // Every render of the document spends a full budget (its text nodes render in this pass).
  ctx.budget.left = MAX_AUTOLINKS
  const blocks = useMemo(
    () => (source.length > MARKDOWN_MAX_CHARS ? null : parseMarkdown(source, { breaks: mode === 'comment' })),
    [source, mode],
  )
  if (blocks === null) {
    return (
      <div className={cn('text-prose text-anvil-700 dark:text-anvil-200', className)}>
        <p className="my-3 text-dense italic text-anvil-500 dark:text-anvil-400">
          Too large to render as Markdown ({formatBytes(source.length)}); shown as plain text.
        </p>
        <pre className="whitespace-pre-wrap break-words font-mono text-[13px]">{source}</pre>
      </div>
    )
  }
  const slugs = new Map<string, number>()
  return (
    <Ctx.Provider value={ctx}>
      {/* Author prose: its links are inline text links (WCAG 2.5.8 inline exception), so the
          mobile tap-target check (e2e/mobile.spec.ts) skips them. */}
      <div className={cn('text-prose text-anvil-700 dark:text-anvil-200', className)} data-tap-exempt="prose">
        {blocks.map((b, i) => renderBlock(b, `b-${i}`, slugs))}
      </div>
    </Ctx.Provider>
  )
})
