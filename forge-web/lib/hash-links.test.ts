// @vitest-environment jsdom
/**
 * QW4-005: an in-page `#fragment` link is followed through `history.pushState` (which Next's
 * router patches to copy its state onto the entry), so Back to it restores the page that pushed
 * it; the browser's own follow left a stateless entry the router ignores.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installHashLinkHistory } from './hash-links'

let uninstall: () => void
let pushState: ReturnType<typeof vi.spyOn>
const scrolled: string[] = []
const realScroll = HTMLElement.prototype.scrollIntoView

function link(href: string, attrs: Record<string, string> = {}): HTMLAnchorElement {
  const a = document.createElement('a')
  a.setAttribute('href', href)
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v)
  a.textContent = 'go'
  document.body.appendChild(a)
  return a
}
function click(a: HTMLElement, init: MouseEventInit = {}): MouseEvent {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })
  a.dispatchEvent(e)
  return e
}

beforeEach(() => {
  window.history.replaceState(null, '', '/repo/blob/?owner=o&name=dash&path=doc%2FREADME.md')
  document.body.innerHTML = '<h2 id="user-content-building">Building</h2><main id="main" tabindex="-1"></main>'
  scrolled.length = 0
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolled.push(this.id)
  }
  pushState = vi.spyOn(window.history, 'pushState')
  uninstall = installHashLinkHistory()
})
afterEach(() => {
  uninstall()
  pushState.mockRestore()
  HTMLElement.prototype.scrollIntoView = realScroll
  document.body.innerHTML = ''
})

describe('in-page fragment links (QW4-005)', () => {
  it('push an entry through history.pushState, scroll to the target, and fire hashchange', () => {
    const changes: string[] = []
    const onHash = (e: HashChangeEvent): void => {
      changes.push(e.newURL)
    }
    window.addEventListener('hashchange', onHash)
    const e = click(link('#user-content-building'))
    window.removeEventListener('hashchange', onHash)
    expect(e.defaultPrevented).toBe(true)
    expect(pushState).toHaveBeenCalledWith(null, '', '#user-content-building')
    expect(window.location.search).toBe('?owner=o&name=dash&path=doc%2FREADME.md')
    expect(window.location.hash).toBe('#user-content-building')
    expect(scrolled).toEqual(['user-content-building'])
    expect(changes).toEqual([window.location.href])
  })

  it('focus a target that takes focus (the skip link)', () => {
    click(link('#main'))
    expect(document.activeElement?.id).toBe('main')
  })

  it('open a closed <details> around the target, and focus no link it lands on', () => {
    document.body.insertAdjacentHTML('beforeend', '<details id="d"><summary>More</summary><a id="user-content-fnref-1" href="#x">1</a></details>')
    click(link('#user-content-fnref-1'))
    expect((document.getElementById('d') as HTMLDetailsElement).open).toBe(true)
    expect(document.activeElement?.id).not.toBe('user-content-fnref-1')
  })

  it("mark a fragment entry no click made, so Back to it is not ignored", () => {
    const replace = vi.spyOn(window.history, 'replaceState')
    window.location.hash = '#typed'
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(replace).toHaveBeenCalledWith(null, '', window.location.href)
    replace.mockRestore()
  })

  it('add no entry for the fragment already shown, but still scroll to it', () => {
    click(link('#user-content-building'))
    pushState.mockClear()
    click(link('#user-content-building'))
    expect(pushState).not.toHaveBeenCalled()
    expect(scrolled).toEqual(['user-content-building', 'user-content-building'])
  })

  it('leave other clicks to the browser', () => {
    const cases: [HTMLAnchorElement, MouseEventInit][] = [
      [link('#x'), { metaKey: true }],
      [link('#x'), { ctrlKey: true }],
      [link('#x'), { button: 1 }],
      [link('#x', { target: '_blank' }), {}],
      [link('/repo/blob/?owner=o&name=dash&path=doc%2Fbuild-unix.md'), {}],
      [link('https://example.com/#x'), {}],
    ]
    for (const [a, init] of cases) expect(click(a, init).defaultPrevented).toBe(false)
    // A handler that already took the click (the file view's line numbers).
    const handled = link('#L5')
    handled.addEventListener('click', (e) => e.preventDefault())
    click(handled)
    expect(pushState).not.toHaveBeenCalled()
  })
})
