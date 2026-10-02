// @vitest-environment jsdom
/**
 * The sealed-release editor lives outside the release cards (`useReleaseEditor`): the revision an
 * edit writes gets a new `$id` (its card remounts) or, unpublished, leaves the list (its card goes).
 * The dialog, and the writer's §16.3 warnings in it, must survive that refresh until closed.
 */

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ReleaseList, ReleaseView } from '@/lib/repo'
import type { RepoHome } from '@/lib/view'

const { publish } = vi.hoisted(() => ({ publish: vi.fn() }))
vi.mock('@/lib/repo/new-release', async (orig) => ({ ...(await orig<typeof import('@/lib/repo/new-release')>()), publishRelease: publish }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signer: { identityId: 'M', network: 'devnet' } }) }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, network: 'devnet', ready: true }) }))
vi.mock('@/hooks/use-storage-config', () => ({ useStorageConfig: () => ({ config: null, needsUnlock: false }) }))
vi.mock('@/hooks/use-repo-chrome', () => ({ useViewerRole: () => ({ role: 'maintainer', known: true }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/hooks/use-query-param', async (orig) => ({ ...(await orig<typeof import('@/hooks/use-query-param')>()), useRepoAddress: () => ({ owner: 'o', repo: 'r' }) }))
vi.mock('@/components/repo/private-compose', () => ({ privateComposeBlock: () => null }))
vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span>{identityId}</span> }))
vi.mock('@/components/repo/byline', () => ({ Time: () => <span>now</span> }))
vi.mock('next/link', () => ({ default: (props: React.ComponentProps<'a'>) => <a {...props} /> }))

import { EditReleaseButton, useReleaseEditor } from './new-release'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const home = {
  repo: { forge: { core: 'C', collab: 'L', community: 'M', group: 'G' }, repoId: 'R', ownerId: 'O', name: 'r', visibility: 'private' },
  config: null,
  defaultBranch: 'main',
  branches: [],
  tags: [],
} as unknown as RepoHome
const revision = (id: string): ReleaseView => ({
  id, tagName: 'v1', name: 'One', notes: '', notesBody: '', omitted: null, published: null, yanked: false, delta: 0, assets: [], badAssets: 0, publisher: 'M', createdAt: 1,
  sealed: { epoch: 0, fields: { tag: 'v1', name: 'One' } },
})
const BEFORE: ReleaseList = { current: [revision('OLD')], previous: [] }
const WARNING = 'Your revision of release v1 is older than another one'

/** A releases list keyed by revision, as the page renders it, and the editor outside it. */
function Page({ after }: { after: ReleaseList }): JSX.Element {
  const [list, setList] = useState(BEFORE)
  const editor = useReleaseEditor(home, list, () => setList(after))
  return (
    <>
      <ul>
        {list.current.map((r) => (
          <li key={r.id}>
            <EditReleaseButton home={home} tag={r.tagName} onEdit={editor.edit} />
          </li>
        ))}
      </ul>
      {editor.dialog}
    </>
  )
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  publish.mockReset()
  publish.mockResolvedValue({ release: { documentId: 'NEW' }, assets: [], warnings: [{ message: WARNING, newer: revision('THEIRS') }], orphaned: [] })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const button = (text: RegExp): HTMLButtonElement => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => text.test(b.textContent ?? '') || text.test(b.getAttribute('aria-label') ?? ''))!

async function editAndPublish(): Promise<void> {
  act(() => button(/Edit release v1/).click())
  expect(document.body.textContent).toContain('Edit release v1')
  await act(async () => button(/Sign & publish/).click())
}

describe('the sealed release editor', () => {
  it('keeps the dialog and its warnings when the edited card remounts under the new revision', async () => {
    act(() => root.render(<Page after={{ current: [revision('NEW')], previous: [revision('OLD')] }} />))
    await editAndPublish()
    expect(publish).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-testid="release-written-warning"]')?.textContent).toContain(WARNING)
    expect(document.body.textContent).toContain('Release published.')
  })

  it('keeps them when an unpublish takes the card off the list', async () => {
    act(() => root.render(<Page after={{ current: [], previous: [revision('NEW'), revision('OLD')] }} />))
    await editAndPublish()
    expect(document.querySelector('[data-testid="edit-release"]')).toBeNull()
    expect(document.querySelector('[data-testid="release-written-warning"]')?.textContent).toContain(WARNING)
  })

  it('goes away only when closed', async () => {
    act(() => root.render(<Page after={{ current: [revision('NEW')], previous: [] }} />))
    await editAndPublish()
    act(() => button(/^Close$/).click())
    expect(document.querySelector('[data-testid="release-written-warning"]')).toBeNull()
  })
  it('shows the result, not the form again in "new revision" mode (QW-076)', async () => {
    act(() => root.render(<Page after={{ current: [revision('NEW')], previous: [revision('OLD')] }} />))
    await editAndPublish()
    // The form is gone: no tag field, no carry-over note, no second Sign & publish.
    expect(document.querySelector('#release-tag')).toBeNull()
    expect(document.querySelector('[data-testid="release-sealed-carry"]')).toBeNull()
    expect(button(/Sign & publish/)).toBeUndefined()
    const view = document.querySelector<HTMLAnchorElement>('[data-testid="release-done-view"]')
    expect(view?.textContent).toBe('View release v1')
    expect(view?.getAttribute('href')).toContain('tag=v1')
  })
})
