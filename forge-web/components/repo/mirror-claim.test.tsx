// @vitest-environment jsdom
/**
 * A mirror's claim in the rail (TS-01, CJ-3): "Says it mirrors" until GitHub confirms it, nothing
 * green before the viewer asks, and a maintainer of an unlisted mirror sees how to add the file.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let role: string | null = null
vi.mock('@/hooks/use-repo-chrome', () => ({ useViewerRole: () => ({ role, known: true }) }))

import type { RepoHome } from '@/lib/view'
import { backlinkFile } from '@/lib/rules/mirror-backlink'
import { clearMirrorChecks } from '@/lib/view/mirror-check'
import { MirrorClaim } from './mirror-claim'

const REPO_ID = 'BCrANpjYupbP3hJEfF9tNvz546Dhif8sFZWwwpeBpTyq'
const OID = 'a31fcf2'.padEnd(40, '0')

function home(description: string, forkOf: string | null = null): RepoHome {
  return {
    repo: { repoId: REPO_ID },
    v2: { description, forkOf },
    defaultBranch: 'master',
    branches: [{ refName: 'refs/heads/master', refNameHash: '', state: { state: 'resolved', oid: OID, author: 'x', createdAt: 1_700_000_000_000 } }],
    tags: [],
  } as unknown as RepoHome
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  role = null
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  clearMirrorChecks()
  vi.unstubAllGlobals()
})

const q = (id: string): HTMLElement | null => host.querySelector(`[data-testid="${id}"]`)

function stubGithub(file: string | null, branchOid: string): ReturnType<typeof vi.fn> {
  const f = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('https://raw.githubusercontent.com/')) return file === null ? new Response('', { status: 404 }) : new Response(file)
    return new Response(branchOid)
  })
  vi.stubGlobal('fetch', f)
  return f
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve())
}

describe('MirrorClaim', () => {
  it('shows nothing for a repo that claims no source, or a fork of a mirror', () => {
    act(() => root.render(<MirrorClaim home={home('A plain repo')} />))
    expect(q('mirror-provenance')).toBeNull()
    act(() => root.render(<MirrorClaim home={home('Mirror of github.com/dashpay/dips', 'parent')} />))
    expect(q('mirror-provenance')).toBeNull()
  })

  it('reads "Says it mirrors" and asks nothing until the viewer checks', () => {
    const f = stubGithub(backlinkFile([REPO_ID]), OID)
    act(() => root.render(<MirrorClaim home={home('Mirror of github.com/dashpay/dips')} />))
    expect(q('mirror-provenance')?.textContent).toMatch(/^Says it mirrors github\.com\/dashpay\/dips/)
    expect(q('mirror-check')?.textContent).toBe('Check with GitHub')
    expect(host.querySelector('[data-ok="true"]')).toBeNull()
    expect(f).not.toHaveBeenCalled()
  })

  it('says "Mirror of" once the source lists it and the branch matches', async () => {
    stubGithub(backlinkFile([REPO_ID]), OID)
    act(() => root.render(<MirrorClaim home={home('Mirror of github.com/dashpay/dips')} />))
    act(() => q('mirror-check')?.click())
    await settle()
    expect(q('mirror-provenance')?.textContent).toMatch(/^Mirror of github\.com\/dashpay\/dips/)
    expect(q('mirror-check-backlink')?.dataset['ok']).toBe('true')
    expect(q('mirror-check-head')?.textContent).toBe("master matches GitHub's default branch at a31fcf2.")
  })

  it('keeps the claim unconfirmed when the source lists another repo or moved on', async () => {
    stubGithub(backlinkFile(['someone-else']), 'b'.repeat(40))
    act(() => root.render(<MirrorClaim home={home('Mirror of github.com/dashpay/dips')} />))
    act(() => q('mirror-check')?.click())
    await settle()
    expect(q('mirror-provenance')?.textContent).toMatch(/^Says it mirrors/)
    expect(q('mirror-check-backlink')?.dataset['ok']).toBe('false')
    expect(q('mirror-check-head')?.textContent).toBe("master differs from GitHub's default branch, which is at bbbbbbb.")
  })

  it('drops an answer that arrives after the viewer moved to another repo', async () => {
    const waiting: ((r: Response) => void)[] = []
    const release = (): void => {
      for (const [i, res] of waiting.entries()) res(new Response(i === 0 ? backlinkFile([REPO_ID]) : OID))
    }
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => waiting.push(res))))
    act(() => root.render(<MirrorClaim home={home('Mirror of github.com/dashpay/dips')} />))
    act(() => q('mirror-check')?.click())
    act(() => root.render(<MirrorClaim home={home('Mirror of github.com/dashpay/dash')} />))
    expect(waiting).toHaveLength(2)
    release()
    await settle()
    expect(q('mirror-provenance')?.textContent).toMatch(/^Says it mirrors github\.com\/dashpay\/dash/)
    expect(q('mirror-check-result')).toBeNull()
  })

  it('shows a maintainer of an unlisted mirror how to add the file', () => {
    role = 'maintainer'
    act(() => root.render(<MirrorClaim home={home('Mirror of github.com/dashpay/dips')} />))
    const link = q('mirror-prove')?.querySelector('a')
    const url = new URL(String(link?.getAttribute('href')))
    expect(url.pathname).toBe('/dashpay/dips/new/master')
    expect(url.searchParams.get('value')).toBe(backlinkFile([REPO_ID]))
  })

  it('points a maintainer at the existing list when it names other mirrors', async () => {
    role = 'maintainer'
    stubGithub(backlinkFile(['someone-else']), OID)
    act(() => root.render(<MirrorClaim home={home('Mirror of github.com/dashpay/dips')} />))
    act(() => q('mirror-check')?.click())
    await settle()
    expect(q('mirror-prove')?.querySelector('a')?.getAttribute('href')).toBe('https://github.com/dashpay/dips/blob/HEAD/.dash-forge.json')
    expect(q('mirror-prove')?.textContent).toContain(REPO_ID)
    role = 'writer'
    act(() => root.render(<MirrorClaim home={home('Mirror of github.com/dashpay/dips ')} />))
    expect(q('mirror-prove')).toBeNull()
  })
})
