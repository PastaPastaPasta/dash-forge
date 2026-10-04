// @vitest-environment jsdom
/** The look-alike note (TS-24): warns on a name like a known one, then remembers the page. */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/link', () => ({ default: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ network: 'devnet' }) }))
let viewer: string | null = null
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: viewer }) }))

import { readKnown, rememberNames, type Subject } from '@/lib/view/known-names'
import { LookalikeNote, useRememberAcquaintance } from './lookalike-note'

const REAL = 'H3xi5biFj6wbxmpbdhHx1D2D3ofKJJ7anDG58ixhqvry'
const FAKE = 'H3xi5bi9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  viewer = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const note = (): HTMLElement | null => host.querySelector('[data-testid="lookalike-note"]')
const known = (): string[][] => readKnown('devnet').map((k) => [k.name, k.how])

describe('LookalikeNote', () => {
  it('says nothing about a first visit, and remembers it', () => {
    act(() => root.render(<LookalikeNote subjects={[{ kind: 'owner', name: 'dashpay', identity: REAL }]} />))
    expect(note()).toBeNull()
    expect(known()).toEqual([['dashpay', 'visited']])
  })

  it('warns against a name like one the viewer starred, and links to it', () => {
    rememberNames('devnet', [{ kind: 'owner', name: 'dashpay', identity: REAL, how: 'starred', at: 1 }])
    act(() => root.render(<LookalikeNote subjects={[{ kind: 'owner', name: 'dashpay2', identity: FAKE }]} />))
    expect(note()?.textContent).toBe('Not to be confused with dashpay, which you starred. Compare the identity id before you trust this page.')
    expect(note()?.querySelector('a')?.getAttribute('href')).toContain(REAL)
  })

  it('only notes a look-alike of a name merely visited, without taking sides', () => {
    rememberNames('devnet', [{ kind: 'repo', name: 'dashcore', identity: REAL, repoId: 'r1', label: 'dashpay/dashcore', how: 'visited', at: 1 }])
    act(() => root.render(<LookalikeNote subjects={[null, { kind: 'repo', name: 'dash-core', identity: FAKE, repoId: 'r2', label: 'x/dash-core' }]} />))
    expect(note()?.textContent).toBe("Looks like dashpay/dashcore, another owner's repository you've visited. Compare the identity ids.")
  })

  it("never compares the viewer's own names", () => {
    rememberNames('devnet', [{ kind: 'owner', name: 'dashpay', identity: REAL, how: 'starred', at: 1 }])
    viewer = FAKE
    act(() => root.render(<LookalikeNote subjects={[{ kind: 'owner', name: 'dashpay2', identity: FAKE }]} />))
    expect(note()).toBeNull()
  })

  it('records a star once it reads on, and a visit again once it reads off', () => {
    const subjects: Subject[] = [{ kind: 'owner', name: 'alice', identity: REAL }]
    function Probe({ on }: { on: boolean | null }): null {
      useRememberAcquaintance(subjects, 'starred', on)
      return null
    }
    act(() => root.render(<Probe on={null} />))
    expect(known()).toEqual([])
    act(() => root.render(<Probe on />))
    expect(known()).toEqual([['alice', 'starred']])
    act(() => root.render(<Probe on={false} />))
    expect(known()).toEqual([['alice', 'visited']])
  })
})
