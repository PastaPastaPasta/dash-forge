// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SecretValue } from './secret-value'

// QW2-001 on the web: a generated secret (the mirror wizard's DASH_FORGE_KEY, a webhook secret)
// is masked until asked for, and Copy copies the real value without revealing it.
const SECRET = 'dfk1:testnet:8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB:6:not-a-real-wif'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('SecretValue', () => {
  it('is masked by default, in the text and in every attribute', () => {
    act(() => root.render(<SecretValue label="the DASH_FORGE_KEY value" value={SECRET} />))
    expect(host.textContent).not.toContain(SECRET)
    expect(host.innerHTML).not.toContain(SECRET)
    expect(host.textContent).toContain('•')
  })

  it('masks with the same 24 dots whatever the length (a short value, an empty one)', () => {
    for (const value of ['abc', '']) {
      act(() => root.render(<SecretValue label="the secret" value={value} />))
      expect(host.querySelector('code')!.textContent).toBe('•'.repeat(24))
    }
  })

  it('shows the value only when asked, and hides it again', () => {
    act(() => root.render(<SecretValue label="the DASH_FORGE_KEY value" value={SECRET} />))
    const toggle = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>('button[aria-pressed]')!
    act(() => toggle().click())
    expect(host.textContent).toContain(SECRET)
    expect(toggle().getAttribute('aria-label')).toBe('Hide the DASH_FORGE_KEY value')
    act(() => toggle().click())
    expect(host.textContent).not.toContain(SECRET)
  })

  it('copies the real value while it stays masked', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    act(() => root.render(<SecretValue label="the DASH_FORGE_KEY value" value={SECRET} />))
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Copy the DASH_FORGE_KEY value"]')!.click()
    })
    expect(writeText).toHaveBeenCalledWith(SECRET)
    expect(host.textContent).not.toContain(SECRET)
  })
})
