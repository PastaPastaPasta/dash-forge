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
import { installSamePageLinks, usePathname, useSearchParams, useShortAddressBar } from './use-route'

const ID = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'

let root: Root
let el: HTMLDivElement
let seen: { pathname: string; search: string; owner: string }
function Page({ visibility, ownerName }: { visibility: string; ownerName: string | null | undefined }): null {
  const pathname = usePathname()
  const search = useSearchParams().toString()
  const { owner } = useRepoAddress()
  seen = { pathname, search, owner }
  useShortAddressBar(visibility, ownerName)
  return null
}

/** The router at `href` (as Next would be after a navigation, or after Back restored it), rendered. */
/** The owner's name still being read (an explicit `undefined` would take the default). */
const READING = Symbol('reading')
type OwnerName = string | null | typeof READING

function render(href: string, visibility = 'public', name: OwnerName = null): void {
  const ownerName = name === READING ? undefined : name
  const [pathname, search = ''] = href.split('?') as [string, string?]
  router.pathname = pathname
  router.search = search
  act(() => root.render(<Page visibility={visibility} ownerName={ownerName} />))
}

/** Load `href` in the tab: the address bar, the router's own state, then the page. */
function load(href: string, visibility = 'public', name: OwnerName = null): void {
  window.history.replaceState({ __NA: true, tree: 'T' }, '', `${href}#L3`)
  render(href, visibility, name)
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

  it('waits for the owner’s name before it shortens: the id never flashes in the bar', () => {
    const replace = vi.spyOn(window.history, 'replaceState')
    load(`/repo/pulls/?owner=${ID}&name=project`, 'public', READING)
    expect(replace.mock.calls.map((c) => c[2])).toEqual([`/repo/pulls/?owner=${ID}&name=project#L3`])
    render(`/repo/pulls/?owner=${ID}&name=project`, 'public', 'bob.dash')
    expect(bar()).toBe('/bob/project/pulls#L3')
    expect(replace).toHaveBeenCalledTimes(2)
  })

  it('writes the owner by id when the name is itself shaped like another identity’s id', () => {
    const other = '9qy5ZgYUH5ZrZzS2MuSDThCGaZrz9qiDLE9ZyLGFNRWr'
    load(`/repo/?owner=${ID}&name=project`, 'public', `${other}.dash`)
    expect(bar()).toBe(`/${other}.dash/project#L3`)
    load(`/repo/?owner=${ID}&name=tools`, 'public', other)
    expect(bar()).toBe(`/${ID}/tools#L3`)
  })

  it('leaves an entry the router did not write alone', () => {
    window.history.replaceState(null, '', '/repo/?owner=alice&name=project')
    const replace = vi.spyOn(window.history, 'replaceState')
    render('/repo/?owner=alice&name=project')
    expect(replace).not.toHaveBeenCalled()
    expect(bar()).toBe('/repo/?owner=alice&name=project')
  })

  it('reads the pathname it shortened as the page read it, after Back', () => {
    load('/repo/stargazers?owner=alice&name=stars')
    expect(bar()).toBe('/alice/stars/stargazers#L3')
    render('/alice/stars/stargazers')
    expect(seen.pathname).toBe('/repo/stargazers')
  })

  it('does not rewrite an address bar that already shows the short URL', () => {
    load('/repo/?owner=alice&name=project')
    const replace = vi.spyOn(window.history, 'replaceState')
    render('/alice/project')
    expect(replace).not.toHaveBeenCalled()
    expect(seen.pathname).toBe('/repo/')
  })
})

describe('a link to the page already open', () => {
  /** Click a link to `href` on the page: whether the page handled it before Next's Link would. */
  function click(href: string, init: MouseEventInit = {}): boolean {
    const a = document.createElement('a')
    a.href = href
    a.textContent = 'Issues'
    document.body.append(a)
    let handled = false
    const uninstall = installSamePageLinks()
    // Where React's handlers (Next's Link) run; and no navigation in the test's document.
    const onBubble = (e: MouseEvent): void => {
      handled = e.defaultPrevented
      e.preventDefault()
    }
    document.addEventListener('click', onBubble)
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }))
    document.removeEventListener('click', onBubble)
    uninstall()
    a.remove()
    return handled
  }

  it('scrolls to the top instead of pushing the long URL as a new entry', () => {
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
    load(`/repo/issues/?owner=${ID}&name=project&q=is%3Aopen`, 'public', 'alice.dash')
    expect(bar()).toBe('/alice/project/issues?q=is%3Aopen#L3')
    const push = vi.spyOn(window.history, 'pushState')
    // The same route, its params in another order.
    expect(click(`/repo/issues/?name=project&owner=${ID}&q=is%3Aopen`)).toBe(true)
    expect(scroll).toHaveBeenCalledWith(0, 0)
    expect(push).not.toHaveBeenCalled()
    expect(bar()).toBe('/alice/project/issues?q=is%3Aopen#L3')
  })

  it('leaves every other link to the router', () => {
    load(`/repo/issues/?owner=${ID}&name=project`, 'public', 'alice.dash')
    // Another page, another query, a fragment, a modified click, a new tab, another site.
    expect(click(`/repo/pulls/?owner=${ID}&name=project`)).toBe(false)
    expect(click(`/repo/issues/?owner=${ID}&name=project&q=is%3Aclosed`)).toBe(false)
    expect(click(`/repo/issues/?owner=${ID}&name=project#top`)).toBe(false)
    expect(click(`/repo/issues/?owner=${ID}&name=project`, { metaKey: true })).toBe(false)
    expect(click('https://example.com/repo/issues/')).toBe(false)
    // An address bar that shows the route itself (a private repo): Next replaces the entry.
    load(`/repo/issues/?owner=${ID}&name=secret`, 'private')
    expect(click(`/repo/issues/?owner=${ID}&name=secret`)).toBe(false)
  })
})
