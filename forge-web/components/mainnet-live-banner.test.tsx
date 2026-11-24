// @vitest-environment jsdom
/**
 * The "Forge is live on mainnet" banner on a test network's build: nothing without a mainnet
 * site, nothing on mainnet, a dismissible link to the mainnet site whose dismissal persists.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { NetworkConfig } from '@/lib/constants'
import type { OtherSite } from '@/lib/network-sites'
import { MAINNET_LIVE_DISMISS_KEY, MainnetLiveBanner } from './mainnet-live-banner'

const TESTNET: NetworkConfig = { network: 'testnet', devnetName: null, key: 'testnet', dapiAddresses: [], quorumBaseUrl: null, dpnsContractId: 'dpns', v2: null }
const MAINNET: NetworkConfig = { ...TESTNET, network: 'mainnet', key: 'mainnet' }
const SITE: OtherSite = { key: 'mainnet', url: 'https://forge.example', host: 'forge.example' }

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

function render(config: NetworkConfig, site: OtherSite | null): void {
  act(() => root.render(<MainnetLiveBanner config={config} site={site} />))
}
const banner = (): HTMLElement | null => el.querySelector('[data-testid="mainnet-live-banner"]')

describe('MainnetLiveBanner', () => {
  it('shows nothing without a mainnet site, or on mainnet', () => {
    render(TESTNET, null)
    expect(banner()).toBeNull()
    render(MAINNET, { key: 'testnet', url: 'https://t.example', host: 't.example' })
    expect(banner()).toBeNull()
    render(MAINNET, SITE)
    expect(banner()).toBeNull()
  })

  it('is not in the static HTML (it waits for storage)', () => {
    expect(renderToString(<MainnetLiveBanner config={TESTNET} site={SITE} />)).toBe('')
  })

  it('says this is test money and links the mainnet site', () => {
    render(TESTNET, SITE)
    const b = banner()!
    expect(b.getAttribute('role')).toBe('status')
    expect(b.textContent).toContain('You’re on Forge testnet: DASH here is test money. Forge is live on mainnet → forge.example')
    expect(b.querySelector('a')!.getAttribute('href')).toBe('https://forge.example')
  })

  it('dismisses, and remembers that', () => {
    render(TESTNET, SITE)
    const close = el.querySelector('button')!
    expect(close.getAttribute('aria-label')).toBe('Dismiss this notice')
    act(() => close.click())
    expect(banner()).toBeNull()
    expect(window.localStorage.getItem(MAINNET_LIVE_DISMISS_KEY)).toBe('1')
    act(() => root.unmount())
    root = createRoot(el)
    render(TESTNET, SITE)
    expect(banner()).toBeNull()
  })
})
