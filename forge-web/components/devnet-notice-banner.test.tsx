// @vitest-environment jsdom
/**
 * The "devnet is moving" banner: nothing when the notice is off (and on a non-devnet build), a
 * dismissible heads-up for `upcoming` whose dismissal persists per mode, and a banner for
 * `moving` that cannot be dismissed. A polite status, a labelled dismiss button, a link to the guide.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { NetworkConfig } from '@/lib/constants'
import { DEVNET_MOVE_DOC, devnetNoticeDismissKey, type DevnetNotice } from '@/lib/devnet-notice'
import { DevnetNoticeBanner } from './devnet-notice-banner'

const BONSIA: NetworkConfig = {
  network: 'devnet',
  devnetName: 'bonsia',
  key: 'devnet-bonsia',
  dapiAddresses: [],
  quorumBaseUrl: null,
  dpnsContractId: 'dpns',
  v2: null,
  retired: true,
}
const TESTNET: NetworkConfig = { ...BONSIA, network: 'testnet', devnetName: null, key: 'testnet' }

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.localStorage.clear()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

function render(notice: DevnetNotice | null, config: NetworkConfig = BONSIA): void {
  act(() => root.render(<DevnetNoticeBanner notice={notice} config={config} />))
}
const banner = (): HTMLElement | null => el.querySelector('[data-testid="devnet-notice-banner"]')
const dismissButton = (): HTMLButtonElement | null => el.querySelector('button')

describe('DevnetNoticeBanner', () => {
  it('shows nothing when the notice is off', () => {
    render(null)
    expect(banner()).toBeNull()
  })

  it('shows nothing on a build that does not target a devnet', () => {
    render('upcoming', TESTNET)
    expect(banner()).toBeNull()
  })

  it('upcoming: a polite status with the heads-up copy and a link to the guide', () => {
    render('upcoming')
    const b = banner()!
    expect(b.getAttribute('role')).toBe('status')
    expect(b.textContent).toContain(
      'bonsia is moving to a new devnet soon. Repos, issues, stars and keys on this devnet will be wiped. Mirrors need setting up again with the /mirror wizard, and your own repos will need a re-push from your clone.',
    )
    const link = b.querySelector('a')!
    expect(link.getAttribute('href')).toBe(DEVNET_MOVE_DOC)
    expect(DEVNET_MOVE_DOC).toMatch(/docs\/guides\/devnet-move\.md$/)
  })

  it('upcoming: the dismiss button is a labelled, focusable button that hides it and remembers that', () => {
    render('upcoming')
    const close = dismissButton()!
    expect(close.getAttribute('aria-label')).toBe('Dismiss this notice')
    expect(close.disabled).toBe(false)
    expect(close.tabIndex).toBeGreaterThanOrEqual(0)
    act(() => close.click())
    expect(banner()).toBeNull()
    expect(window.localStorage.getItem(devnetNoticeDismissKey('upcoming'))).toBe('1')
  })

  it('upcoming: stays hidden for someone who dismissed it before', () => {
    window.localStorage.setItem(devnetNoticeDismissKey('upcoming'), '1')
    render('upcoming')
    expect(banner()).toBeNull()
  })

  it('moving: cannot be dismissed, and says writing is paused', () => {
    render('moving')
    const b = banner()!
    expect(b.getAttribute('role')).toBe('status')
    expect(b.getAttribute('data-notice')).toBe('moving')
    expect(b.textContent).toContain('Dash Forge moved to devnet sakura (Platform v5); bonsia was retired.')
    expect(b.textContent).toContain('Writing is paused')
    expect(dismissButton()).toBeNull()
    expect(b.querySelector('a')!.getAttribute('href')).toBe(DEVNET_MOVE_DOC)
  })

  it('moving: is in the server-rendered HTML (it cannot be dismissed, so nothing waits for storage)', () => {
    const html = renderToString(<DevnetNoticeBanner notice="moving" config={BONSIA} />)
    expect(html).toContain('data-testid="devnet-notice-banner"')
    expect(html).toContain('Writing is paused')
    expect(renderToString(<DevnetNoticeBanner notice="upcoming" config={BONSIA} />)).toBe('')
  })

  it('moving: still shows for someone who dismissed the upcoming notice', () => {
    window.localStorage.setItem(devnetNoticeDismissKey('upcoming'), '1')
    render('moving')
    expect(banner()).not.toBeNull()
  })

  it('moving: ignores a stale dismissal of its own', () => {
    window.localStorage.setItem(devnetNoticeDismissKey('moving'), '1')
    render('moving')
    expect(banner()).not.toBeNull()
  })
})
