// @vitest-environment jsdom
/**
 * The funds pill's tooltip (QW4-020): the expiry it names is the browser key's, never the
 * balance's, including when the key's budget is not known yet.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { KeyLimits } from '@/lib/view/funds'

const DASH = 100_000_000_000n
const EXPIRES = Date.UTC(2026, 11, 30, 12)
const auth = { balance: '2288800000', keyLimits: null as KeyLimits | null }

vi.mock('@/contexts/auth-context', async () => {
  const { fundsState } = await import('@/lib/view/funds')
  return { useAuth: () => ({ balance: auth.balance, keyLimits: auth.keyLimits, funds: fundsState(BigInt(auth.balance), auth.keyLimits, Date.UTC(2026, 9, 2)) }) }
})
vi.mock('@/hooks/use-ui-store', () => ({ useUiStore: () => () => undefined }))

const { FundsPill } = await import('./funds-pill')
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function tooltip(): string {
  act(() => root.render(<FundsPill />))
  return host.querySelector('[data-testid="funds-pill"]')!.getAttribute('title') ?? ''
}

describe('FundsPill tooltip (QW4-020)', () => {
  it('names the key budget, capped by a lower balance, then its expiry', () => {
    auth.keyLimits = { remaining: DASH / 20n, total: DASH / 20n, expiresAt: EXPIRES }
    expect(tooltip()).toMatch(/^Balance 0\.022888 DASH · This browser's key: 0\.05 of 0\.05 DASH left \(capped by your 0\.022888 DASH balance\) · expires /)
  })

  it("without a known budget, says the expiry is the key's", () => {
    auth.keyLimits = { remaining: null, total: DASH / 20n, expiresAt: EXPIRES }
    const t = tooltip()
    expect(t).toMatch(/^Balance 0\.022888 DASH · This browser's key expires /)
    expect(t).not.toMatch(/DASH · expires/)
  })
})
