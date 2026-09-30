// @vitest-environment jsdom
/**
 * A sealed release's asset list in a DOM (`private-repos.md` §16.5): a sealed asset downloads
 * through the verified sealed path and is saved only on success; an external link is marked
 * external and not verified, and its address shows only after a warning; a list that does not
 * open says so.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AsyncState } from '@/hooks/use-async'
import type { ReleaseManifest } from '@/lib/private'
import type { RepoRef } from '@/lib/repo'
import type { OpenedReleaseManifest } from '@/lib/view/release-download'
import { LATE_ASSET_LIST, SealedAssets } from './sealed-release-assets'

const { download, save, viewer } = vi.hoisted(() => ({ download: vi.fn<() => Promise<Uint8Array>>(), save: vi.fn(), viewer: { role: 'writer' as string | null } }))
vi.mock('@/lib/view/release-download', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/view/release-download')>()),
  downloadSealedAsset: download,
  saveBytes: save,
}))
vi.mock('@/hooks/use-repo-chrome', () => ({ useViewerRole: () => ({ role: viewer.role, known: true }) }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const H = 'ab'.repeat(32)
const REPO = {
  forge: { core: 'C', collab: 'L', community: 'M', group: 'G' },
  repoId: 'R',
  ownerId: 'O',
  name: 'r',
  visibility: 'private',
  session: { ctx: { keys: new Map() } },
} as unknown as RepoRef
const MANIFEST: ReleaseManifest = {
  v: 1,
  tag: 'v1',
  total: 2,
  assets: [
    { name: 'app.tar.gz', sha256: H, sizeBytes: 10, uris: ['https://pub.example/packs/x.pack'], sealedSha256: H, sealedSizeBytes: 100 },
    { name: 'LICENSE', sha256: '', sizeBytes: 0, uris: ['https://github.com/o/r/releases/download/v1/LICENSE'] },
  ],
}
const opened = (manifest: ReleaseManifest, uploadedLate = false): OpenedReleaseManifest => ({ manifest, uploadedLate })
const state = (over: Partial<AsyncState<OpenedReleaseManifest>>): AsyncState<OpenedReleaseManifest> => ({
  data: null,
  loading: false,
  error: null,
  cause: null,
  settled: true,
  reload: () => undefined,
  ...over,
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  download.mockReset()
  save.mockReset()
  viewer.role = 'writer'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const rows = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[data-testid="release-asset"]')]

describe('a sealed release asset list', () => {
  it('lists a sealed asset with a Download and an external link as external, not verified', () => {
    act(() => root.render(<SealedAssets repo={REPO} state={state({ data: opened(MANIFEST) })} />))
    const [sealed, external] = rows()
    expect(sealed?.dataset['state']).toBe('idle')
    expect(sealed?.querySelector('button[aria-label="Download app.tar.gz"]')).not.toBeNull()
    expect(external?.dataset['state']).toBe('external')
    expect(external?.textContent).toContain('external · not verified')
    // No address is offered before the warning.
    expect(external?.querySelector('a')).toBeNull()
  })

  it('shows the source link only after warning that opening it contacts the source host', () => {
    act(() => root.render(<SealedAssets repo={REPO} state={state({ data: opened(MANIFEST) })} />))
    const external = rows()[1]!
    act(() => external.querySelector<HTMLButtonElement>('button')!.click())
    expect(external.textContent).toContain('contacts its source')
    expect(external.querySelector('a')?.getAttribute('href')).toBe('https://github.com/o/r/releases/download/v1/LICENSE')
  })

  it('saves a sealed asset only once its verified download resolves', async () => {
    download.mockResolvedValue(new Uint8Array([1, 2, 3]))
    act(() => root.render(<SealedAssets repo={REPO} state={state({ data: opened(MANIFEST) })} />))
    await act(async () => rows()[0]!.querySelector<HTMLButtonElement>('button')!.click())
    expect(save).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), 'app.tar.gz')
    expect(rows()[0]?.dataset['state']).toBe('saved')
  })

  it('saves nothing when the download is refused', async () => {
    const { SealedAssetCorruptError } = await import('@/lib/view/release-download')
    download.mockRejectedValue(new SealedAssetCorruptError('app.tar.gz'))
    act(() => root.render(<SealedAssets repo={REPO} state={state({ data: opened(MANIFEST) })} />))
    await act(async () => rows()[0]!.querySelector<HTMLButtonElement>('button')!.click())
    expect(save).not.toHaveBeenCalled()
    expect(rows()[0]?.dataset['state']).toBe('mismatch')
  })

  it('warns a maintainer, and only a maintainer, of a list uploaded under an old key (§16.5)', () => {
    const late = (): Element | null => host.querySelector('[data-testid="release-assets-late"]')
    viewer.role = 'writer'
    act(() => root.render(<SealedAssets repo={REPO} state={state({ data: opened(MANIFEST, true) })} />))
    expect(late()).toBeNull()
    viewer.role = 'maintainer'
    act(() => root.render(<SealedAssets repo={REPO} state={state({ data: opened(MANIFEST, true) })} />))
    expect(late()?.textContent).toBe(LATE_ASSET_LIST)
    // Still listed: the revision's enc commits to it.
    expect(rows()).toHaveLength(2)
    act(() => root.render(<SealedAssets repo={REPO} state={state({ data: opened(MANIFEST) })} />))
    expect(late()).toBeNull()
    // A list of only continued notes has no rows, but the warning stays.
    act(() => root.render(<SealedAssets repo={REPO} state={state({ data: opened({ ...MANIFEST, total: 0, assets: [], notes: 'n' }, true) })} />))
    expect(late()?.textContent).toBe(LATE_ASSET_LIST)
    expect(rows()).toHaveLength(0)
  })

  it('says the asset list is unavailable when it does not open', () => {
    act(() => root.render(<SealedAssets repo={REPO} state={state({ error: 'the asset list of release v1 is unavailable' })} />))
    expect(host.querySelector('[data-testid="release-assets-unavailable"]')?.textContent).toContain('Asset list unavailable')
  })
})
