// @vitest-environment jsdom
/**
 * ProfileAvatar (P1-7): what each `avatarConfig` draws. An image link is never fetched until the
 * viewer asks (D-053's rule for images anyone can name), and a value no convention reads draws
 * the default.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ProfileAvatar } from './profile-avatar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ID = '8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB'
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  window.localStorage.clear()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const q = (id: string): Element | null => host.querySelector(`[data-testid="${id}"]`)

describe('ProfileAvatar', () => {
  it('draws the initial with no config, or one no convention reads', () => {
    act(() => root.render(<ProfileAvatar identityId={ID} name="alice" />))
    expect(q('avatar-initial')?.textContent).toBe('A')
    act(() => root.render(<ProfileAvatar identityId={ID} name="alice" config="gravatar:abc" />))
    expect(q('avatar-initial')).not.toBeNull()
    expect(q('avatar-image')).toBeNull()
  })

  it('draws an identicon from its seed', () => {
    act(() => root.render(<ProfileAvatar identityId={ID} config="identicon:abc" />))
    expect(q('avatar-identicon')?.querySelectorAll('rect').length).toBeGreaterThan(1)
  })

  it('asks before loading an image link, then loads it with no referrer', () => {
    act(() => root.render(<ProfileAvatar identityId={ID} name="alice" config="https://img.example/me.png" />))
    expect(q('avatar-image')).toBeNull()
    expect(q('avatar-initial')).not.toBeNull()
    const ask = q('avatar-load') as HTMLButtonElement
    expect(ask.textContent).toContain('img.example')
    act(() => ask.click())
    const img = q('avatar-image') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('https://img.example/me.png')
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer')
  })
})
