// @vitest-environment jsdom
/**
 * The invite banner after a confirmed accept (D-10): the node the next read reaches may not have
 * indexed the new `consent` yet and answer "none". The banner keeps "You accepted the invitation"
 * through such stale reads, re-reads until a node shows the consent, and still gives way to a
 * read that finds the viewer a member. The owner's pending invitations re-read while Settings is
 * open, so an accept made meanwhile (or one a lagging node hid) shows without a reload.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoRef } from '@/lib/repo'
import type { Membership } from '@/lib/rules/v2'

const ME = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'
const OWNER = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'

/** What each `findConsent` answers, in order (then the last one again); `'throw'` fails the read. */
let consentReads: (string | null)[] = []
let consentCalls = 0
let members: Membership[] = []

vi.mock('next/navigation', () => ({ usePathname: () => '/repo/', useSearchParams: () => new URLSearchParams('owner=o&name=demo&invite=1') }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
/** The viewer's session: signed in as ME unless a test signs out or locks. */
type Auth = { identity: string | null; signer: { identityId: string } | null; locked: boolean; resuming: boolean; vaultsLoaded?: boolean; vaultsError?: string | null; lockedIdentity?: string | null }
let auth: Auth = { identity: ME, signer: { identityId: ME }, locked: false, resuming: false }
const signedOut = (over: Partial<Auth> = {}): Auth => ({ identity: null, signer: null, locked: false, resuming: false, vaultsLoaded: true, vaultsError: null, lockedIdentity: null, ...over })
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => auth }))
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
    const answer = consentReads[Math.min(consentCalls++, consentReads.length - 1)] ?? null
    if (answer === 'throw') throw new Error('network: consent read failed')
    return answer
  },
  acceptInvite: async () => ({ documentId: 'consent1', confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: null }),
  readConsents: async () => {
    const answer = consentLists[Math.min(consentListCalls++, consentLists.length - 1)] ?? []
    if (answer === 'throw') throw new Error('network: consents read failed')
    if (Array.isArray(answer)) return answer
    await new Promise((r) => setTimeout(r, answer.after))
    return answer.ids
  },
}))

/** What each `readConsents` answers, in order (then the last one again); `after` answers that much later. */
let consentLists: (string[] | 'throw' | { after: number; ids: string[] })[] = []
let consentListCalls = 0

import { ConsentCheck, INVITES_POLL_MAX_MS, INVITES_POLL_MS, InviteBanner, Invitations, invitedRole, useInviteAccepted } from './invite-banner'
import { useUiStore } from '@/hooks/use-ui-store'

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
  auth = { identity: ME, signer: { identityId: ME }, locked: false, resuming: false }
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

