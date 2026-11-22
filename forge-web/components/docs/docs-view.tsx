'use client'

/**
 * A page of the in-app docs hub (`/docs/…`): the sidebar of every listed document, the document
 * rendered by MarkdownView (its links to other documents stay in the app), "On this page", and
 * the previous and next document. The Markdown is the repository's own `docs/`, read at build
 * time, so it is trusted the way the app's own copy is: images load without asking.
 */

import Link from 'next/link'
import { ArrowLeft, ArrowRight, BookOpen, ExternalLink } from 'lucide-react'
import { useCallback, useEffect, useMemo } from 'react'
import { AppShell } from '@/components/app-shell'
import { MarkdownView } from '@/components/markdown-view'
import { DOC_PAGES, DOC_SECTIONS, docBySlug, docRoute, docSourceUrl, resolveDocHref } from '@/lib/docs/catalog'
import { cn } from '@/lib/utils'
import { outline } from './outline'

const NAV_LINK = 'flex items-center rounded-md px-2 py-1 text-dense coarse:min-h-11'

function Sidebar({ current, idPrefix }: { current: string; idPrefix: string }): JSX.Element {
  return (
    <nav aria-label="Docs" className="space-y-5">
      {DOC_SECTIONS.map((s) => {
        const headingId = `${idPrefix}-${s.title.replace(/\W+/g, '-')}`
        return (
          <div key={s.title}>
            <p id={headingId} className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-anvil-500 dark:text-anvil-400">
              {s.title}
            </p>
            <ul aria-labelledby={headingId}>
              {s.pages.map((p) => {
                const here = p.slug === current
                return (
                  <li key={p.slug}>
                    <Link
                      href={docRoute(p)}
                      aria-current={here ? 'page' : undefined}
                      className={cn(
                        NAV_LINK,
                        here
                          ? 'bg-forge-50 font-medium text-forge-800 dark:bg-forge-950/40 dark:text-forge-300'
                          : 'text-anvil-700 hover:bg-anvil-100 dark:text-anvil-300 dark:hover:bg-anvil-800',
                      )}
                    >
                      {p.title}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </nav>
  )
}

/** Scrolls to `#name` as GitHub does: the heading's id is `user-content-name`. */
function useUserContentHash(): void {
  useEffect(() => {
    const go = (): void => {
      const raw = window.location.hash.slice(1)
      if (raw === '') return
      let name = raw
      try {
        name = decodeURIComponent(raw)
      } catch {
        /* as written */
      }
      if (document.getElementById(name) !== null) return
      document.getElementById(`user-content-${name.toLowerCase()}`)?.scrollIntoView()
    }
    go()
    window.addEventListener('hashchange', go)
    return () => window.removeEventListener('hashchange', go)
  }, [])
}

export function DocsView({ slug, title, body }: { slug: string; title: string; body: string }): JSX.Element {
  const page = docBySlug(slug)!
  const resolve = useCallback((href: string) => resolveDocHref(page, href), [page])
  const toc = useMemo(() => outline(body), [body])
  const section = DOC_SECTIONS.find((s) => s.pages.includes(page))
  const i = DOC_PAGES.indexOf(page)
  const prev = i > 0 ? DOC_PAGES[i - 1] : undefined
  const next = DOC_PAGES[i + 1]
  useUserContentHash()

  return (
    <AppShell wide staticContent>
      <div className="lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-8 xl:grid-cols-[220px_minmax(0,1fr)_200px]" data-testid="docs-page">
        <aside className="hidden lg:block">
          <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pb-6">
            <Sidebar current={slug} idPrefix="docs-side" />
          </div>
        </aside>

        <div className="min-w-0">
          <details className="mb-4 rounded-lg border border-anvil-200 dark:border-anvil-800 lg:hidden" data-testid="docs-mobile-nav">
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-dense font-medium coarse:min-h-11">
              <BookOpen className="h-4 w-4 text-fg-muted" aria-hidden /> All docs
            </summary>
            <div className="border-t border-anvil-200 px-1 py-3 dark:border-anvil-800">
              <Sidebar current={slug} idPrefix="docs-drawer" />
            </div>
          </details>

          <article className="mx-auto max-w-3xl">
            <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
              <Link href="/docs/" className="hit-area hover:underline">
                Docs
              </Link>
              {section ? <> / {section.title}</> : null}
            </p>
            <h1 className="mt-1 text-3xl leading-tight tracking-tight">{title}</h1>
            <MarkdownView source={body} mode="document" images="auto" docLinks={resolve} className="mt-4 [&_h2]:scroll-mt-20 [&_h3]:scroll-mt-20" />

            <div className="mt-10 flex flex-wrap items-stretch justify-between gap-3 border-t border-anvil-200 pt-6 dark:border-anvil-800">
              {prev ? (
                <Link href={docRoute(prev)} className="group flex min-w-0 flex-1 flex-col rounded-lg border border-anvil-200 px-4 py-3 hover:border-forge-400 dark:border-anvil-800" data-testid="docs-prev">
                  <span className="flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400">
                    <ArrowLeft className="h-3 w-3" aria-hidden /> Previous
                  </span>
                  <span className="truncate text-dense font-medium group-hover:text-forge-700 dark:group-hover:text-forge-400">{prev.title}</span>
                </Link>
              ) : (
                <span className="flex-1" />
              )}
              {next ? (
                <Link href={docRoute(next)} className="group flex min-w-0 flex-1 flex-col items-end rounded-lg border border-anvil-200 px-4 py-3 text-right hover:border-forge-400 dark:border-anvil-800" data-testid="docs-next">
                  <span className="flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400">
                    Next <ArrowRight className="h-3 w-3" aria-hidden />
                  </span>
                  <span className="max-w-full truncate text-dense font-medium group-hover:text-forge-700 dark:group-hover:text-forge-400">{next.title}</span>
                </Link>
              ) : null}
            </div>
            <p className="mt-4 text-[12px] text-anvil-500 dark:text-anvil-400">
              This page is <code className="font-mono">{page.path}</code> from the Dash Forge repository, as of this build.{' '}
              <a href={docSourceUrl(page)} target="_blank" rel="noreferrer noopener" className="hit-area inline-flex items-center gap-1 underline">
                View or edit it on GitHub <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            </p>
          </article>
        </div>

        {toc.length > 1 ? (
          <aside className="hidden xl:block" aria-labelledby="docs-toc">
            <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pb-6">
              <h2 id="docs-toc" className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-anvil-500 dark:text-anvil-400">
                On this page
              </h2>
              <ul className="space-y-1 border-l border-anvil-200 dark:border-anvil-800">
                {toc.map((h) => (
                  <li key={h.id}>
                    <a
                      href={`#${h.id}`}
                      className={cn('-ml-px block border-l border-transparent py-0.5 text-[12px] text-anvil-600 hover:border-forge-500 hover:text-forge-700 dark:text-anvil-400 dark:hover:text-forge-400', h.level === 3 ? 'pl-6' : 'pl-3')}
                    >
                      {h.text}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        ) : null}
      </div>
    </AppShell>
  )
}
