// @vitest-environment jsdom
/**
 * Clone on phones: the repo home shows it above the README and the rail leaves it out; on a wide
 * screen the rail keeps it and the home shows none. A private repo the viewer has no role in
 * shows Clone nowhere, as the rail does.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoHome } from '@/lib/view'

const env = vi.hoisted(() => ({ wide: false, role: 'reader' as string | null }))
vi.mock('@/hooks/use-prefs', () => ({ useMinWidth: () => env.wide }))
vi.mock('@/hooks/use-repo-chrome', () => ({ useViewerRole: () => ({ role: env.role }) }))
vi.mock('@/components/repo/clone-box', () => ({ CloneBox: () => <div data-testid="clone-box" /> }))

import { PhoneCloneBox, PhoneCloneProvider } from './phone-clone'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const home = (visibility: 'public' | 'private'): RepoHome => ({ repo: { visibility } }) as unknown as RepoHome
const addr = { owner: 'o', name: 'n' } as never
const selected = {} as never

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  env.wide = false
  env.role = 'reader'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function page(visibility: 'public' | 'private', withHome = true): void {
  act(() =>
    root.render(
      <PhoneCloneProvider>
        {(railClone) => (
          <>
            <main>{withHome ? <PhoneCloneBox home={home(visibility)} addr={addr} selected={selected} /> : null}</main>
            <aside>{railClone ? <div data-testid="rail-clone" /> : null}</aside>
          </>
        )}
      </PhoneCloneProvider>,
    ),
  )
}

const where = (): string[] => [host.querySelector('main [data-testid="clone-box"]') ? 'main' : '', host.querySelector('[data-testid="rail-clone"]') ? 'rail' : ''].filter(Boolean)

describe('PhoneCloneBox', () => {
  it('on a phone, the home shows Clone and the rail leaves it out', () => {
    page('public')
    expect(where()).toEqual(['main'])
  })

  it('on a wide screen, the rail keeps Clone', () => {
    env.wide = true
    page('public')
    expect(where()).toEqual(['rail'])
  })

  it('a page without the home keeps Clone in the rail, and it comes back when the home goes', () => {
    page('public', false)
    expect(where()).toEqual(['rail'])
    page('public')
    expect(where()).toEqual(['main'])
    page('public', false)
    expect(where()).toEqual(['rail'])
  })

  it('a private repo with no role for the viewer: the home shows none either', () => {
    env.role = null
    page('private')
    expect(where()).toEqual(['rail'])
  })

  it('outside a provider it shows nothing (the rail is not told)', () => {
    act(() => root.render(<PhoneCloneBox home={home('public')} addr={addr} selected={selected} />))
    expect(host.querySelector('[data-testid="clone-box"]')).toBeNull()
  })
})
