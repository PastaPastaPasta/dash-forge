// @vitest-environment jsdom
/**
 * Copy link writes the owner as the address bar does: by the DPNS name of the identity the owner
 * names, whether the repo was opened by its id, by `name.dash` or by the name in another case.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const names = vi.hoisted(() => ({ read: (owner: string): string | undefined => (owner === 'alice' ? 'alice.dash' : undefined) }))
vi.mock('@/hooks/use-dpns-name', () => ({ useOwnerDpnsName: (owner: string) => names.read(owner) }))
vi.mock('@/hooks/use-copy', () => ({ useCopy: () => [false, () => undefined] }))

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

function href(owner: string): string | null {
  act(() => root.render(<CopyLinkButton repo={{ owner, name: 'project' }} target={{ kind: 'issues' }} />))
  return el.querySelector('[data-testid="copy-link"]')!.getAttribute('data-href')
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
})
