// @vitest-environment jsdom
/**
 * P1-4: the release form creates a tag that does not exist yet, as GitHub's "Create new tag: … on
 * publish" does. An existing tag is used as it is; a new one is named as new, with the branch to
 * make it on (the default branch first), its write in the cost, and `createTag` in the publish.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoHome } from '@/lib/view'

const { publish } = vi.hoisted(() => ({ publish: vi.fn(async () => ({ release: { documentId: 'd' }, assets: [] })) }))
vi.mock('@/lib/repo/new-release', async (orig) => ({ ...(await orig<typeof import('@/lib/repo/new-release')>()), publishRelease: publish }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signer: { identityId: 'M', network: 'devnet' } }) }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, network: 'devnet', ready: true }) }))
vi.mock('@/hooks/use-storage-config', () => ({ useStorageConfig: () => ({ config: null, needsUnlock: false }) }))
vi.mock('@/hooks/use-repo-chrome', () => ({ useViewerRole: () => ({ role: 'maintainer', known: true }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/hooks/use-query-param', async (orig) => ({ ...(await orig<typeof import('@/hooks/use-query-param')>()), useRepoAddress: () => ({ owner: 'o', name: 'r' }) }))
vi.mock('@/components/repo/private-compose', () => ({ privateComposeBlock: () => null }))
vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span>{identityId}</span> }))
vi.mock('@/components/repo/byline', () => ({ Time: () => <span>now</span> }))
vi.mock('next/link', () => ({ default: (props: React.ComponentProps<'a'>) => <a {...props} /> }))

import { NewReleaseButton } from './new-release'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const MAIN = 'a'.repeat(40)
const DEV = 'b'.repeat(40)
const ref = (refName: string, oid: string) => ({ refName, refNameHash: 'x', state: { state: 'resolved', oid, author: 'id', createdAt: 1 } })
const home = {
  repo: { forge: { core: 'C', collab: 'L', community: 'M' }, repoId: 'R', ownerId: 'O', name: 'r', visibility: 'public' },
  config: null,
  defaultBranch: 'main',
  branches: [ref('refs/heads/dev', DEV), ref('refs/heads/main', MAIN)],
  tags: [ref('refs/tags/v1.0.0', MAIN)],
} as unknown as RepoHome

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  publish.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** Type into a controlled input as a user does. */
function type(input: HTMLInputElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function open(): Promise<HTMLInputElement> {
  act(() => root.render(<NewReleaseButton home={home} releases={{ current: [], previous: [] }} onPublished={() => undefined} />))
  act(() => (document.querySelector('[data-testid="new-release"]') as HTMLButtonElement).click())
  return document.getElementById('release-tag') as HTMLInputElement
}

const publishButton = (): HTMLButtonElement => [...document.querySelectorAll('button')].find((b) => /Sign & publish/.test(b.textContent ?? '')) as HTMLButtonElement

describe('creating a tag from the release form', () => {
  it('uses an existing tag as it is: no new-tag panel, no createTag', async () => {
    const tag = await open()
    act(() => type(tag, 'v1.0.0'))
    expect(document.querySelector('[data-testid="release-new-tag"]')).toBeNull()
    await act(async () => publishButton().click())
    expect(publish).toHaveBeenCalledTimes(1)
    expect((publish.mock.calls[0] as unknown[])[3]).not.toHaveProperty('createTag')
  })

  it('names a new tag, makes it on the default branch unless another is picked', async () => {
    const tag = await open()
    act(() => type(tag, 'v2.0.0'))
    const panel = document.querySelector('[data-testid="release-new-tag"]')
    expect(panel?.textContent).toContain('v2.0.0 is a new tag')
    const target = document.querySelector('[data-testid="release-tag-target"]') as HTMLSelectElement
    expect(target.value).toBe('refs/heads/main')
    expect([...target.options].map((o) => o.textContent)).toEqual(['main', 'dev'])
    expect(panel?.textContent).toContain(`at ${MAIN.slice(0, 7)}`)
    await act(async () => publishButton().click())
    expect((publish.mock.calls[0] as unknown[])[3]).toMatchObject({ tagName: 'v2.0.0', createTag: { target: MAIN } })
  })

  it('makes it on the branch picked', async () => {
    const tag = await open()
    act(() => type(tag, 'v2.1.0'))
    const target = document.querySelector('[data-testid="release-tag-target"]') as HTMLSelectElement
    act(() => {
      target.value = 'refs/heads/dev'
      target.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => publishButton().click())
    expect((publish.mock.calls[0] as unknown[])[3]).toMatchObject({ createTag: { target: DEV } })
  })
})
