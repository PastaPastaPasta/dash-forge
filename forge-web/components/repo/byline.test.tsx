// @vitest-environment jsdom
/**
 * FG-6 (L-04): an imported item from a trusted mirror shows its original author (as text, never a
 * Forge profile link: L-38) and its original date. The original author is the mirror's claim,
 * so it is marked "unverified" until the repo's claim to mirror its source is verified, and the
 * signer stays visible as "imported by" (ABU-05). Anything else shows its signer and the chain time.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Byline, Time } from './byline'
import { MirrorTrustProvider } from './mirror-trust'
import { clearMirrorChecks, checkMirrorClaim } from '@/lib/view/mirror-check'
import type { RepoHome } from '@/lib/view'

vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span data-testid="author">{identityId}</span> }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

const MIRRORED_AT = Date.parse('2026-09-28T10:00:00Z')

describe('Byline', () => {
  it('shows the original author and date of a trusted import', () => {
    const origin = { author: 'aigon89', createdAt: Date.parse('2018-06-22T09:00:00Z'), url: 'https://github.com/dashpay/dash/issues/2143', host: 'github.com' }
    act(() => root.render(<Byline author="M1rror" createdAt={MIRRORED_AT} origin={origin} verb="opened" />))
    expect(host.querySelector('[data-testid="origin-author"]')!.textContent).toBe('@aigon89 on github.com')
    expect(host.querySelector('a')).toBeNull()
    const time = host.querySelector('time')!
    expect(time.getAttribute('dateTime')).toBe('2018-06-22T09:00:00.000Z')
    expect(time.getAttribute('title')).toBe('2018-06-22 09:00 UTC')
    // The signer stays visible, as who imported it.
    expect(host.querySelector('[data-testid="imported-by"]')!.textContent).toBe('imported by M1rror')
    expect(host.querySelector('[data-testid="imported-by"] [data-testid="author"]')).not.toBeNull()
  })

  it('marks the original author unverified when no mirror claim was verified (no provider)', () => {
    const origin = { author: 'bob', createdAt: MIRRORED_AT, url: 'https://github.com/dashpay/dash/issues/1', host: 'github.com' }
    act(() => root.render(<Byline author="M1rror" createdAt={MIRRORED_AT} origin={origin} verb="opened" />))
    expect(host.querySelector('[data-testid="origin-unverified"]')!.textContent).toBe('unverified')
  })

  it('says only the date for a time known to the day', () => {
    act(() => root.render(<Time ms={Date.parse('2026-08-03T00:00:00Z')} dateOnly />))
    const time = host.querySelector('time')!
    expect(time.getAttribute('dateTime')).toBe('2026-08-03')
    expect(time.getAttribute('title')).toBe('2026-08-03')
  })

  it('shows the signer and the chain time otherwise', () => {
    act(() => root.render(<Byline author="Alice" createdAt={MIRRORED_AT} origin={null} verb="opened" />))
    expect(host.querySelector('[data-testid="author"]')!.textContent).toBe('Alice')
    expect(host.querySelector('time')!.getAttribute('dateTime')).toBe('2026-09-28T10:00:00.000Z')
    expect(host.textContent).not.toContain('imported by')
    expect(host.querySelector('[data-testid="origin-unverified"]')).toBeNull()
  })
})

describe('Byline inside a mirror whose claim the source confirmed (ABU-05)', () => {
  const REPO_ID = 'BCrANpjYupbP3hJEfF9tNvz546Dhif8sFZWwwpeBpTyq'
  const home = { repo: { repoId: REPO_ID }, v2: { description: 'Mirror of github.com/dashpay/dash', forkOf: null } } as unknown as RepoHome
  const origin = { author: 'bob', createdAt: MIRRORED_AT, url: 'https://github.com/dashpay/dash/issues/1', host: 'github.com' }
  const source = { host: 'github.com', label: 'github.com/dashpay/dash', listUrl: '' }
  const listing = (ids: string[]): typeof fetch => (async (input: RequestInfo | URL) => (String(input).includes('raw.githubusercontent.com') ? new Response(JSON.stringify({ mirrors: ids })) : new Response('', { status: 404 }))) as typeof fetch

  it('is unverified until the source lists the repo, then loses the mark without a reload', async () => {
    act(() => root.render(<MirrorTrustProvider home={home}><Byline author="M1rror" createdAt={MIRRORED_AT} origin={origin} /></MirrorTrustProvider>))
    expect(host.querySelector('[data-testid="origin-unverified"]')).not.toBeNull()

    // A list that names other mirrors verifies nothing.
    await act(async () => void (await checkMirrorClaim(source, REPO_ID, null, listing(['other']))))
    expect(host.querySelector('[data-testid="origin-unverified"]')).not.toBeNull()
    clearMirrorChecks()

    await act(async () => void (await checkMirrorClaim(source, REPO_ID, null, listing([REPO_ID]))))
    expect(host.querySelector('[data-testid="origin-unverified"]')).toBeNull()
    expect(host.querySelector('[data-testid="origin-author"]')!.textContent).toBe('@bob on github.com')
  })

  it('verifies only the repo the source listed', async () => {
    const other = { repo: { repoId: 'DifferentRepoId1111111111111111111111111111' }, v2: { description: 'Mirror of github.com/dashpay/dash', forkOf: null } } as unknown as RepoHome
    await act(async () => void (await checkMirrorClaim(source, REPO_ID, null, listing([REPO_ID]))))
    act(() => root.render(<MirrorTrustProvider home={other}><Byline author="M1rror" createdAt={MIRRORED_AT} origin={origin} /></MirrorTrustProvider>))
    expect(host.querySelector('[data-testid="origin-unverified"]')).not.toBeNull()
  })

  it('never verifies a repo whose description names no source', async () => {
    const plain = { repo: { repoId: REPO_ID }, v2: { description: 'A plain repo', forkOf: null } } as unknown as RepoHome
    await act(async () => void (await checkMirrorClaim(source, REPO_ID, null, listing([REPO_ID]))))
    act(() => root.render(<MirrorTrustProvider home={plain}><Byline author="M1rror" createdAt={MIRRORED_AT} origin={origin} /></MirrorTrustProvider>))
    expect(host.querySelector('[data-testid="origin-unverified"]')).not.toBeNull()
  })
})
