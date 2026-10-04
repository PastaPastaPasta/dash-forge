// @vitest-environment jsdom
/** The look-alike note (TS-24): warns on a name like a known one, then remembers the page. */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/link', () => ({ default: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }))

import { readKnown, rememberName } from '@/lib/view/known-names'
import { LookalikeNote, useRememberAcquaintance, type Named } from './lookalike-note'

const REAL = 'H3xi5biFj6wbxmpbdhHx1D2D3ofKJJ7anDG58ixhqvry'
const FAKE = 'H3xi5bi9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const note = (): HTMLElement | null => host.querySelector('[data-testid="lookalike-note"]')

describe('LookalikeNote', () => {
  it('says nothing about a first visit, and remembers it', () => {
    act(() => root.render(<LookalikeNote subjects={[{ kind: 'owner', name: 'dashpay', identity: REAL }]} />))
    expect(note()).toBeNull()
    expect(readKnown().map((k) => [k.name, k.how])).toEqual([['dashpay', 'visited']])
  })

  it('warns when a name looks like one the viewer starred, and links to it', () => {
    rememberName({ kind: 'owner', name: 'dashpay', identity: REAL, how: 'starred', at: 1 })
    act(() => root.render(<LookalikeNote subjects={[{ kind: 'owner', name: 'dashpay2', identity: FAKE }]} />))
    expect(note()?.textContent).toBe('Not to be confused with dashpay, which you starred. Compare the identity id before you trust it.')
    expect(note()?.querySelector('a')?.getAttribute('href')).toContain(REAL)
  })

  it('names a look-alike repo by its owner and name', () => {
    rememberName({ kind: 'repo', name: 'dashcore', identity: REAL, repoId: 'r1', label: 'dashpay/dashcore', how: 'visited', at: 1 })
    act(() => root.render(<LookalikeNote subjects={[null, { kind: 'repo', name: 'dash-core', identity: FAKE, repoId: 'r2', label: 'x/dash-core' }]} />))
    expect(note()?.textContent).toContain("Not to be confused with dashpay/dashcore, which you've visited.")
  })

  it('records a star or a follow only once it is on', () => {
    const subject: Named = { kind: 'owner', name: 'alice', identity: REAL }
    function Probe({ on }: { on: boolean }): null {
      useRememberAcquaintance(subject, 'followed', on)
      return null
    }
    act(() => root.render(<Probe on={false} />))
    expect(readKnown()).toEqual([])
    act(() => root.render(<Probe on />))
    expect(readKnown()[0]?.how).toBe('followed')
  })
})
