// @vitest-environment jsdom
/**
 * The clone box with an optional forge-gateway configured (`NEXT_PUBLIC_GATEWAY_URL`): `dash://`
 * stays first, the HTTPS URL is labelled with its operator, and "verify" checks the gateway
 * against the page's proved refs. Survivability drill, "gateway down": with the gateway
 * unreachable the box still shows `dash://` and the commands, and verify only says the gateway
 * could not be checked. Without a gateway there is no HTTPS row at all.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoHome } from '@/lib/view'

const A = 'a'.repeat(40)
const g = vi.hoisted(() => ({ gateway: { url: 'https://gw.invalid', label: 'dashhq gateway' } as { url: string; label: string } | null }))

vi.mock('@/hooks/use-browse-reader', () => ({ useBrowseReader: () => ({ kind: 'loading' }) }))
vi.mock('@/lib/gateway', async (orig) => {
  const real = await orig<typeof import('@/lib/gateway')>()
  return {
    ...real,
    get GATEWAY() {
      return g.gateway
    },
  }
})

import { CloneBox } from './clone-box'
import { ACTIVE_NETWORK } from '@/lib/constants'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const MAIN = { refName: 'refs/heads/main', refNameHash: '', state: { state: 'resolved', oid: A, author: 'O', createdAt: 10 } } as const

const home = (): RepoHome =>
  ({
    repo: { forge: { core: 'C', collab: 'L', community: 'M' }, repoId: 'R', ownerId: 'O', name: 'proj', visibility: 'public' },
    defaultBranch: 'main',
    branches: [MAIN],
    tags: [],
    backend: { kind: 'platform' },
  }) as unknown as RepoHome

const selected = { name: 'main', ref: MAIN, isTag: false } as never

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
  vi.unstubAllGlobals()
  g.gateway = { url: 'https://gw.invalid', label: 'dashhq gateway' }
})

const render = async (): Promise<void> => {
  await act(async () => {
    root.render(<CloneBox home={home()} addr={{ owner: 'alice', name: 'proj' } as never} selected={selected} />)
  })
}

const codes = (): string[] => [...host.querySelectorAll('code')].map((c) => c.textContent ?? '')

/** A v0 ref advertisement naming `main` at `oid`. */
function advert(oid: string): string {
  const line = `${oid} refs/heads/main\0side-band-64k\n`
  const pkt = (s: string) => (new TextEncoder().encode(s).length + 4).toString(16).padStart(4, '0') + s
  return `${pkt('# service=git-upload-pack\n')}0000${pkt(line)}0000`
}

describe('CloneBox with a gateway', () => {
  it('keeps dash:// first and labels the HTTPS URL with its operator', async () => {
    await render()
    const c = codes()
    expect(c[0]).toBe('dash://alice/proj')
    expect(c).toContain('git clone https://gw.invalid/alice/proj.git')
    expect(c.indexOf('git clone https://gw.invalid/alice/proj.git')).toBeGreaterThan(0)
    expect(host.textContent).toContain('HTTPS via dashhq gateway')
    expect(host.textContent).not.toContain('No https clone URL')
  })

  it('gateway down: dash:// and the commands are unaffected; verify says it could not check', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await render()
    expect(codes()[0]).toBe('dash://alice/proj')
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="gateway-verify"]')?.click()
    })
    const verdict = host.querySelector('[data-testid="gateway-verdict"]')?.textContent ?? ''
    expect(verdict).toContain('could not be checked')
    expect(verdict).toContain('dash:// above does not need it')
    expect(codes()[0]).toBe('dash://alice/proj')
  })

  it('verify matches a gateway serving the proved tip', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/forge-manifest.json')
          ? Response.json({ repoId: 'R', network: ACTIVE_NETWORK.key, platformHeight: 9, platformTimeMs: 20, fetchedAtMs: 30 })
          : new Response(advert(A)),
      ),
    )
    await render()
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="gateway-verify"]')?.click()
    })
    const verdict = host.querySelector('[data-testid="gateway-verdict"]')?.textContent ?? ''
    expect(verdict).toContain('Matches Dash Platform: 1 ref checked.')
    expect(verdict).toContain('block 9')
  })

  it('verify flags a gateway serving a tip Platform never set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/forge-manifest.json')
          ? Response.json({ repoId: 'R', network: ACTIVE_NETWORK.key, platformHeight: 9, platformTimeMs: 20, fetchedAtMs: 30 })
          : new Response(advert('f'.repeat(40))),
      ),
    )
    await render()
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="gateway-verify"]')?.click()
    })
    expect(host.querySelector('[data-testid="gateway-verdict"]')?.textContent).toContain('Does not match Dash Platform')
  })
})

describe('CloneBox without a gateway', () => {
  it('shows no HTTPS row', async () => {
    g.gateway = null
    await render()
    expect(host.querySelector('[data-testid="gateway-clone"]')).toBeNull()
    expect(codes().some((c) => c.includes('https://'))).toBe(false)
    expect(host.textContent).toContain('No https clone URL')
  })
})
