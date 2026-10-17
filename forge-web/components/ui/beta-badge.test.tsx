// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BETA_FEATURES, BETA_TOOLTIP, type BetaFeature } from '@/lib/beta'
import { DOCS } from '@/lib/docs-links'

import { BetaBadge } from './beta-badge'

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

describe('BetaBadge', () => {
  it('says Beta, explains it in the tooltip and links the known limitations', () => {
    act(() => root.render(<BetaBadge feature="embargo" />))
    const a = host.querySelector<HTMLAnchorElement>('[data-testid="beta-badge"]')!
    expect(a.textContent).toBe('Beta')
    expect(a.title).toBe(BETA_TOOLTIP)
    expect(a.href).toBe(DOCS.knownLimitations)
    expect(a.href).toContain('collaborating.md#known-limitations')
    expect(a.getAttribute('aria-label')).toBe(`Publication dates is in beta. ${BETA_TOOLTIP}`)
    expect(a.rel).toContain('noopener')
  })

  it('renders for every registered feature and for nothing else', () => {
    for (const feature of Object.keys(BETA_FEATURES) as BetaFeature[]) {
      act(() => root.render(<BetaBadge feature={feature} />))
      expect(host.querySelector(`[data-feature="${feature}"]`), feature).not.toBeNull()
    }
    act(() => root.render(<BetaBadge feature={'letters' as BetaFeature} />))
    expect(host.querySelector('[data-testid="beta-badge"]')).toBeNull()
  })
})
