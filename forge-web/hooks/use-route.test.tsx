// @vitest-environment jsdom
/**
 * The address bar keeps a public repo page's short URL (CJ-6), and the page reads its canonical
 * route all the same: as loaded, after Back restores the short URL, and after a reload.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** What Next's router holds: the URL it last navigated to or restored. */
const router = vi.hoisted(() => ({ pathname: '/', search: '' }))
vi.mock('next/navigation', () => ({
  usePathname: () => router.pathname,
  useSearchParams: () => new URLSearchParams(router.search),
}))

import { useRepoAddress } from './use-query-param'
import { usePathname, useSearchParams, useShortAddressBar } from './use-route'

const ID = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'

let root: Root
let el: HTMLDivElement
let seen: { pathname: string; search: string; owner: string }
function Page({ visibility, ownerName }: { visibility: string; ownerName?: string }): null {
  const pathname = usePathname()
  const search = useSearchParams().toString()
  const { owner } = useRepoAddress()
  seen = { pathname, search, owner }
  useShortAddressBar(visibility, ownerName)
  return null
}

/** The router at `href` (as Next would be after a navigation, or after Back restored it), rendered. */
function render(href: string, visibility = 'public', ownerName?: string): void {
  const [pathname, search = ''] = href.split('?') as [string, string?]
  router.pathname = pathname
  router.search = search
  act(() => root.render(<Page visibility={visibility} ownerName={ownerName} />))
}

/** Load `href` in the tab: the address bar, the router's own state, then the page. */
function load(href: string, visibility = 'public', ownerName?: string): void {
  window.history.replaceState({ __NA: true, tree: 'T' }, '', `${href}#L3`)
  render(href, visibility, ownerName)
}

const bar = (): string => `${window.location.pathname}${window.location.search}${window.location.hash}`

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  el = document.createElement('div')
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  vi.restoreAllMocks()
})

describe('useShortAddressBar', () => {
  it('puts the short URL in the address bar, keeping the router’s state and the fragment', () => {
    const replace = vi.spyOn(window.history, 'replaceState')
    load('/repo/issues/?owner=alice&name=project&q=is%3Aclosed&page=2')
    expect(bar()).toBe('/alice/project/issues?q=is%3Aclosed&page=2#L3')
    // The router's own marker: Next's patched replaceState then leaves its state alone.
    expect(replace.mock.calls.at(-1)?.[0]).toEqual({ __NA: true, tree: 'T' })
    expect(seen).toEqual({ pathname: '/repo/issues/', search: 'owner=alice&name=project&q=is%3Aclosed&page=2', owner: 'alice' })
  })

  it('writes the owner by the DPNS name the page read, and Back still reads the route by id', () => {
    load(`/repo/issue/?owner=${ID}&name=project&number=7`)
    expect(bar()).toBe(`/${ID}/project/issues/7#L3`)
    render(`/repo/issue/?owner=${ID}&name=project&number=7`, 'public', 'alice.dash')
    expect(bar()).toBe('/alice/project/issues/7#L3')
    // Back to this entry: the router restores the short URL from the address bar.
    render('/alice/project/issues/7')
    expect(seen).toEqual({ pathname: '/repo/issue/', search: `owner=${ID}&name=project&number=7`, owner: ID })
  })

  it('reads a short URL it did not write as the 404 shim opens it', () => {
    render('/bob/tools/pull/4/files?repo=R1')
    expect(seen).toEqual({ pathname: '/repo/pull/', search: 'owner=bob&name=tools&number=4&tab=files&repo=R1', owner: 'bob' })
  })

  it('leaves a private repo’s page, a page with no short form and a non-repo page on their routes', () => {
    const replace = vi.spyOn(window.history, 'replaceState')
    load('/repo/tree/?owner=alice&name=secret&ref=t1&path=t2', 'private')
    load('/repo/settings/?owner=alice&name=project')
    load('/explore/?q=x')
    expect(replace.mock.calls.map((c) => c[2])).toEqual([
      '/repo/tree/?owner=alice&name=secret&ref=t1&path=t2#L3',
      '/repo/settings/?owner=alice&name=project#L3',
      '/explore/?q=x#L3',
    ])
    expect(seen).toEqual({ pathname: '/explore/', search: 'q=x', owner: '' })
  })

  it('does not rewrite an address bar that already shows the short URL', () => {
    load('/repo/?owner=alice&name=project')
    const replace = vi.spyOn(window.history, 'replaceState')
    render('/alice/project')
    expect(replace).not.toHaveBeenCalled()
    expect(seen.pathname).toBe('/repo/')
  })
})
