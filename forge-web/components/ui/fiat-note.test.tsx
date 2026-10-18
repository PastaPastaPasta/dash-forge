// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FiatNote } from './fiat-note'
import { CostPreview } from './cost-preview'
import { PricesPanel } from '../prices-panel'
import { __setFiatFetchForTests, FIAT_RATES_KEY, FIAT_SETTINGS_KEY } from '@/lib/fiat/store'
import { ACTIVE_NETWORK } from '@/lib/constants'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
const fixture = { v: 1, source: 'ctx', fetchedAt: 1_800_000_000_000, rates: { USD: 40, EUR: 36 } }
const fetcher = vi.fn<typeof fetch>()
const render = async (element: JSX.Element) => { await act(async () => { root.render(element) }) }
const cost = (credits: number, minCredits?: number) => ({ credits, dash: credits / 1e11, minCredits, admit: { balance: Math.max(0, credits), budget: Math.max(0, credits) } })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(fixture.fetchedAt)
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  fetcher.mockReset().mockRejectedValue(new Error('test fixture offline'))
  __setFiatFetchForTests(fetcher)
  localStorage.setItem(FIAT_RATES_KEY, JSON.stringify(fixture))
  localStorage.setItem(FIAT_SETTINGS_KEY, JSON.stringify({ v: 1, enabled: true, currency: 'USD' }))
  window.dispatchEvent(new StorageEvent('storage', { key: FIAT_SETTINGS_KEY }))
  window.dispatchEvent(new StorageEvent('storage', { key: FIAT_RATES_KEY }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('FiatNote and CostPreview', () => {
  it('shows a muted mainnet equivalent for costs, but never for test balances', async () => {
    await render(<><FiatNote dash={0.00048} network="devnet" /><FiatNote dash={1} network="testnet" balance /><FiatNote dash={1} network="mainnet" balance /></>)
    expect(host.textContent).toBe(' (≈ $0.02 on mainnet) (≈ $40.00)')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('server and hydration start with DASH alone even with a cached rate', async () => {
    const element = <span>0.00048 DASH<FiatNote dash={0.00048} network="mainnet" /></span>
    const html = renderToString(element)
    expect(html).not.toContain('$')
    act(() => root.unmount())
    host.innerHTML = html
    const errors: unknown[] = []
    await act(async () => { root = hydrateRoot(host, element, { onRecoverableError: (error) => errors.push(error) }) })
    expect(host.textContent).toBe('0.00048 DASH (≈ $0.02)')
    expect(errors).toEqual([])
  })
  it('renders no note for unavailable, disabled, unsupported or non-finite values', async () => {
    await render(<FiatNote dash={NaN} />)
    expect(host.textContent).toBe('')
    localStorage.removeItem(FIAT_RATES_KEY)
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: FIAT_RATES_KEY })))
    await render(<FiatNote dash={1} />)
    expect(host.textContent).toBe('')
  })
  it('CostPreview prices its range and absolute refund without changing the DASH figure', async () => {
    await render(<CostPreview cost={cost(75_000_000, 25_000_000)} />)
    expect(host.textContent).toContain('0.00025–0.00075 DASH')
    expect(host.textContent).toContain('≈ $0.01–$0.03')
    expect(host.textContent?.includes('on mainnet')).toBe(ACTIVE_NETWORK.network !== 'mainnet')
    await render(<CostPreview cost={cost(-48_000_000)} />)
    expect(host.textContent).toContain('+0.00048 DASH')
    expect(host.textContent).toContain('≈ $0.02')
    await render(<CostPreview cost={cost(48_000_000)} refund />)
    expect(host.textContent).toContain('Refund about+0.00048 DASH')
  })
  it('settings switch currency without fetching, then turn every note off', async () => {
    await render(<><PricesPanel /><CostPreview cost={cost(48_000_000)} /></>)
    const select = host.querySelector<HTMLSelectElement>('[data-testid="fiat-currency"]')!
    await act(async () => { select.value = 'EUR'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(host.textContent).toContain('1 DASH ≈ €36.00 · from CTX · updated just now')
    expect(host.querySelector('[data-testid="cost-preview"]')?.textContent).toContain('€0.02')
    const toggle = host.querySelector<HTMLInputElement>('[data-testid="fiat-enabled"]')!
    await act(async () => toggle.click())
    expect(host.querySelectorAll('[data-testid="fiat-note"]')).toHaveLength(0)
    expect(fetcher).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem(FIAT_SETTINGS_KEY)!)).toEqual({ v: 1, enabled: false, currency: 'EUR' })
  })
})
