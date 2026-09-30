// @vitest-environment jsdom
/**
 * QW-078: a sealed tag whose newest revision is an unpublish is off the list; a maintainer
 * restores it by publishing it again, so the page lists each such tag with Restore, also when no
 * live release is left (the empty state used to hide them, and pointed only at the CLI).
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ReleaseList, ReleaseView } from '@/lib/repo'
import type { RepoHome } from '@/lib/view'

const { list } = vi.hoisted(() => ({ list: { current: null as ReleaseList | null } }))
vi.mock('@/components/repo/target-href', () => ({ useRepoLinks: () => null, sourceUrl: () => null }))
vi.mock('@/components/repo/sealed-release-assets', () => ({ SealedAssets: () => null, useSealedManifest: () => ({ data: null, error: null }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signer: { identityId: 'M', network: 'devnet' }, identity: 'M' }) }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, network: 'devnet', ready: true }) }))
vi.mock('@/hooks/use-storage-config', () => ({ useStorageConfig: () => ({ config: null, needsUnlock: false }) }))
vi.mock('@/hooks/use-repo-chrome', () => ({ useViewerRole: () => ({ role: 'maintainer', known: true }), useReleases: () => ({ data: list.current, error: null, reload: () => undefined }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/components/repo/private-compose', () => ({ privateComposeBlock: () => null }))
vi.mock('@/components/ui/copy-link', () => ({ CopyLinkButton: () => null }))
vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span>{identityId}</span> }))
vi.mock('@/components/repo/byline', () => ({ Time: () => <span>now</span> }))
vi.mock('@/components/markdown-view', () => ({ MarkdownView: ({ source }: { source: string }) => <div>{source}</div> }))
vi.mock('next/link', () => ({ default: (props: React.ComponentProps<'a'>) => <a {...props} /> }))

import { ReleasesContent, unpublishedTags } from './releases-content'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const rev = (id: string, tag: string, at: number, unpublished = false): ReleaseView => ({
  id, tagName: tag, name: tag, notes: '', notesBody: '', omitted: null, published: null, yanked: false, delta: 0, assets: [], badAssets: 0, publisher: 'M', createdAt: at,
  sealed: { epoch: 0, fields: { tag, name: tag, ...(unpublished ? { unpublished: true } : {}) } },
} as unknown as ReleaseView)

const home = {
  repo: { forge: { core: 'C', collab: 'L', community: 'M' }, repoId: 'R', ownerId: 'O', name: 'r', visibility: 'private' },
  branches: [],
  tags: [],
  config: null,
} as unknown as RepoHome

describe('unpublishedTags', () => {
  it('lists each tag whose newest revision is an unpublish, once, and never a live one', () => {
    const l: ReleaseList = {
      current: [rev('L2', 'v2', 30)],
      // Newest first: v1's newest is the unpublish; v2's old revision is not a restore candidate.
      previous: [rev('U1', 'v1', 20, true), rev('V2OLD', 'v2', 15), rev('V1OLD', 'v1', 10)],
    }
    expect(unpublishedTags(l).map((r) => r.id)).toEqual(['U1'])
  })
})

describe('the Releases page', () => {
  let root: Root
  let host: HTMLDivElement
  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('shows an unpublished tag with Restore even when no live release is left, and names New release', () => {
    list.current = { current: [], previous: [rev('U1', 'v1', 20, true), rev('V1OLD', 'v1', 10)] }
    act(() => root.render(<ReleasesContent home={home} addr={{ owner: 'O', name: 'r' }} />))
    expect(host.textContent).toContain('No published releases')
    expect(host.textContent).not.toContain('No releases yet')
    expect(host.textContent).toMatch(/New release/)
    const section = host.querySelector('[data-testid="releases-unpublished"]')
    expect(section).not.toBeNull()
    expect(section?.querySelector('[data-testid="restore-release"]')?.getAttribute('aria-label')).toBe('Restore release v1')
    // The revision history is still there to open, without the unpublish already shown (QW2-059).
    expect(host.textContent).toMatch(/Show 1 previous revision\b/)
  })

  // QW2-059: the unpublish read "PREVIOUS · Published by …" and was listed a second time below.
  it('marks the unpublish as one, and lists every revision once', () => {
    list.current = { current: [], previous: [rev('U1', 'v1', 20, true), rev('V1OLD', 'v1', 10)] }
    act(() => root.render(<ReleasesContent home={home} addr={{ owner: 'O', name: 'r' }} />))
    const card = host.querySelector('[data-testid="releases-unpublished"] [data-testid="release"]') as HTMLElement
    expect(card.querySelector('[data-testid="release-unpublished"]')?.textContent).toMatch(/unpublished/i)
    expect(card.textContent).toContain('Unpublished by M')
    expect(card.textContent).not.toMatch(/previous/i)
    act(() => ([...host.querySelectorAll('button')].find((b) => /previous revision/.test(b.textContent ?? '')) as HTMLButtonElement).click())
    expect(host.querySelectorAll('[data-testid="release"]')).toHaveLength(2)
    expect(host.textContent).toContain('Published by M')
  })

  it('says "Unpublished by" for a mirrored release too, not its source publication', () => {
    const imported = { ...rev('U1', 'v1', 20, true), published: { at: 5, host: 'github.com', author: 'x' } } as unknown as ReleaseView
    list.current = { current: [], previous: [imported, rev('V1OLD', 'v1', 10)] }
    act(() => root.render(<ReleasesContent home={home} addr={{ owner: 'O', name: 'r' }} />))
    const card = host.querySelector('[data-testid="releases-unpublished"] [data-testid="release"]') as HTMLElement
    expect(card.textContent).toContain('Unpublished by M')
    expect(card.textContent).not.toContain('github.com')
  })

  it('lists a public unpublish (delta −1) the same way, without a Restore it cannot do', () => {
    const pub = (id: string, at: number, delta: number): ReleaseView => ({ ...rev(id, 'v1', at), sealed: undefined, delta }) as unknown as ReleaseView
    list.current = { current: [], previous: [pub('U1', 20, -1), pub('V1', 10, 1)] }
    const publicHome = { ...home, repo: { ...home.repo, visibility: 'public' } } as unknown as RepoHome
    act(() => root.render(<ReleasesContent home={publicHome} addr={{ owner: 'O', name: 'r' }} />))
    const section = host.querySelector('[data-testid="releases-unpublished"]')
    expect(section?.textContent).toContain('Unpublished by M')
    expect(section?.querySelector('[data-testid="restore-release"]')).toBeNull()
    expect(section?.textContent).toContain('dg release create O/r --tag <tag>')
    expect(host.textContent).toMatch(/Show 1 previous revision\b/)
  })
})
