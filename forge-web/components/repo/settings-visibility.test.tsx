// @vitest-environment jsdom
/** Repo visibility distinguishes creation from conversion without overstating public access. */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { converted, readStatus } = vi.hoisted(() => ({ converted: { value: false }, readStatus: vi.fn() }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/lib/repo/converted', async (orig) => ({
  ...(await orig<typeof import('@/lib/repo/converted')>()),
  knownConversion: () => converted.value ? { sealOffEpoch: 2, markerHeight: 40 } : null,
}))
vi.mock('@/lib/repo/make-public-status', () => ({ readMakePublicStatus: readStatus }))

import type { RepoHome } from '@/lib/view'

import { VisibilityRow } from './repo-settings-sections'

const home = (visibility: 'public' | 'private'): RepoHome => ({
  repo: { repoId: 'R', ownerId: 'O', visibility, forge: { core: 'C', collab: 'L', community: 'M' } },
} as unknown as RepoHome)

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  converted.value = false
  readStatus.mockReset()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

describe('VisibilityRow', () => {
  const row = (): HTMLElement => el.querySelector('[data-testid="settings-visibility"]') as HTMLElement
  const expectPublicAudience = (): void => {
    expect(row().textContent).toContain('Public items are readable by everyone.')
    expect(row().textContent).toContain('Members-only items, letters and members-only branches keep their audience.')
    expect(row().textContent).toContain("A public repo can't become private again.")
    expect(row().textContent).not.toContain('Anyone can read its code, issues and pull requests.')
    expect(row().querySelector('input, select, button')).toBeNull()
  }

  it('keeps the permanent creation label for a repo created public and qualifies public access', async () => {
    await act(async () => root.render(<VisibilityRow home={home('public')} />))
    expect(row().dataset['visibility']).toBe('public')
    expect(row().textContent).toMatch(/Public\s*· set when the repo was created, and permanent/)
    expectPublicAudience()
    expect(readStatus).not.toHaveBeenCalled()
  })

  it.each([['codeOnly', 'Code only'], [null, 'Code only'], ['everything', 'Everything']] as const)(
    'names a converted %s repo without claiming it was created public', async (mode, label) => {
      converted.value = true
      readStatus.mockResolvedValue({ converted: true, mode, phase: 'public' })
      await act(async () => root.render(<VisibilityRow home={home('public')} />))
      expect(row().textContent).toContain(`Public — made public from Private (${label})`)
      expect(row().textContent).not.toContain('set when the repo was created')
      expectPublicAudience()
      expect(readStatus).toHaveBeenCalledOnce()
    },
  )

  it('does not guess the conversion mode while its status is loading or unavailable', async () => {
    converted.value = true
    let rejectStatus!: (error: Error) => void
    readStatus.mockReturnValue(new Promise((_resolve, reject) => { rejectStatus = reject }))
    await act(async () => root.render(<VisibilityRow home={home('public')} />))
    expect(row().textContent).toContain('Public — made public from Private')
    expect(row().textContent).not.toMatch(/set when the repo was created|Code only|Everything/)
    await act(async () => rejectStatus(new Error('offline')))
    expect(row().textContent).toContain('Public — made public from Private')
    expect(row().textContent).not.toMatch(/set when the repo was created|Code only|Everything/)
  })

  it('says what a private repo keeps public, its issue and PR counts included', async () => {
    await act(async () => root.render(<VisibilityRow home={home('private')} />))
    const row = el.querySelector('[data-testid="settings-visibility"]') as HTMLElement
    expect(row.textContent).toMatch(/Private\s*· set when the repo was created/)
    expect(row.textContent).toMatch(/how many issues and pull requests it has are public/)
    expect(readStatus).not.toHaveBeenCalled()
  })
})
