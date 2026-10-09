// @vitest-environment jsdom
/**
 * QW3-035: an identity without a username is told how to get one, where its identity shows.
 * #452: it opens the "Choose a username" flow (not a bare CLI command).
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/username-dialog', () => ({ UsernameDialog: () => <div data-testid="username-dialog" /> }))

const { UsernameHint } = await import('./username-hint')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('UsernameHint', () => {
  it('offers the username flow and links the guide', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(<UsernameHint show />))
    expect(host.textContent).toContain('No username yet')
    const link = host.querySelector('a')
    expect(link?.getAttribute('href')).toMatch(/identity-and-keys\.md#what-an-identity-is$/)
    expect(host.querySelector('[data-testid="username-dialog"]')).toBeNull()
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="username-choose"]')!.click())
    expect(host.querySelector('[data-testid="username-dialog"]')).not.toBeNull()
    act(() => root.unmount())
  })

  it('keeps the open dialog when the name lands and the hint goes (its done step must be seen)', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(<UsernameHint show />))
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="username-choose"]')!.click())
    act(() => root.render(<UsernameHint show={false} />))
    expect(host.querySelector('[data-testid="username-hint"]')).toBeNull()
    expect(host.querySelector('[data-testid="username-dialog"]')).not.toBeNull()
    act(() => root.unmount())
  })

  it('shows nothing for an identity with a name', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(<UsernameHint show={false} />))
    expect(host.innerHTML).toBe('')
    act(() => root.unmount())
  })
})
