// @vitest-environment jsdom
/**
 * QW4-031: the commit link `dg ci report` prints, for a repo whose packs are only at addresses a
 * browser can't fetch: the page shows the commit and its check runs (Platform data), with the
 * "Code not reachable" notice in place of the diff, not the notice alone.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoHome } from '@/lib/view'
import { StorageUnreachableError } from '@/lib/view/browse-source'
import { CommitContent } from './commit-content'

const OID = '5deae9d109eca7c07057dafd53b3c633d5ef867b'
const readCheckRuns = vi.fn(async (_sdk: unknown, _repo: unknown, oid: string) => ({ runs: [{ name: 'ci', oid }] }))

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/hooks/use-trust-view', () => ({ useTrustView: () => 'view' }))
vi.mock('@/hooks/use-browse-reader', () => ({
  useBrowseReader: () => ({
    kind: 'error',
    message: 'unreachable',
    cause: new StorageUnreachableError([{ packHash: 'p'.repeat(64), hosts: [], reason: '127.0.0.1:9000 is not a public https address' } as never]),
    retry: () => undefined,
  }),
}))
vi.mock('@/components/repo/storage-unreachable', () => ({ StorageUnreachableCard: () => <section data-testid="unreachable-card">Code not reachable from a browser</section> }))
vi.mock('@/lib/repo', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/repo')>()), readMembershipsCached: async () => [] }))
vi.mock('@/lib/repo/checks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/repo/checks')>()),
  readCheckRuns: (sdk: unknown, repo: unknown, oid: string) => readCheckRuns(sdk, repo, oid),
  summarizeChecks: () => null,
}))
vi.mock('@/components/repo/pull-tabs', () => ({
  ChecksTab: ({ runs, headOid }: { runs: readonly unknown[] | null; headOid: string }) => (
    <p data-testid="checks-tab">
      {runs === null ? 'loading' : `${runs.length} run(s) on ${headOid}`}
    </p>
  ),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const home = { repo: { repoId: 'R', name: 'qa4-cli-dx-proj', ownerId: 'O', visibility: 'public', forge: { core: 'C' } }, description: '' } as unknown as RepoHome
const addr = { owner: 'O', name: 'qa4-cli-dx-proj' } as never

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  readCheckRuns.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('a commit whose code a browser cannot reach (QW4-031)', () => {
  it('shows the commit and its check runs, with the notice in place of the diff', async () => {
    await act(async () => root.render(<CommitContent home={home} addr={addr} oid={OID} />))
    await act(async () => undefined)
    expect(host.querySelector('[data-testid="commit-unreadable"]')?.textContent).toContain('Commit')
    expect(host.querySelector('[data-testid="unreachable-card"]')).not.toBeNull()
    expect(readCheckRuns).toHaveBeenCalledWith(expect.anything(), expect.anything(), OID)
    expect(host.querySelector('[data-testid="checks-tab"]')?.textContent).toBe(`1 run(s) on ${OID}`)
  })

  it('reads no check runs for an abbreviated id (they are recorded under the full one)', async () => {
    await act(async () => root.render(<CommitContent home={home} addr={addr} oid={OID.slice(0, 9)} />))
    await act(async () => undefined)
    expect(host.querySelector('[data-testid="unreachable-card"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="checks-tab"]')).toBeNull()
    expect(host.querySelector('[data-testid="commit-checks-need-full-id"]')?.textContent).toContain('full commit id')
    expect(readCheckRuns).not.toHaveBeenCalled()
  })
})
