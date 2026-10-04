// @vitest-environment jsdom
/**
 * Settings → Notifications → "Email and push" (the optional forge-notify service). The
 * survivability case "notify down": an unreachable service shows one line and nothing else
 * breaks. Signed out, the privacy copy shows before anything is asked. Signed in, every call is
 * a request signed for the service's operator name with this browser's key.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as secp from '@noble/secp256k1'

import { encodeWif } from '@/lib/auth/wif'
import { requestDigest } from '@/lib/notify/client'
import { base64ToBytes } from '@/lib/sdk/query'

const SECRET = new Uint8Array(32).fill(0x22)
const auth = { identity: null as string | null, controller: { serviceKey: () => ({ identityId: 'IDENTITY', keyId: 4, wif: encodeWif(SECRET, 'testnet') }) } }
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => auth }))

const { NotifyService, safeLink } = await import('./notify-panel')

const BASE = 'https://notify.example.org'
const INFO = {
  service: 'forge-notify',
  version: '0.1.0',
  operator: 'notify.example.org',
  channels: { email: true, push: false },
  vapidPublicKey: null,
  privacyUrl: 'https://example.org/privacy',
  contact: null,
  digestHourUtc: 8,
}

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  auth.identity = null
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.unstubAllGlobals()
})

async function render(): Promise<void> {
  await act(async () => {
    root.render(<NotifyService base={BASE} />)
  })
  // Let the info fetch settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe('NotifyService', () => {
  it('notify down: one line, saying the inbox keeps working', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))))
    await render()
    const down = el.querySelector('[data-testid="notify-down"]')
    expect(down?.textContent).toContain('notify.example.org')
    expect(down?.textContent).toContain('inbox above keeps working')
    expect(el.querySelector('[data-testid="notify-panel"]')).toBeNull()
  })

  it('signed out: the privacy copy, and no request', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify(INFO), { status: 200 })))
    vi.stubGlobal('fetch', fetch)
    await render()
    const privacy = el.querySelector('[data-testid="notify-privacy"]')?.textContent ?? ''
    expect(privacy).toContain('notify.example.org')
    expect(privacy).toContain('None of it goes on chain')
    expect(privacy).toContain('never a title')
    expect(el.textContent).toContain('Sign in to set up email or push')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('a service that names another operator is not signed for', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ...INFO, operator: 'notify.forge.dashhq.org' }), { status: 200 }))))
    await render()
    expect(el.querySelector('[data-testid="notify-mismatch"]')?.textContent).toContain('notify.forge.dashhq.org')
    expect(el.querySelector('[data-testid="notify-privacy"]')).toBeNull()
  })

  it('links only an http(s) privacy notice', () => {
    expect(safeLink('javascript:alert(1)')).toBeNull()
    expect(safeLink('data:text/html,x')).toBeNull()
    expect(safeLink('not a url')).toBeNull()
    expect(safeLink('https://example.org/privacy')).toBe('https://example.org/privacy')
  })

  it('signed in: account.get is signed for the operator with this browser key', async () => {
    auth.identity = 'IDENTITY'
    const account = { identity: 'IDENTITY', subscribed: false, prefs: { participating: true, reviewRequested: true, assigned: true, mentioned: true, watching: true, ownRepos: true, releases: true, privateActivity: false, delivery: 'instant', email: true, push: true, mutedRepos: [] } }
    const fetch = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url.endsWith('/v1/info') ? INFO : account), { status: 200 })))
    vi.stubGlobal('fetch', fetch)
    await render()
    const load = el.querySelector<HTMLButtonElement>('[data-testid="notify-load"]')
    await act(async () => {
      load?.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    const [url, init] = fetch.mock.calls[1] as unknown as [string, RequestInit]
    expect(url).toBe(`${BASE}/v1/request`)
    const { request, signature } = JSON.parse(String(init.body)) as { request: string; signature: string }
    const req = JSON.parse(request) as Record<string, unknown>
    expect(req).toMatchObject({ v: 1, service: 'notify.example.org', action: 'account.get', identity: 'IDENTITY', key: 4, payload: {} })
    expect(secp.verify(base64ToBytes(signature), requestDigest(request), secp.getPublicKey(SECRET, true), { prehash: false })).toBe(true)
    expect(el.querySelector('[data-testid="notify-panel"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="notify-save"]')).not.toBeNull()
  })
})
