// @vitest-environment jsdom
/**
 * Copy link writes the owner as the address bar does: by the DPNS name of the identity the owner
 * names, whether the repo was opened by its id, by `name.dash` or by the name in another case.
 * With a gateway, a public repo's link is the gateway's share link with a preview card (#454).
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const names = vi.hoisted(() => ({ read: (owner: string): string | undefined => (owner === 'alice' ? 'alice.dash' : undefined) }))
vi.mock('@/hooks/use-dpns-name', () => ({ useOwnerDpnsName: (owner: string) => names.read(owner) }))
vi.mock('@/hooks/use-copy', () => ({ useCopy: () => [false, () => undefined] }))
const gateway = vi.hoisted(() => ({ value: null as { url: string; label: string } | null }))
vi.mock('@/lib/gateway', () => ({
  get GATEWAY() {
    return gateway.value
  },
}))

import { CopyLinkButton } from './copy-link'

const ID = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  el = document.createElement('div')
  root = createRoot(el)
})
afterEach(() => act(() => root.unmount()))

function button(owner: string, visibility: 'public' | 'private' = 'public'): HTMLElement {
  act(() => root.render(<CopyLinkButton repo={{ owner, name: 'project' }} target={{ kind: 'issues' }} visibility={visibility} />))
  return el.querySelector('[data-testid="copy-link"]')!
}

function href(owner: string, visibility: 'public' | 'private' = 'public'): string | null {
  return button(owner, visibility).getAttribute('data-href')
}

describe('CopyLinkButton', () => {
  it('writes the owner by the name its hook read', () => {
    names.read = () => 'alice.dash'
    expect(href(ID)).toContain('/alice/project/issues')
    expect(href('alice.dash')).toContain('/alice/project/issues')
    expect(href('ALICE')).toContain('/alice/project/issues')
  })

  it('writes the owner as the route did while no name is known', () => {
    names.read = () => undefined
    expect(href(ID)).toContain(`/${ID}/project/issues`)
  })

  it('copies the gateway’s share link for a public repo when the build has a gateway', () => {
    names.read = () => 'alice.dash'
    gateway.value = { url: 'https://git-forge.dashhq.org', label: 'dashhq gateway' }
    try {
      const b = button(ID)
      expect(b.getAttribute('data-href')).toBe('https://git-forge.dashhq.org/og/alice/project/issues')
      expect(b.getAttribute('title')).toContain('preview card')
      // A private repo keeps the plain link: its path goes to no third party.
      expect(href(ID, 'private')).toBe(`${window.location.origin}/alice/project/issues`)
      expect(button(ID, 'private').getAttribute('title')).toBeNull()
    } finally {
      gateway.value = null
    }
    // No gateway: the plain link, exactly as before.
    expect(href(ID)).toBe(`${window.location.origin}/alice/project/issues`)
  })
})
