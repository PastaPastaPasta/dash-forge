// @vitest-environment jsdom
/**
 * Review fixes to the members-only UX (stream 1D, PR #406): the quote gate, the picker inside a
 * dialog and on a phone, the Members radio's name, the Turn on sheet's honest states, the E311 and
 * specific-people wording, the header chip's explanation, "View as public" focus, and a composer
 * starting on a saved draft's audience.
 */

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoHome, MembersOnlyEntry, MembersOnlyTarget } from '@/lib/view'
import type { MembersAccess } from '@/lib/view/repo-view'
import type { Membership } from '@/lib/rules/v2'
import { NO_KEY_SHARED_TEXT } from '@/lib/repo/members-writes'

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: 'alice', unlockScope: 'full' }) }))
vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span>@{identityId}</span> }))
vi.mock('@/components/auth/unlock-more', () => ({
  UNLOCK_MEMBERS_ONLY: 'Unlock to read members-only content',
  UnlockMore: ({ title, testId }: { title: string; testId: string }) => <div data-testid={testId}>{title}</div>,
}))
vi.mock('@/components/confirm-dialog', () => ({
  ConfirmDialog: ({ open, title, cost, blocked, children }: { open: boolean; title: string; cost: unknown; blocked?: React.ReactNode; children: React.ReactNode }) =>
    open ? (
      <div data-testid="confirm" data-cost={cost === 'pending' ? 'pending' : cost === null ? 'free' : 'shown'} data-blocked={blocked ? 'yes' : 'no'}>
        <h2>{title}</h2>
        {children}
        {blocked}
      </div>
    ) : null,
}))
const privateWrite: { context: unknown; loading?: boolean; error?: string | null; retry?: () => void; done: () => void } = { context: null, done: () => undefined }
vi.mock('@/hooks/use-private-write', () => ({ usePrivateWrite: () => privateWrite }))
let keyState: 'open' | 'locked' | 'none' = 'open'
vi.mock('@/lib/auth/encryption-key', () => ({ encryptionKeyState: async () => keyState }))
vi.mock('@/lib/repo/checks', () => ({ readRunners: async () => [] }))
let membersRead: () => Promise<Membership[]> = async () => []
vi.mock('@/lib/repo', async (orig) => ({
  ...(await orig<typeof import('@/lib/repo')>()),
  repoContractIds: () => [],
  readMembershipsCached: () => membersRead(),
}))

import { setPublicView } from '@/hooks/use-public-view'
import { Dialog } from '@/components/ui/dialog'
import {
  AudienceChip,
  MembersChip,
  MembersOnlyRow,
  MembersOnlySummary,
  MembersOnlyTargetPage,
  PublicViewBanner,
  TurnOnMembersSheet,
  useMembersKeyBlock,
  ViewAsPublicButton,
  useComposerAudience,
  useQuoteGate,
} from './audience'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const m = (identity: string, role: Membership['role']): Membership => ({ identity, role, createdAt: 0 })
const MEMBERS = [m('alice', 'maintainer'), m('bob', 'writer'), m('carl', 'reader')]
const repo = { forge: { core: 'C', collab: 'C', community: 'C', group: 'G' }, repoId: 'R', ownerId: 'alice', name: 'demo', visibility: 'public' } as const
const homeWith = (lane?: MembersAccess, extra: Partial<RepoHome> = {}): RepoHome => ({ repo, ...(lane ? { lane } : {}), ...extra }) as unknown as RepoHome
const MEMBER = { access: 'member' } as MembersAccess

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  membersRead = async () => MEMBERS
  Object.assign(privateWrite, { context: null, loading: false, error: null, retry: undefined })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

