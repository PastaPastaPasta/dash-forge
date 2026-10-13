// @vitest-environment jsdom
/**
 * R9 (M-C's live run): a repository made public keeps some history members-only, so its reader
 * skips those packs on purpose. They are not storage failures: the caution ("could not be fetched
 * from storage… no browser-fetchable mirror") lists only packs that failed, and the skipped ones
 * get one plain line.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { UnavailablePack } from '@/lib/view'
import { PackNotices } from './browse-boundary'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const pack = (hash: string, extra: Partial<UnavailablePack> = {}): UnavailablePack => ({
  packHash: hash.repeat(64).slice(0, 64),
  hosts: [],
  reason: 'why',
  corrupt: false,
  ...extra,
})
const membersOnly = (hash: string): UnavailablePack => pack(hash, { skipped: 'noKey', reason: "stored encrypted while the repo was private, and its key wasn't made public" })
const newer = (hash: string): UnavailablePack => pack(hash, { skipped: 'otherFormat', reason: 'encrypted in a format a newer version of Forge writes' })

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

function render(packs: UnavailablePack[]): { caution: string | null; skipped: string | null } {
  act(() => root.render(<PackNotices packs={packs} />))
  return {
    caution: host.querySelector('[role=status]')?.textContent ?? null,
    skipped: host.querySelector('[data-testid=skipped-packs]')?.textContent ?? null,
  }
}

describe("the in-browser clone's notices", () => {
  it('shows no caution for packs skipped on purpose, one plain line instead', () => {
    const got = render([membersOnly('a'), membersOnly('b')])
    expect(got.caution).toBeNull()
    expect(got.skipped).toBe('Not shown: 2 members-only packs from before this repo was public.')
    expect(host.textContent).not.toMatch(/could not be fetched|browser-fetchable/)
  })

  it('names a pack in a newer format in the plain line too', () => {
    expect(render([membersOnly('a'), newer('c')]).skipped).toBe(
      'Not shown: 1 members-only pack from before this repo was public and 1 pack stored in a format a newer version of Forge writes.',
    )
  })

  it('keeps the caution for packs that failed, listing only those', () => {
    const got = render([pack('d', { hosts: ['pub-9a1.r2.dev'] }), membersOnly('a')])
    expect(got.caution).toMatch(/^1 pack could not be fetched from its storage/)
    expect(got.caution).toContain('dddddddddddd… — pub-9a1.r2.dev')
    expect(got.caution).not.toContain('aaaaaaaaaaaa')
    expect(got.skipped).toBe('Not shown: 1 members-only pack from before this repo was public.')
  })

  it('renders nothing when nothing is missing', () => {
    expect(render([])).toEqual({ caution: null, skipped: null })
    expect(host.textContent).toBe('')
  })
})
