// @vitest-environment jsdom
/**
 * The clone box with an optional forge-gateway configured (`NEXT_PUBLIC_GATEWAY_URL`): the Dash
 * remote is the first, recommended tab, the HTTPS tab is labelled with its operator, and "verify" checks the gateway
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
import { repoCommands } from '@/lib/view/repo-commands'

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
const cmd = repoCommands('alice', 'proj')
const tabs = (): string[] => [...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent ?? '')
const panel = (tab: string): HTMLElement => {
  const t = host.querySelector<HTMLElement>(`[data-testid="clone-tab-${tab}"]`)
  return document.getElementById(t?.getAttribute('aria-controls') ?? '') as HTMLElement
}
const click = async (el: Element | null): Promise<void> => {
  await act(async () => {
    ;(el as HTMLElement | null)?.click()
  })
}

/** A v0 ref advertisement naming `main` at `oid`. */
function advert(oid: string): string {
  const line = `${oid} refs/heads/main\0side-band-64k\n`
  const pkt = (s: string) => (new TextEncoder().encode(s).length + 4).toString(16).padStart(4, '0') + s
  return `${pkt('# service=git-upload-pack\n')}0000${pkt(line)}0000`
}

describe('CloneBox with a gateway', () => {
  it('opens on the recommended Dash remote and labels the HTTPS tab with its operator', async () => {
    await render()
    expect(tabs()).toEqual(['Dash remote,Recommended', 'HTTPS', 'dg CLI'])
    expect(host.querySelector('[aria-selected="true"]')?.textContent).toContain('Dash remote')
    expect(codes()[0]).toBe(cmd.gitClone)
    expect(codes()).toContain('dash://alice/proj')
    expect(panel('dash').hidden).toBe(false)
    expect(panel('https').hidden).toBe(true)
    expect(panel('https').textContent).toContain('git clone https://gw.invalid/alice/proj.git')
    expect(panel('https').textContent).toContain('HTTPS via dashhq gateway')
  })

  it('switches tabs by click and arrow keys, one panel shown at a time', async () => {
    await render()
    await click(host.querySelector('[data-testid="clone-tab-dg"]'))
    expect(panel('dg').hidden).toBe(false)
    expect(panel('dash').hidden).toBe(true)
    expect(panel('dg').querySelector('code')?.textContent).toBe(cmd.dgClone)
    await act(async () => {
      host.querySelector('[role="tablist"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(panel('dash').hidden).toBe(false)
    expect(document.activeElement).toBe(host.querySelector('[data-testid="clone-tab-dash"]'))
    expect(host.querySelector('[data-testid="clone-tab-dash"]')?.getAttribute('tabindex')).toBe('0')
    expect(host.querySelector('[data-testid="clone-tab-dg"]')?.getAttribute('tabindex')).toBe('-1')
  })

  it('copies a command whole and says so', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await render()
    const button = panel('dash').querySelector('button:not([data-testid])') as HTMLButtonElement
    expect(button.textContent).toBe('Copy git clone command')
    await click(button)
    expect(writeText).toHaveBeenCalledWith(cmd.gitClone)
    expect(button.textContent).toBe('Copied!')
    expect(host.textContent).toContain('Copied to clipboard')
  })

  it('keeps every command on one line that scrolls instead of breaking mid-id', async () => {
    await render()
    for (const c of host.querySelectorAll('code')) {
      expect(c.className).toContain('whitespace-nowrap')
      expect(c.className).toContain('overflow-x-auto')
      expect(c.className).not.toContain('break-all')
    }
  })

  it('gateway down: dash:// and the commands are unaffected; verify says it could not check', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await render()
    expect(codes()[0]).toBe(cmd.gitClone)
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="gateway-verify"]')?.click()
    })
    const verdict = host.querySelector('[data-testid="gateway-verdict"]')?.textContent ?? ''
    expect(verdict).toContain('could not be checked')
    expect(verdict).toContain('The Dash remote does not need it')
    expect(codes()[0]).toBe(cmd.gitClone)
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
  it('shows no HTTPS tab', async () => {
    g.gateway = null
    await render()
    expect(tabs()).toEqual(['Dash remote,Recommended', 'dg CLI'])
    expect(host.querySelector('[data-testid="gateway-clone"]')).toBeNull()
    expect(codes().some((c) => c.includes('https://'))).toBe(false)
    expect(host.textContent).not.toContain('gateway')
  })
})
