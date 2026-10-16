// @vitest-environment jsdom
/**
 * The mirror note over an issue or PR list (ABU-05): the source is the owner's word, so the line
 * says "Says it mirrors" until the source's back-link file lists the repo, as the rail does.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoHome } from '@/lib/view'
import { checkMirrorClaim, clearMirrorChecks } from '@/lib/view/mirror-check'

const REPO_ID = 'BCrANpjYupbP3hJEfF9tNvz546Dhif8sFZWwwpeBpTyq'
const SOURCE = { host: 'github.com', label: 'github.com/dashpay/dash', listUrl: 'https://github.com/dashpay/dash/issues' }

vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'testnet' }) }))
vi.mock('@/lib/repo', async (orig) => ({ ...(await orig<typeof import('@/lib/repo')>()), repoContractIds: () => [] }))
vi.mock('@/lib/view/mirror-source', async (orig) => ({
  ...(await orig<typeof import('@/lib/view/mirror-source')>()),
  readMirrorSourceCached: async () => SOURCE,
}))

const { MirrorNote } = await import('./mirror-note')
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const home = { repo: { repoId: REPO_ID }, description: 'Mirror of github.com/dashpay/dash', v2: { description: 'Mirror of github.com/dashpay/dash', forkOf: null } } as unknown as RepoHome

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
  clearMirrorChecks()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve())
}
const note = (): HTMLElement | null => host.querySelector('[data-testid="mirror-note"]')

describe('MirrorNote', () => {
  it('says "Says it mirrors" until the source lists the repo', async () => {
    act(() => root.render(<MirrorNote home={home} kind="issue" />))
    await settle()
    expect(note()?.textContent).toMatch(/^Says it mirrors github\.com\/dashpay\/dash/)
    expect(note()?.dataset['verified']).toBe('false')
    expect(note()?.textContent).not.toMatch(/^Mirrored from/)
    // It still points at the source's full history.
    expect(note()?.querySelector('a')?.getAttribute('href')).toBe(SOURCE.listUrl)
  })

  it('reads "Mirrored from" once the source lists it, and not before', async () => {
    act(() => root.render(<MirrorNote home={home} kind="issue" />))
    await settle()
    const f = (async (input: RequestInfo | URL) => (String(input).includes('raw.githubusercontent.com') ? new Response(JSON.stringify({ mirrors: [REPO_ID] })) : new Response('', { status: 404 }))) as typeof fetch
    await act(async () => void (await checkMirrorClaim(SOURCE, REPO_ID, null, f)))
    expect(note()?.textContent).toMatch(/^Mirrored from github\.com\/dashpay\/dash/)
    expect(note()?.dataset['verified']).toBe('true')
  })
})
