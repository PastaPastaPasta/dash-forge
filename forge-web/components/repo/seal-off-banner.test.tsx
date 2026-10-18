// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { base58Encode } from '@/lib/auth/base58'
import type { RepoHome } from '@/lib/view'
const readSealOff = vi.fn()
vi.mock('@/lib/repo/private-session', () => ({ readSessionSealOff: (...args: unknown[]) => readSealOff(...args) }))
import { SealOffBanner } from './seal-off-banner'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const owner = new Uint8Array(32).fill(0x22)
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  readSealOff.mockResolvedValue({ kind: 'active', epoch: 3, height: 10, marker: null })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function home(): RepoHome {
  const session = { id: 'reader-session' }
  return { repo: { repoId: 'R', ownerId: base58Encode(owner), visibility: 'private' }, private: { access: 'member', session } } as unknown as RepoHome
}

it('shows the confirmed owner boundary to a reader without a local conversion record', async () => {
  const h = home()
  await act(async () => { root.render(<SealOffBanner home={h} />) })
  expect(host.textContent).toContain('What you write from now on stays members-only unless the owner starts the conversion over.')
})

it('tells members when start-over replaced the earlier boundary', async () => {
  const h = home()
  readSealOff.mockResolvedValue({ kind: 'active', epoch: 3, height: 10, marker: { replacesEpoch: 1 } })
  await act(async () => { root.render(<SealOffBanner home={h} />) })
  expect(host.textContent).toContain('Earlier writing may now be published.')
})

it('does not show private conversion information without a member session or after the flip', async () => {
  const h = home()
  await act(async () => { root.render(<SealOffBanner home={{ repo: h.repo } as RepoHome} />) })
  expect(host.textContent).toBe('')
  await act(async () => { root.render(<SealOffBanner home={{ ...h, repo: { ...h.repo, visibility: 'public' } }} />) })
  expect(host.textContent).toBe('')
})
