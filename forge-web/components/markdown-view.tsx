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
import { createContext, Fragment, memo, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ImageOff } from 'lucide-react'
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
import { imagePreviewType } from '@/lib/view/blob-view'
import { IMAGE_HOSTS_KEY, parseImageHosts, resolveRepoPath, splitHref, upgradeHttp, urlHostOf } from '@/lib/view/markdown-links'
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
 * Where `#n` and `@name` in plain text link to (GitHub's autolinks, D-223). Omitted: they stay
 * text (release notes, READMEs). `issueHref(n)` is the repo's issue route.
 */
export interface MarkdownLinks {
  readonly issueHref: (n: number) => string
  readonly profileHref?: (name: string) => string
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
}

const Ctx = createContext<RenderContext>({ repo: null, images: 'ask', links: null, suggestion: null })

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
      <pre className="overflow-x-auto font-mono">
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
      </pre>
    </div>
  )
}

function tableAlignClass(align: TableAlignment | 'left' | 'center' | 'right'): string {
  if (align === 'center') return 'text-center'
  if (align === 'right') return 'text-right'
  return 'text-left'
}

const LINK = 'text-forge-700 underline decoration-forge-700/30 underline-offset-2 hover:decoration-forge-700 dark:text-forge-400'

/** Plain text with its `#n` / `@name` references linked (when the page gave `links`). */
function AutolinkedText({ text }: { text: string }): JSX.Element {
  const { links } = useContext(Ctx)
  if (links === null) return <>{text}</>
  const pieces = splitRefs(text)
  if (pieces.length === 1 && pieces[0]?.t === 'text') return <>{text}</>
  return (
    <>
      {pieces.map((p, i) => {
        if (p.t === 'text') return <Fragment key={i}>{p.v}</Fragment>
        if (p.t === 'ref') {
          return (
            <Link key={i} href={links.issueHref(p.n)} className={LINK} data-autolink="ref">
              #{p.n}
            </Link>
          )
        }
        const href = (links.profileHref ?? ((n: string) => `/u/?name=${encodeURIComponent(n)}`))(p.name)
        return (
          <Link key={i} href={href} className={cn(LINK, 'font-medium')} data-autolink="mention">
            @{p.name}
          </Link>
        )
      })}
    </>
  )
}