const q = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`)
const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}
const escape = (): void => {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

function Composer({ home, parent = 'public', start }: { home: RepoHome; parent?: 'public' | 'members'; start?: 'public' | 'members' }): JSX.Element {
  const state = useComposerAudience(home, { parent, members: MEMBERS, start })
  return (
    <>
      <AudienceChip home={home} state={state} />
      <span data-testid="audience">{state.audience}</span>
    </>
  )
}

describe('the quote gate (every public post, product H8)', () => {
  const SECRET = 'The staging database password rotates on Friday at noon.'
  const go = vi.fn()
  function Gate({ text }: { text: string | null }): JSX.Element {
    const gate = useQuoteGate()
    return (
      <>
        <button type="button" data-testid="submit" onClick={() => gate.check(text, [SECRET], go)}>
          Submit
        </button>
        {gate.dialog}
      </>
    )
  }
  beforeEach(() => go.mockReset())

  it('posts at once when nothing public repeats members-only text', () => {
    act(() => root.render(<Gate text="A plain public reply" />))
    act(() => q('submit')!.click())
    expect(go).toHaveBeenCalledTimes(1)
    act(() => root.render(<Gate text={null} />))
    act(() => q('submit')!.click())
    expect(go).toHaveBeenCalledTimes(2)
  })

  it('asks first, and posts only on "Post publicly"', () => {
    act(() => root.render(<Gate text={`> ${SECRET}\nAgreed.`} />))
    act(() => q('submit')!.click())
    expect(go).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain("You're quoting a members-only comment into a public reply. Everyone will be able to read the quoted text.")
    act(() => q('quote-cancel')!.click())
    expect(go).not.toHaveBeenCalled()
    act(() => q('submit')!.click())
    act(() => q('quote-confirm')!.click())
    expect(go).toHaveBeenCalledTimes(1)
    expect(q('quote-confirm')).toBeNull()
  })
})

describe('the picker', () => {
  it('closes on Escape inside a dialog, and leaves the dialog open', async () => {
    const onClose = vi.fn()
    act(() =>
      root.render(
        <Dialog open onClose={onClose} title="Open an issue">
          <Composer home={homeWith(MEMBER)} />
        </Dialog>,
      ),
    )
    const chip = q('audience-chip') as HTMLButtonElement
    act(() => chip.click())
    await flush()
    expect(q('audience-picker')).not.toBeNull()
    escape()
    expect(q('audience-picker')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(chip)
    // With the picker closed, Escape is the dialog's again.
    escape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('leaves the dialog trapping Tab while it is open', async () => {
    act(() =>
      root.render(
        <>
          <button type="button" data-testid="behind">
            Behind
          </button>
          <Dialog open onClose={() => undefined} title="Open an issue">
            <Composer home={homeWith(MEMBER)} />
          </Dialog>
        </>,
      ),
    )
    act(() => (q('audience-chip') as HTMLButtonElement).click())
    await flush()
    // Focus that lands behind the dialog is pulled back into it.
    act(() => (q('behind') as HTMLButtonElement).focus())
    expect(document.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true)
  })

  it('opens toward the side with room (a chip near the left edge opens to the right)', async () => {
    const at = (right: number) => vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ right, left: right - 80, top: 0, bottom: 20, width: 80, height: 20, x: right - 80, y: 0, toJSON: () => ({}) } as DOMRect)
    at(120)
    act(() => root.render(<Composer home={homeWith(MEMBER)} />))
    act(() => (q('audience-chip') as HTMLButtonElement).click())
    await flush()
    expect(q('audience-chip-panel')?.dataset.align).toBe('left')
    // A phone gets a sheet fixed to the bottom of the screen, whichever side.
    expect(q('audience-chip-panel')?.className).toContain('fixed inset-x-2 bottom-2')
    act(() => (q('audience-chip') as HTMLButtonElement).click())
    vi.restoreAllMocks()
    at(900)
    act(() => (q('audience-chip') as HTMLButtonElement).click())
    await flush()
    expect(q('audience-chip-panel')?.dataset.align).toBe('right')
  })

  it('names the Members radio "Members (N)" alone, and describes it with what it means', async () => {
    act(() => root.render(<Composer home={homeWith(MEMBER)} />))
    act(() => (q('audience-chip') as HTMLButtonElement).click())
    await flush()
    const radio = document.querySelector<HTMLInputElement>('[data-testid="audience-option-members"] input')!
    expect(radio.closest('label')).toBeNull()
    expect(document.querySelector(`label[for="${radio.id}"]`)?.textContent?.trim()).toBe('Members (3)')
    expect(document.getElementById(radio.getAttribute('aria-describedby')!)?.textContent).toContain('Current and future members of this repo (3, including 1 with Read access).')
  })
})

describe('a composer started on a saved draft', () => {
  function Drawer(): JSX.Element {
    const [start, setStart] = useState<'public' | 'members' | undefined>('members')
    return (
      <>
        <Composer home={homeWith(MEMBER)} start={start} />
        <button type="button" data-testid="draft-public" onClick={() => setStart('public')} />
        <button type="button" data-testid="draft-none" onClick={() => setStart(undefined)} />
      </>
    )
  }

  it("starts on a members-only draft's audience from its first render, and keeps a pick until the draft moves", async () => {
    act(() => root.render(<Drawer />))
    expect(q('audience')?.textContent).toBe('members')
    act(() => (q('audience-chip') as HTMLButtonElement).click())
    await flush()
    act(() => document.querySelector<HTMLInputElement>('[data-testid="audience-option-public"] input')!.click())
    expect(q('audience')?.textContent).toBe('public')
    // The draft saved as public: the pick is spent, and stays public.
    act(() => q('draft-public')!.click())
    expect(q('audience')?.textContent).toBe('public')
    // Discarded: the thread's audience, with no earlier pick coming back.
    act(() => q('draft-none')!.click())
    expect(q('audience')?.textContent).toBe('public')
  })

  it('never starts public inside a members-only thread, whatever the draft says', () => {
    act(() => root.render(<Composer home={homeWith(MEMBER)} parent="members" start="public" />))
    expect(q('audience')?.textContent).toBe('members')
  })
})

describe('the Turn on sheet', () => {
  it('shows no cost and waits while the members are read, then prices them', async () => {
    let resolve: (m: Membership[]) => void = () => undefined
    membersRead = () => new Promise((r) => (resolve = r))
    privateWrite.context = {}
    act(() => root.render(<TurnOnMembersSheet home={homeWith({ access: 'none' } as MembersAccess)} open onClose={() => undefined} />))
    await flush()
    expect(q('confirm')?.dataset.cost).toBe('pending')
    expect(q('confirm')?.dataset.blocked).toBe('yes')
    expect(q('turn-on-reading-members')?.textContent).toBe('Reading the members…')
    expect(q('turn-on-cost')).toBeNull()
    await act(async () => resolve(MEMBERS))
    expect(q('confirm')?.dataset.cost).toBe('shown')
    expect(q('confirm')?.dataset.blocked).toBe('no')
    expect(q('turn-on-cost')?.textContent).toContain('Setting up keys for 3 members')
  })

  it('counts the maintainer turning it on when no member is listed', async () => {
    membersRead = async () => []
    privateWrite.context = {}
    act(() => root.render(<TurnOnMembersSheet home={homeWith({ access: 'none' } as MembersAccess)} open onClose={() => undefined} />))
    await flush()
    expect(q('turn-on-cost')?.textContent).toContain("You're the only member so far.")
  })

  it('offers the unlock when the encryption key is locked in this tab, even with a write context', async () => {
    membersRead = async () => MEMBERS
    privateWrite.context = {}
    keyState = 'locked'
    try {
      act(() => root.render(<TurnOnMembersSheet home={homeWith({ access: 'none' } as MembersAccess)} open onClose={() => undefined} />))
      await flush()
      expect(q('confirm')?.dataset.blocked).toBe('yes')
      expect(q('turn-on-unlock')).not.toBeNull()
    } finally {
      keyState = 'open'
    }
  })

  it('says why the keys could not be read, with Retry, instead of "Reading your keys…" for ever', async () => {
    const retry = vi.fn()
    Object.assign(privateWrite, { context: null, loading: false, error: 'the vault is busy.', retry })
    act(() => root.render(<TurnOnMembersSheet home={homeWith({ access: 'none' } as MembersAccess)} open onClose={() => undefined} />))
    await flush()
    expect(q('turn-on-reading-keys')).toBeNull()
    expect(q('turn-on-key-error')?.textContent).toContain("Couldn't open your encryption key: the vault is busy.")
    act(() => q('turn-on-key-error')!.querySelector('button')!.click())
    expect(retry).toHaveBeenCalled()
    // Read, no error, still nothing to write with: said, never a spinner.
    Object.assign(privateWrite, { error: null })
    act(() => root.render(<TurnOnMembersSheet home={homeWith({ access: 'none' } as MembersAccess)} open onClose={() => undefined} />))
    await flush()
    expect(q('turn-on-reading-keys')).toBeNull()
    expect(q('turn-on-key-error')?.textContent).toContain("Your encryption key isn't available in this tab.")
  })
})

describe('a key-aware members change (add, remove) in a tab whose key is locked', () => {
  function Host({ active }: { active: boolean }): JSX.Element {
    return <div data-testid="host">{useMembersKeyBlock(active, 'devnet')}</div>
  }
  it('offers the unlock while the key is locked, and nothing otherwise', async () => {
    keyState = 'locked'
    try {
      act(() => root.render(<Host active />))
      await flush()
      expect(q('members-key-unlock')).not.toBeNull()
      act(() => root.render(<Host active={false} />))
      await flush()
      expect(q('members-key-unlock')).toBeNull()
    } finally {
      keyState = 'open'
    }
    act(() => root.render(<Host active />))
    await flush()
    expect(q('members-key-unlock')).toBeNull()
  })
})

const item = (over: Partial<MembersOnlyEntry['item']> = {}): MembersOnlyEntry['item'] => ({
  type: 'comment',
  id: 'c1',
  author: 'bob',
  createdAt: Date.now() - 3600_000,
  asMember: true,
  number: null,
  replyTo: null,
  audience: 'members',
  why: 'noKey',
  ...over,
})
const target = (over: Partial<MembersOnlyTarget> = {}): MembersOnlyTarget => ({ placeholder: item({ type: 'issue', number: 3 }), number: 3, open: true, merged: false, comments: 4, ...over })

describe('E311, a member with no key shared yet', () => {
  it('says how to get it shared on the members-only page (no empty box)', () => {
    act(() => root.render(<MembersOnlyTargetPage home={homeWith({ access: 'no-key-shared' } as MembersAccess)} target={target()} />))
    expect(q('members-only-why')?.textContent).toBe(NO_KEY_SHARED_TEXT)
  })

  it('says it under the one locked line of a thread', () => {
    act(() => root.render(<MembersOnlySummary entries={[{ item: item() }]} lane={{ access: 'no-key-shared' } as MembersAccess} />))
    expect(q('members-only-no-key-shared')?.textContent).toBe(NO_KEY_SHARED_TEXT)
  })
})

describe('the members-only page', () => {
  it("shows a member a loading state, not an outsider's text, while their key session loads", () => {
    act(() => root.render(<MembersOnlyTargetPage home={homeWith(undefined, { laneLoading: true })} target={target()} />))
    expect(q('members-only-reading')?.textContent).toBe('Reading members-only content…')
    expect(q('members-only-why')?.textContent).not.toContain('Only members of this repo')
  })

  it('says "100+ comments" when its comment read was cut at a page', () => {
    act(() => root.render(<MembersOnlyTargetPage home={homeWith()} target={target({ comments: 100, moreComments: true })} />))
    expect(q('members-only-comments')?.textContent).toBe(' · 100+ comments')
  })

  it('names a specific-people document neutrally', () => {
    act(() => root.render(<MembersOnlyTargetPage home={homeWith()} target={target({ placeholder: item({ type: 'issue', number: 3, audience: 'specificPeople', why: 'letter' }) })} />))
    const page = q('members-only-target')!
    expect(page.textContent).toContain('Encrypted for specific people')
    expect(page.textContent).not.toContain('Members-only')
    expect(page.querySelector('h1')?.textContent).toBe('#3 · encrypted')
    act(() => root.render(<MembersOnlyRow entry={{ item: item({ audience: 'specificPeople', why: 'letter' }) }} />))
    expect(q('members-only-placeholder')?.textContent).toContain('Encrypted for specific people · @bob')
  })
})

describe('the header chip', () => {
  it('explains itself on a click, and to a screen reader without one', () => {
    act(() => root.render(<MembersChip home={homeWith({ access: 'locked' } as MembersAccess)} />))
    const chip = q('members-chip') as HTMLButtonElement
    expect(chip.tagName).toBe('BUTTON')
    expect(document.getElementById(chip.getAttribute('aria-describedby')!)?.textContent).toBe('This repo has members-only content. Unlock this tab to read it.')
    expect(q('members-chip-about')).toBeNull()
    act(() => chip.click())
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    expect(q('members-chip-about')?.textContent).toBe('This repo has members-only content. Unlock this tab to read it.')
  })
})

describe('"View as public" focus', () => {
  it('lands on the way back after switching on, and on the toggle after switching off', () => {
    const home = homeWith(MEMBER)
    act(() => root.render(<ViewAsPublicButton home={home} />))
    act(() => q('view-as-public')!.click())
    // The page remounts under the public view: the button pressed is gone.
    ;(document.activeElement as HTMLElement | null)?.blur()
    act(() => root.render(<PublicViewBanner repoId="R" onExit={() => setPublicView('R', false)} />))
    expect(document.activeElement).toBe(q('exit-public-view'))
    act(() => q('exit-public-view')!.click())
    ;(document.activeElement as HTMLElement | null)?.blur()
    act(() => root.render(<ViewAsPublicButton home={home} />))
    expect(document.activeElement).toBe(q('view-as-public'))
  })
})