describe('the invite link, signed out (QW2-012)', () => {
  it('shows the invitation with Sign in to accept, which opens the sheet over this page', async () => {
    auth = signedOut()
    await render()
    expect(q('invite-banner-signed-out')?.textContent).toMatch(/invited you to collaborate on this repo\. Sign in to accept/)
    await act(async () => (q('invite-sign-in') as HTMLButtonElement).click())
    expect(useUiStore.getState().loginOpen).toBe(true)
    expect(useUiStore.getState().loginIntent?.action).toBe('accept this invitation')
    act(() => useUiStore.getState().closeLogin())
  })

  it('says Unlock to accept for a locked session, and nothing while the session is picked up', async () => {
    auth = signedOut({ locked: true, lockedIdentity: ME })
    await render()
    expect(q('invite-sign-in')?.textContent).toBe('Unlock to accept')
    auth = signedOut({ resuming: true })
    await render()
    expect(q('invite-banner-signed-out')).toBeNull()
    // Not before the key list is read (Sign in would flip to Unlock), nor to the owner's own locked session.
    auth = signedOut({ vaultsLoaded: false })
    await render()
    expect(q('invite-banner-signed-out')).toBeNull()
    auth = signedOut({ locked: true, lockedIdentity: OWNER })
    await render()
    expect(q('invite-banner-signed-out')).toBeNull()
  })
})

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

  it('a re-read that fails after the accept does not bring back the button either', async () => {
    consentReads = [null, 'throw']
    await render()
    await accept()
    expect(q('invite-accepted')).not.toBeNull()
    expect(q('invite-error')).toBeNull()
    expect(q('invite-accept')).toBeNull()
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

describe("the owner's pending invitations while Settings is open", () => {
  const INVITEE = 'EA8HsynH63cw1i8xQLoARwk43sDf74HrKut1D4RV3L35'
  const OTHER = 'DBL7NnqGZjyVHwo2jp3K1QD9oRBcbFZnSnB9kQ8bmoYu'
  const ownerRepo = { ...repo } as RepoRef
  const pending = (): string => q('pending-invites')?.textContent ?? ''
  const lists = (id: string): boolean => pending().includes(id.slice(0, 6))
  let visibility: DocumentVisibilityState = 'visible'
  const setVisibility = (v: DocumentVisibilityState): void => {
    visibility = v
    document.dispatchEvent(new Event('visibilitychange'))
  }
  beforeEach(() => {
    consentListCalls = 0
    visibility = 'visible'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  })
  afterEach(() => {
    delete (document as { visibilityState?: unknown }).visibilityState
  })
  async function renderInvitations(memberIds: string[] | null = []): Promise<void> {
    act(() => root.render(<Invitations repo={ownerRepo} members={memberIds} awaiting={null} disabled={false} role="writer" onPick={() => undefined} />))
    await flush()
  }

  it('shows an accept made after the page read, without a reload', async () => {
    consentLists = [[], [], [INVITEE]]
    await renderInvitations()
    expect(q('pending-invites')).toBeNull()
    await flush(INVITES_POLL_MS)
    expect(q('pending-invites')).toBeNull()
    await flush(INVITES_POLL_MS * 2)
    expect(lists(INVITEE)).toBe(true)
  })

  it('keeps a shown accept through a lagging node and a failed re-read', async () => {
    consentLists = [[INVITEE], [], 'throw', []]
    await renderInvitations()
    for (let i = 0; i < 4; i++) {
      expect(lists(INVITEE)).toBe(true)
      await flush(INVITES_POLL_MAX_MS)
    }
    expect(consentListCalls).toBeGreaterThanOrEqual(4)
    expect(lists(INVITEE)).toBe(true)
    expect(host.textContent).not.toMatch(/Couldn.t read the invitations/)
  })

  it("keeps a fresh node's answer when a lagging read that started earlier lands after it", async () => {
    // Read 2 (a lagging node) starts first and answers last; read 3 (a fresh node) sees OTHER.
    // Then another lagging node: what the page keeps must still hold OTHER.
    consentLists = [[INVITEE], { after: 3000, ids: [INVITEE] }, { after: 500, ids: [INVITEE, OTHER] }, [INVITEE]]
    await renderInvitations()
    await act(async () => setVisibility('visible'))
    await flush(100)
    await act(async () => setVisibility('visible'))
    await flush(4000)
    expect(consentListCalls).toBe(3)
    expect(lists(OTHER)).toBe(true)
    await flush(INVITES_POLL_MAX_MS)
    expect(consentListCalls).toBe(4)
    expect(lists(OTHER)).toBe(true)
  })

  it('reports a first read that fails, and a later read clears it', async () => {
    consentLists = ['throw', [INVITEE]]
    await renderInvitations()
    expect(host.textContent).toMatch(/Couldn.t read the invitations/)
    await flush(INVITES_POLL_MS)
    expect(host.textContent).not.toMatch(/Couldn.t read the invitations/)
    expect(lists(INVITEE)).toBe(true)
  })

  it('lists nobody as pending until the members are read, and drops one once they are a member', async () => {
    consentLists = [[INVITEE, OTHER]]
    await renderInvitations(null)
    expect(q('pending-invites')).toBeNull()
    await renderInvitations([])
    expect(lists(INVITEE) && lists(OTHER)).toBe(true)
    // The owner adds INVITEE; a lagging node then answers only INVITEE's consent: OTHER stays.
    consentLists = [[INVITEE]]
    await renderInvitations([INVITEE])
    await flush(INVITES_POLL_MAX_MS)
    expect(lists(INVITEE)).toBe(false)
    expect(lists(OTHER)).toBe(true)
  })

  it('backs off while nothing new turns up, and starts over when something does', async () => {
    consentLists = [[], [], [], [], [INVITEE], []]
    await renderInvitations()
    const at: number[] = []
    for (let t = 1; t <= 200; t++) {
      const before = consentListCalls
      await flush(1000)
      if (consentListCalls > before) at.push(t)
    }
    // 10 s, then 20, 40, 60 (the cap); the new consent at 130 s starts over at 10 s.
    expect(at.slice(0, 6)).toEqual([10, 30, 70, 130, 140, 160])
  })

  it('re-reads only while the page is visible, and at once when it is shown again', async () => {
    consentLists = [[]]
    await renderInvitations()
    expect(consentListCalls).toBe(1)
    setVisibility('hidden')
    await flush(INVITES_POLL_MS * 3)
    expect(consentListCalls).toBe(1)
    await act(async () => setVisibility('visible'))
    await flush()
    expect(consentListCalls).toBe(2)
    await flush(INVITES_POLL_MS)
    expect(consentListCalls).toBe(3)
  })

  it('stops re-reading when the page closes', async () => {
    consentLists = [[]]
    await renderInvitations()
    act(() => root.render(<></>))
    await flush(INVITES_POLL_MAX_MS * 3)
    expect(consentListCalls).toBe(1)
  })
})

describe('invitedRole: the role an invite link suggests', () => {
  it('names a role the owner could grant here (a reader on public and private repos)', () => {
    expect(invitedRole('triage', 'public')).toBe('triage')
    expect(invitedRole('reader', 'public')).toBe('reader')
    expect(invitedRole('reader', 'private')).toBe('reader')
    expect(invitedRole('1', 'private')).toBeNull()
    expect(invitedRole(null, 'public')).toBeNull()
  })
})

describe('a pending invitation picks its own role (QW4-034)', () => {
  const INVITEE = 'EA8HsynH63cw1i8xQLoARwk43sDf74HrKut1D4RV3L35'

  it('preselects no role, even when the page picker says writer, and adds with the role its row picks', async () => {
    consentLists = [[INVITEE]]
    consentListCalls = 0
    const picks: [string, string][] = []
    act(() =>
      root.render(<Invitations repo={repo} members={[]} awaiting={null} disabled={false} role="writer" onPick={(id, r) => picks.push([id, r])} />),
    )
    await flush()
    const row = q('pending-invite')!
    const select = row.querySelector<HTMLSelectElement>('select')!
    const add = row.querySelector<HTMLButtonElement>('button')!
    expect(select.value).toBe('')
    expect([...select.options].map((o) => o.value)).toEqual(['', 'reader', 'triage', 'writer', 'maintainer'])
    expect(add.textContent).toBe('Add')
    expect(add.disabled).toBe(true)
    await act(async () => {
      select.value = 'triage'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(add.textContent).toBe('Add with Triage access')
    await act(async () => add.click())
    expect(picks).toEqual([[INVITEE, 'triage']])
  })
})

describe('useInviteAccepted: Add knows before it prices anything (QW4-036)', () => {
  const INVITEE = 'EA8HsynH63cw1i8xQLoARwk43sDf74HrKut1D4RV3L35'
  function Probe({ id }: { id: string | null }): JSX.Element {
    const check = useInviteAccepted(repo, id)
    return (
      <div data-testid="probe" data-accepted={String(check.accepted)}>
        <ConsentCheck identity={id} check={check} />
      </div>
    )
  }
  const accepted = (): string | null | undefined => q('probe')?.getAttribute('data-accepted')

  it("says an identity hasn't accepted, and Check again finds an accept made since", async () => {
    consentReads = [null, null, null, 'consent1']
    act(() => root.render(<Probe id={INVITEE} />))
    await flush()
    // Still re-reading a "none" (a node behind a fresh accept): nothing known yet.
    expect(accepted()).toBe('null')
    expect(q('consent-checking')).not.toBeNull()
    await flush(3000)
    expect(consentCalls).toBe(3)
    expect(accepted()).toBe('false')
    expect(q('consent-missing')?.textContent).toMatch(/hasn.t accepted your invitation yet/)
    await act(async () => (q('consent-missing')!.querySelector('button') as HTMLButtonElement).click())
    await flush()
    expect(accepted()).toBe('true')
    expect(q('consent-missing')).toBeNull()
  })

  it('finds an accept a lagging node missed on its first read', async () => {
    consentReads = [null, 'consent1']
    act(() => root.render(<Probe id={INVITEE} />))
    await flush(1500)
    expect(accepted()).toBe('true')
  })

  it('needs no acceptance from the owner, and reads nothing for no identity', async () => {
    act(() => root.render(<Probe id={OWNER} />))
    await flush()
    expect(accepted()).toBe('true')
    act(() => root.render(<Probe id={null} />))
    await flush()
    expect(accepted()).toBe('null')
    expect(consentCalls).toBe(0)
  })

  it('reports a failed read with a retry', async () => {
    consentReads = ['throw']
    act(() => root.render(<Probe id={INVITEE} />))
    await flush()
    expect(accepted()).toBe('null')
    expect(q('consent-check-error')?.textContent).toMatch(/consent read failed/)
  })
})