/** A link: an in-page anchor, a repo-relative path (to the blob view), or an external URL. */
function MdLink({ href, id, children }: { href: string; id?: string; children: ReactNode }): JSX.Element {
  const { repo } = useContext(Ctx)
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
  if (isRelativeHref(href)) {
    const path = repo ? resolveRepoPath(repo.dir, splitHref(href).path) : null
    if (repo === null || path === null) return target === undefined ? <>{children}</> : <a id={target}>{children}</a>
    const fragment = splitHref(href).fragment
    const to = `${repoPathHref(repo, path, /\/$/.test(href.split(/[?#]/)[0] ?? '') ? '/repo/tree' : '/repo/blob')}${fragment ? `#${fragment}` : ''}`
    return (
      <Link id={target} href={to} className={LINK}>
        {children}
      </Link>
    )
  }
  return (
    <a id={target} href={href} target={href.startsWith('http') ? '_blank' : undefined} rel="noreferrer noopener" className={LINK}>
      {children}
    </a>
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

const EMPTY_HOSTS: readonly string[] = []
const hostListeners = new Set<() => void>()
let hostsRaw: string | null | undefined
let hostsCached: readonly string[] = EMPTY_HOSTS
/** Hosts loaded this session (one click), shared by every image on the page. */
const sessionHosts = new Set<string>()

function readHosts(): readonly string[] {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(IMAGE_HOSTS_KEY)
  } catch {
    raw = null
  }
  if (raw !== hostsRaw) {
    hostsRaw = raw
    hostsCached = parseImageHosts(raw)
  }
  return hostsCached
}

const notifyHosts = (): void => {
  for (const l of hostListeners) l()
}
const onHostsStorage = (e: StorageEvent): void => {
  if (e.key === IMAGE_HOSTS_KEY) notifyHosts()
}

/** One `storage` listener for the page (another tab's "Always allow"), however many images subscribe. */
function subscribeHosts(l: () => void): () => void {
  if (hostListeners.size === 0) window.addEventListener('storage', onHostsStorage)
  hostListeners.add(l)
  return () => {
    hostListeners.delete(l)
    if (hostListeners.size === 0) window.removeEventListener('storage', onHostsStorage)
  }
}

function allowHost(host: string, always: boolean): void {
  sessionHosts.add(host)
  if (always) {
    const next = [...new Set([...readHosts(), host])]
    try {
      window.localStorage.setItem(IMAGE_HOSTS_KEY, JSON.stringify(next))
    } catch {
      /* private mode: this session only */
    }
  }
  notifyHosts()
}

function useHostAllowed(host: string | null): boolean {
  return useSyncExternalStore(
    subscribeHosts,
    () => host !== null && (sessionHosts.has(host) || readHosts().includes(host)),
    () => false,
  )
}

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
  if (isRelativeHref(src)) return <RepoImage {...props} />
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

/**
 * Read a relative image's blob, never more than {@link REPO_IMAGE_MAX_BYTES}: the reader
 * refuses an object whose header says it is larger before inflating it, and `readBlob` checks
 * the result. (A stored entry's length is only a hint: a delta or a run of zeros is tiny in
 * the pack and huge once inflated, so it is trusted only to skip an undeltified blob early.)
 */
export async function readRepoImage(reader: BrowseReader, tipOid: string, path: string): Promise<{ bytes: Uint8Array; type: string }> {
  const slash = path.lastIndexOf('/')
  const entries = await entriesAt(reader, tipOid, slash === -1 ? '' : path.slice(0, slash))
  const entry = findEntry(entries, slash === -1 ? path : path.slice(slash + 1))
  if (entry === undefined) throw new Error('not found')
  if ((knownMinSize(reader, entry.oid) ?? 0) > REPO_IMAGE_MAX_BYTES) throw new Error('too large')
  const bytes = await readBlob(reader, entry.oid, REPO_IMAGE_MAX_BYTES)
  const type = imagePreviewType(path, bytes)
  if (type === null) throw new Error('not an image')
  return { bytes, type }
}

/** A relative image: read from the repo's own objects (hash-checked), never fetched from a host. */
function RepoImage({ src, alt, width, height }: ImageProps): JSX.Element | null {
  const { repo } = useContext(Ctx)
  const path = repo ? resolveRepoPath(repo.dir, splitHref(src).path) : null
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
          <code key={key} className="rounded bg-anvil-100 px-1 py-0.5 text-[0.9em] text-forge-700 dark:bg-anvil-800 dark:text-forge-300">
            {n.v}
          </code>
        )
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
    .map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'image' ? n.alt : n.t === 'br' ? ' ' : textOf(n.c)))
    .join('')
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
      return <p key={key} className="my-3 leading-relaxed">{renderInline(b.c, key)}</p>
    case 'inline':
      return <Fragment key={key}>{renderInline(b.c, key)}</Fragment>
    case 'code':
      if (b.lang === 'suggestion') return <SuggestionBlock key={key} text={b.v} />
      return (
        <ScrollRegion as="pre" key={key} label="Code block" className="my-3 overflow-x-auto rounded-md border border-anvil-200 bg-anvil-50 p-3 text-[13px] dark:border-anvil-800 dark:bg-anvil-950">
          <code>{b.v}</code>
        </ScrollRegion>
      )
    case 'list': {
      const tasks = b.tasks
      const items = b.items.map((it, i) => {
        const task = tasks?.[i] ?? null
        return (
          <li key={i} className={task !== null ? 'list-none' : undefined}>
            {task !== null ? (
              <input type="checkbox" checked={task} disabled aria-label={task ? 'Done' : 'Not done'} className="mr-1.5 -ml-5 align-middle" />
            ) : null}
            {renderInline(it, `${key}-${i}`)}
          </li>
        )
      })
      return b.ordered ? (
        <ol key={key} className="my-3 list-decimal space-y-1 pl-6">{items}</ol>
      ) : (
        <ul key={key} className="my-3 list-disc space-y-1 pl-6">{items}</ul>
      )
    }
    case 'quote':
      return (
        <blockquote key={key} className="my-3 border-l-2 border-forge-500/40 pl-4 text-anvil-500 dark:text-anvil-400">
          {b.c.map((inner, i) => renderBlock(inner, `${key}-${i}`, slugs))}
        </blockquote>
      )
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
}: {
  source: string
  className?: string
  /** The repo file this Markdown is from (README, a `.md` blob): resolves relative links and images. */
  repo?: MarkdownRepoContext | null
  /** `auto` for Markdown the repo itself publishes (README, release notes); `ask` for anyone's. */
  images?: 'auto' | 'ask'
  /** Link `#n` / `@name` (issue and PR pages); keep it referentially stable (memo). */
  links?: MarkdownLinks | null
  /** Render ```suggestion blocks as diffs (review comments); keep it referentially stable. */
  suggestion?: SuggestionContext | null
}): JSX.Element {
  const ctx = useMemo<RenderContext>(() => ({ repo, images, links, suggestion }), [repo, images, links, suggestion])
  const blocks = useMemo(() => (source.length > MARKDOWN_MAX_CHARS ? null : parseMarkdown(source)), [source])
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
