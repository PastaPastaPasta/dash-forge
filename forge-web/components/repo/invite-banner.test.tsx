// @vitest-environment jsdom
/**
 * The invite banner after a confirmed accept (D-10): the node the next read reaches may not have
 * indexed the new `consent` yet and answer "none". The banner keeps "You accepted the invitation"
 * through such stale reads, re-reads until a node shows the consent, and still gives way to a
 * read that finds the viewer a member.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoRef } from '@/lib/repo'
import type { Membership } from '@/lib/rules/v2'

const ME = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'
const OWNER = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'

/** What each `findConsent` answers, in order (then the last one again). */
let consentReads: (string | null)[] = []
let consentCalls = 0
let members: Membership[] = []

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('owner=o&name=demo&invite=1') }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: ME, signer: { identityId: ME } }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ disabledReason: null, check: () => true }) }))
vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span>{identityId.slice(0, 6)}</span> }))
// The dialog as a plain button that runs the write, as "Sign & accept" does.
vi.mock('@/components/confirm-dialog', () => ({
  ConfirmDialog: ({ open, onConfirm }: { open: boolean; onConfirm: (intent: string) => Promise<void> }) =>
    open ? (
      <button type="button" data-testid="confirm" onClick={() => void onConfirm('intent')}>
        Sign &amp; accept
      </button>
    ) : null,
}))
vi.mock('@/lib/repo', async (orig) => ({
  ...(await orig<typeof import('@/lib/repo')>()),
  repoContractIds: () => [],
  readMembershipsCached: async () => members,
  findConsent: async () => {
    const i = Math.min(consentCalls++, consentReads.length - 1)
    return consentReads[i] ?? null
  },
  acceptInvite: async () => ({ documentId: 'consent1', confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: null }),
}))

import { InviteBanner } from './invite-banner'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const repo = { forge: {}, repoId: 'R', ownerId: OWNER, name: 'demo', visibility: 'public' } as unknown as RepoRef
let host: HTMLDivElement
let root: Root

const q = (id: string): Element | null => host.querySelector(`[data-testid="${id}"]`)
const flush = async (ms = 0): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function accept(): Promise<void> {
  await act(async () => (q('invite-accept') as HTMLButtonElement).click())
  await act(async () => (q('confirm') as HTMLButtonElement).click())
  await flush()
}

beforeEach(async () => {
  vi.useFakeTimers()
  consentCalls = 0
  members = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

async function render(): Promise<void> {
  act(() => root.render(<InviteBanner repo={repo} />))
  await flush()
}

describe('the invite banner after a confirmed accept', () => {
  it('stays accepted while every node still answers "no consent"', async () => {
    consentReads = [null]
    await render()
    expect(q('invite-accept')).not.toBeNull()
    await accept()
    expect(q('invite-accepted')).not.toBeNull()
    expect(q('invite-accept')).toBeNull()
    // Every re-read (1.5 s apart) is stale: the banner never reverts.
    for (let i = 0; i < 10; i++) {
      await flush(1500)
      expect(q('invite-accepted')).not.toBeNull()
      expect(q('invite-accept')).toBeNull()
    }
    // One cold read, then the bounded read-after-write retries (one read and 8 more).
    expect(consentCalls).toBe(1 + 9)
  })

  it('re-reads until a node shows the consent, then stops', async () => {
    consentReads = [null, null, null, 'consent1']
    await render()
    await accept()
    await flush(1500 * 5)
    expect(q('invite-accepted')).not.toBeNull()
    expect(consentCalls).toBe(4)
  })

  it('gives way to a read that finds the viewer a member', async () => {
    consentReads = [null]
    await render()
    await accept()
    members = [{ identity: ME, role: 'writer', createdAt: 1 }]
    await flush(1500)
    expect(q('invite-banner')).toBeNull()
  })
})
