'use client'

/**
 * The route a page reads, while the address bar shows its short URL (CJ-6).
 *
 * Every page lives on a canonical query route (`/repo/issue/?owner=alice&name=project&number=7`).
 * Once a public repo's page has loaded, {@link useShortAddressBar} puts its short URL
 * (`/alice/project/issues/7`) in the address bar. Next's router keeps the canonical route, but Back
 * and Forward restore an entry from the address bar, so the router can then hand back the short
 * URL. {@link usePathname} and {@link useSearchParams} read the canonical route either way: use
 * them, never Next's own (lint enforces it).
 */

import { useEffect, useMemo } from 'react'
// eslint-disable-next-line no-restricted-imports -- the one place that reads the router's own URL
import { usePathname as useRouterPathname, useSearchParams as useRouterSearchParams, type ReadonlyURLSearchParams } from 'next/navigation'

import { BASE_PATH, canonicalOfShort, sameRoute, shortRouteFor } from '@/lib/short-url'

/** `pathname?search`, as one string. */
const routeKey = (pathname: string, search: string): string => (search ? `${pathname}?${search}` : pathname)

/**
 * The canonical route of each short URL this tab put in the address bar. The shim's expansion
 * gives the same page, but this is the route exactly as the page read it (an owner's identity id,
 * not the DPNS name the short URL shows), so going Back reads nothing again.
 */
const shortened = new Map<string, string>()
/** The same, by path alone: a short path names its canonical pathname whatever its query. */
const shortenedPaths = new Map<string, string>()

/** The canonical route (`pathname?search`, no base path) of the router's `pathname?search`. */
export function canonicalRoute(pathname: string, search: string): string {
  const key = routeKey(pathname, search)
  return shortened.get(key) ?? canonicalOfShort(pathname, search) ?? key
}

/** The route's pathname (`/repo/issue/`), also while the address bar shows a short URL. */
export function usePathname(): string {
  const pathname = useRouterPathname()
  const known = shortenedPaths.get(pathname)
  if (known !== undefined) return known
  const canonical = canonicalOfShort(pathname, '')
  return canonical === null ? pathname : canonical.slice(0, canonical.indexOf('?'))
}

/** The route's query (`owner`, `name`, `number`…), also while the address bar shows a short URL. */
export function useSearchParams(): ReadonlyURLSearchParams {
  const pathname = useRouterPathname()
  const params = useRouterSearchParams()
  const search = params.toString()
  const key = routeKey(pathname, search)
  const canonical = canonicalRoute(pathname, search)
  const expanded = useMemo(() => (canonical === key ? null : new URLSearchParams(canonical.slice(canonical.indexOf('?') + 1))), [canonical, key])
  // Next's read-only params and these differ only in refusing writes, which no caller makes.
  return expanded === null ? params : (expanded as ReadonlyURLSearchParams)
}

/** `url`'s route as the router reads it: its path without the base path, and its query. */
function routeOfUrl(url: URL): string | null {
  const { pathname } = url
  if (BASE_PATH !== '' && pathname !== BASE_PATH && !pathname.startsWith(`${BASE_PATH}/`)) return null
  const path = pathname.slice(BASE_PATH.length) || '/'
  return canonicalRoute(path, new URLSearchParams(url.search).toString())
}

/**
 * A click on a link to the page already open (its own tab, the repo title on the repo's home)
 * while the address bar shows the page's short URL. Next would push the canonical route as a
 * new entry, since the address bar no longer matches its own: Back would then lead to the same
 * page, and the address bar would keep the long URL. Scroll to the top instead, as a click on the
 * current page does on GitHub. Returns whether it handled the click.
 */
function followSamePageLink(e: MouseEvent, win: Window & typeof globalThis = window): boolean {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false
  const a = e.target instanceof win.Element ? e.target.closest('a[href]') : null
  if (!(a instanceof win.HTMLAnchorElement) || (a.target !== '' && a.target !== '_self') || a.hasAttribute('download')) return false
  const to = new URL(a.href, win.location.href)
  const here = new URL(win.location.href)
  // A fragment is the browser's to follow (`lib/hash-links.ts`).
  if (to.origin !== here.origin || to.hash !== '') return false
  // Only while the address bar shows another URL than the route: otherwise Next replaces the entry.
  if (to.pathname === here.pathname && to.search === here.search) return false
  const route = routeOfUrl(to)
  const current = routeOfUrl(here)
  if (route === null || current === null || !sameRoute(route, current)) return false
  e.preventDefault()
  win.scrollTo(0, 0)
  return true
}

/** Handle {@link followSamePageLink} clicks app-wide. Returns the uninstall. */
export function installSamePageLinks(win: Window & typeof globalThis = window): () => void {
  // Capturing: before Next's Link handler, which skips a click already handled.
  const onClick = (e: MouseEvent): void => void followSamePageLink(e, win)
  win.document.addEventListener('click', onClick, true)
  return () => win.document.removeEventListener('click', onClick, true)
}

/**
 * Show the short URL of the page in the address bar, once the page knows its repo is public
 * (a private repo's links carry per-tab tokens, `lib/view/private-nav.ts`), with the owner's DPNS
 * name once the page has read it. `ownerName` is undefined while it is still being read (the bar
 * waits, rather than show the id and then the name), and null when the owner has none. Copy,
 * reload and Back keep working: the short URL opens the same route through the 404.html shim.
 *
 * The router is not told: a `history.replaceState` it sees restores its state, and a restore drops
 * a navigation still in flight (a link clicked just as the owner's name resolved would do
 * nothing). It keeps the canonical route, and rewrites the address bar itself on its next
 * navigation; this then runs again for the new route.
 */
export function useShortAddressBar(visibility: string, ownerName: string | null | undefined): void {
  const pathname = useRouterPathname()
  const search = useRouterSearchParams().toString()
  useEffect(() => {
    if (visibility !== 'public' || ownerName === undefined) return
    // Only an entry the router wrote: its state (`__NA` and its tree) keeps Next's patched
    // replaceState from treating this as a restore. Any other entry is left alone.
    const state: unknown = window.history.state
    if (state === null || typeof state !== 'object' || !('__NA' in state)) return
    const canonical = canonicalRoute(pathname, search)
    const at = canonical.indexOf('?')
    const short = shortRouteFor(at < 0 ? canonical : canonical.slice(0, at), at < 0 ? '' : canonical.slice(at + 1), ownerName)
    if (short === null) return
    const href = `${BASE_PATH}${short}`
    const here = `${window.location.pathname}${window.location.search}`
    if (here === href) return
    const [shortPath = '', shortSearch = ''] = short.split('?')
    shortened.set(routeKey(shortPath, new URLSearchParams(shortSearch).toString()), canonical)
    shortenedPaths.set(shortPath, at < 0 ? canonical : canonical.slice(0, at))
    window.history.replaceState(state, '', `${href}${window.location.hash}`)
  }, [visibility, ownerName, pathname, search])
}
