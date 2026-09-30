// @vitest-environment jsdom
/**
 * QW-071: Settings → Webhooks lists a public repo's hooks, and a maintainer adds one from the
 * browser (its secret shown once) or learns what is missing (the encryption key), instead of the
 * section not existing and `dg webhook` being the only way.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoHome } from '@/lib/view'
import type { WebhookView } from '@/lib/repo/webhooks'

const { state } = vi.hoisted(() => ({
  state: {
    docs: [] as WebhookView[],
    sealer: { kind: 'ready', seal: async () => ({}) } as { kind: string; seal?: unknown },
    written: [] as { url: string; events: readonly string[]; relayIdentityId: string; secret: string }[],
  },
}))
vi.mock('@/lib/repo/webhooks', async (orig) => ({
  ...(await orig<typeof import('@/lib/repo/webhooks')>()),
  readWebhookDocs: async () => state.docs,
  writeWebhook: async (_s: unknown, _a: unknown, _r: unknown, _seal: unknown, input: { url: string; events: readonly string[]; relayIdentityId: string; secret: string }) => {
    state.written.push(input)
  },
}))
vi.mock('@/lib/auth/encryption-key', () => ({ webhookSealer: async () => state.sealer }))
vi.mock('@/lib/view/retry', () => ({ retryWhileMissing: async () => true }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signer: { identityId: 'M' }, identity: 'M', unlockScope: 'full' }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span>{identityId}</span> }))
vi.mock('@/components/auth/unlock-more', () => ({ UnlockMore: () => <div data-testid="webhooks-unlock" /> }))
vi.mock('@/components/confirm-dialog', () => ({
  ConfirmDialog: ({ open, onConfirm, confirmLabel }: { open: boolean; onConfirm: (i: string) => Promise<void>; confirmLabel: string }) =>
    open ? (
      <button type="button" data-testid={`confirm-${confirmLabel}`} onClick={() => void onConfirm('intent')}>
        {confirmLabel}
      </button>
    ) : null,
}))
vi.mock('next/link', () => ({ default: (props: React.ComponentProps<'a'>) => <a {...props} /> }))

import { base58Encode } from '@/lib/auth/base58'
import { WebhookSettings } from './webhook-settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RELAY = base58Encode(new Uint8Array(32).fill(3))
const repoHome = (visibility: 'public' | 'private'): RepoHome =>
  ({ repo: { repoId: 'R', name: 'r', ownerId: 'O', visibility, forge: { core: 'C', collab: 'L', community: 'M' } } }) as unknown as RepoHome
const hook = (doc: string, url: string, disabled = false): WebhookView => ({
  documentId: doc, ownerId: 'M', createdAt: 1, hookId: doc.padEnd(64, '0'), url, events: ['push'], relayIdentityId: RELAY, relayKeyId: 4, disabled,
})

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  state.docs = []
  state.written = []
  state.sealer = { kind: 'ready', seal: async () => ({}) }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = async (home: RepoHome, maintainer = true): Promise<void> => {
  await act(async () => {
    root.render(<WebhookSettings home={home} maintainer={maintainer} />)
  })
}
const type = (id: string, value: string): void => {
  const input = host.querySelector<HTMLInputElement>(`#${id}`)!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('Settings → Webhooks', () => {
  it('lists the active hooks (a newest disabled revision is gone)', async () => {
    state.docs = [hook('a1', 'https://ci.example.com/a'), hook('b1', 'https://ci.example.com/b', true)]
    await render(repoHome('public'))
    const rows = [...host.querySelectorAll('[data-testid="webhook-row"]')]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('https://ci.example.com/a')
    expect(rows[0]?.textContent).toContain('push')
  })

  it('adds a hook and shows its secret once', async () => {
    await render(repoHome('public'))
    type('webhook-url', 'https://ci.example.com/hook')
    type('webhook-relay', RELAY)
    act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Add webhook')!.click())
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="confirm-Sign & add"]')!.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(state.written).toHaveLength(1)
    expect(state.written[0]).toMatchObject({ url: 'https://ci.example.com/hook', events: [], relayIdentityId: RELAY })
    const secret = state.written[0]!.secret
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    const box = host.querySelector('[data-testid="webhook-secret"]')!
    expect(box.textContent).toContain('shown once')
    // Masked until asked for (QW2-001): neither the text nor an accessible name carries it.
    expect(box.textContent).not.toContain(secret)
    expect(box.innerHTML).not.toContain(secret)
    act(() => box.querySelector<HTMLButtonElement>('button[aria-label="Show the webhook secret"]')!.click())
    expect(box.textContent).toContain(secret)
  })

  it('refuses a URL the schema refuses before anything is signed', async () => {
    await render(repoHome('public'))
    type('webhook-url', 'https://10.0.0.1/hook')
    type('webhook-relay', RELAY)
    expect(host.textContent).toMatch(/not an IP address/)
    expect([...host.querySelectorAll('button')].find((b) => b.textContent === 'Add webhook')!.disabled).toBe(true)
  })

  it('says the encryption key is missing instead of offering a form that cannot seal', async () => {
    state.sealer = { kind: 'no-key' }
    await render(repoHome('public'))
    expect(host.querySelector('[data-testid="webhooks-no-key"]')).not.toBeNull()
    expect(host.querySelector('#webhook-url')).toBeNull()
  })

  it('explains that a private repo has no webhooks', async () => {
    await render(repoHome('private'))
    expect(host.querySelector('[data-testid="webhooks-private"]')).not.toBeNull()
    expect(host.querySelector('#webhook-url')).toBeNull()
  })
})
