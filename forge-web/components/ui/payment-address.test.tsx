// @vitest-environment jsdom
/**
 * A deposit address is printed once, in its copy field (QW4-022: the QR's caption printed it
 * again, which pushed the faucet link and the deposit status below the fold on a phone). The QR
 * still names it to a screen reader.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PaymentAddress } from './payment-address'

const ADDRESS = 'yQ4q8Vg83hFerBDfqda6BxNyGh1VBxwRK4'
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

describe('PaymentAddress (QW4-022)', () => {
  it('shows the address once, beside its Copy button, and keeps it in the QR label', () => {
    act(() => root.render(<PaymentAddress address={ADDRESS} amountDash={0.05} label="Deposit address" />))
    const shown = (host.textContent ?? '').split(ADDRESS).length - 1
    expect(shown).toBe(1)
    expect(host.querySelector('figcaption')).toBeNull()
    expect(host.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe(`Deposit address ${ADDRESS}`)
    expect(host.querySelector('button[aria-label="Copy the deposit address"]')).not.toBeNull()
  })
})
