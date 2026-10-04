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
  it('draws the identicon of the identity id with no config, or one no convention reads', () => {
    act(() => root.render(<ProfileAvatar identityId={ID} />))
    const drawn = q('avatar-identicon')?.innerHTML
    expect(drawn).toBeTruthy()
    act(() => root.render(<ProfileAvatar identityId={ID} config="identicon" />))
    expect(q('avatar-identicon')?.innerHTML).toBe(drawn)
    act(() => root.render(<ProfileAvatar identityId={ID} config="gravatar:abc" />))
    expect(q('avatar-identicon')?.innerHTML).toBe(drawn)
    expect(q('avatar-image')).toBeNull()
  })

  it('draws an identicon from its seed', () => {
    act(() => root.render(<ProfileAvatar identityId={ID} config="identicon:abc" />))
    expect(q('avatar-identicon')?.querySelectorAll('rect').length).toBeGreaterThan(1)
  })

  it("never borrows another identity's pattern through a seed that is its id", () => {
    const other = '9CVMSjkxXqpjNnb93AR4mzk6SRp95ZNP6J3xDNTvEmpv'
    act(() => root.render(<ProfileAvatar identityId={other} />))
    const theirs = q('avatar-identicon')?.innerHTML
    act(() => root.render(<ProfileAvatar identityId={ID} />))
    const own = q('avatar-identicon')?.innerHTML
    act(() => root.render(<ProfileAvatar identityId={ID} config={`identicon:${other}`} />))
    expect(q('avatar-identicon')?.innerHTML).toBe(own)
    expect(q('avatar-identicon')?.innerHTML).not.toBe(theirs)
  })

  it('asks before loading an image link, then loads it with no referrer', () => {
    act(() => root.render(<ProfileAvatar identityId={ID} config="https://img.example/me.png" />))
    expect(q('avatar-image')).toBeNull()
    expect(q('avatar-identicon')).not.toBeNull()
    const ask = q('avatar-load') as HTMLButtonElement
    expect(ask.textContent).toContain('img.example')
    act(() => ask.click())
    const img = q('avatar-image') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('https://img.example/me.png')
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer')
  })
})
