// @vitest-environment jsdom
/**
 * The audience chip and picker beside a composer, the placeholders a reader who cannot open
 * members-only content sees, the hidden-items note and the "#N · members-only" page (DESIGN §10,
 * D14; stream 1D). Every string is the glossary's: Public, Members, members-only.
 */

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoHome, MembersOnlyEntry, MembersOnlyTarget } from '@/lib/view'
import type { MembersAccess } from '@/lib/view/repo-view'
import type { Membership } from '@/lib/rules/v2'
import type { HiddenCounts } from '@/lib/repo/private-content'

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: 'me', unlockScope: 'full' }) }))
vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span>@{identityId}</span> }))
vi.mock('@/components/auth/unlock-more', () => ({
  UNLOCK_MEMBERS_ONLY: 'Unlock to read members-only content',
  UnlockMore: ({ title, testId }: { title: string; testId: string }) => <div data-testid={testId}>{title}</div>,
}))
vi.mock('@/components/confirm-dialog', () => ({
  ConfirmDialog: ({ open, title, description, children }: { open: boolean; title: string; description: string; children: React.ReactNode }) =>
    open ? (
      <div data-testid="confirm">
        <h2>{title}</h2>
        <p>{description}</p>
        {children}
      </div>
    ) : null,
}))
vi.mock('@/hooks/use-private-write', () => ({ usePrivateWrite: () => ({ context: null, done: () => undefined }) }))
vi.mock('@/lib/auth/encryption-key', () => ({ encryptionKeyState: async () => 'open' }))
vi.mock('@/lib/repo/checks', () => ({ readRunners: async () => ['bot'] }))
let params: Record<string, string> = {}
vi.mock('@/hooks/use-query-param', () => ({ useParam: (name: string) => params[name] ?? '' }))
let members: Membership[] = []
vi.mock('@/lib/repo', async (orig) => ({
  ...(await orig<typeof import('@/lib/repo')>()),
  repoContractIds: () => [],
  readMembershipsCached: async () => members,
}))

import { AudienceChip, MembersOnlyCreateNotice, MembersOnlyRow, MembersOnlySummary, MembersOnlyTargetPage, useComposerAudience } from './audience'
import { HiddenNote } from './hidden-note'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const m = (identity: string, role: Membership['role']): Membership => ({ identity, role, createdAt: 0 })
const repo = { forge: { core: 'C', collab: 'C', community: 'C', group: 'G' }, repoId: 'R', ownerId: 'alice', name: 'demo', visibility: 'public' } as const
const homeWith = (lane?: MembersAccess): RepoHome => ({ repo, ...(lane ? { lane } : {}) }) as unknown as RepoHome

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  members = [m('alice', 'maintainer'), m('bob', 'writer'), m('bot', 'reader')]
  params = {}
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const q = (id: string): HTMLElement | null => host.querySelector(`[data-testid="${id}"]`)
const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

function Composer({ home, parent = 'public', maintainer = false }: { home: RepoHome; parent?: 'public' | 'members'; maintainer?: boolean }): JSX.Element {
  const state = useComposerAudience(home, { parent, members, maintainer })
  const [posted, setPosted] = useState<string | null>(null)
  return (
    <>
      <AudienceChip home={home} state={state} />
      <button type="button" data-testid="post" onClick={() => setPosted(state.audience)}>
        Comment
      </button>
      <span data-testid="posted">{posted}</span>
    </>
  )
}

describe('the audience chip', () => {
  it('lets a member who holds the key pick Members, with the picker copy', async () => {
    act(() => root.render(<Composer home={homeWith({ access: 'member' } as MembersAccess)} />))
    const chip = q('audience-chip') as HTMLButtonElement
    expect(chip.tagName).toBe('BUTTON')
    expect(chip.textContent).toContain('Public')
    act(() => chip.click())
    await flush()
    const picker = q('audience-picker') as HTMLElement
    expect(picker.textContent).toContain('Who can read this?')
    expect(picker.textContent).toContain('Members (3)')
    // the reader is counted; the runner that is a member reads as a CI bot (D23)
    expect(picker.textContent).toContain('Current and future members of this repo (3, including 1 reader and 1 CI bot).')
    const members = host.querySelector<HTMLInputElement>('[data-testid="audience-option-members"] input')!
    expect(members.disabled).toBe(false)
    act(() => members.click())
    expect(q('audience-chip')?.textContent).toContain('Members (3)')
    act(() => q('post')!.click())
    expect(q('posted')?.textContent).toBe('members')
  })

  it('offers a maintainer "Turn on members-only content" when it is off, and asks others to ask one', async () => {
    act(() => root.render(<Composer home={homeWith({ access: 'none' } as MembersAccess)} maintainer />))
    act(() => (q('audience-chip') as HTMLButtonElement).click())
    await flush()
    expect(host.querySelector<HTMLInputElement>('[data-testid="audience-option-members"] input')!.disabled).toBe(true)
    expect(q('audience-members-blocked')?.textContent).toContain('Members-only content is off in this repo.')
    act(() => q('audience-turn-on')!.click())
    await flush()
    expect(q('confirm')?.textContent).toContain('Turn on members-only content?')
    expect(q('confirm')?.textContent).toContain('People using older Forge builds will see fewer things until they update.')

    act(() => root.render(<Composer home={homeWith({ access: 'none' } as MembersAccess)} />))
    act(() => (q('audience-chip') as HTMLButtonElement).click())
    await flush()
    expect(q('audience-members-blocked')?.textContent).toBe('Ask a maintainer to turn on members-only content for this repo. ')
  })

  it('sends a member with no encryption key to set it up', async () => {
    act(() => root.render(<Composer home={homeWith({ access: 'no-key' } as MembersAccess)} />))
    act(() => (q('audience-chip') as HTMLButtonElement).click())
    await flush()
    const link = host.querySelector<HTMLAnchorElement>('[data-testid="audience-members-blocked"] a')
    expect(link?.textContent).toBe('Set up your encryption key')
    expect(link?.getAttribute('href')).toBe('/settings/#private-repos')
  })

  it('is plain "Public" for a non-member, and plain Members inside a members-only thread', () => {
    act(() => root.render(<Composer home={homeWith()} />))
    expect(q('audience-chip')?.tagName).toBe('SPAN')
    expect(q('audience-chip')?.textContent).toContain('Public')
    act(() => root.render(<Composer home={homeWith({ access: 'member' } as MembersAccess)} parent="members" />))
    expect(q('audience-chip')?.tagName).toBe('SPAN')
    expect(q('audience-chip')?.textContent).toContain('Members (3)')
    act(() => q('post')!.click())
    expect(q('posted')?.textContent).toBe('members')
  })
})

const entry = (type: 'comment' | 'review', author: string, verdict?: 'approve'): MembersOnlyEntry => ({
  item: { type, id: `${type}-${author}`, author, createdAt: Date.now() - 2 * 3600_000, asMember: true, number: null, replyTo: null, audience: 'members', why: 'noKey' },
  ...(verdict ? { verdict } : {}),
})

describe('what a reader who cannot open it sees', () => {
  it('a placeholder per members-only comment, and a review with its public verdict', () => {
    act(() => root.render(<><MembersOnlyRow entry={entry('comment', 'alice')} /><MembersOnlyRow entry={entry('review', 'bob', 'approve')} /></>))
    const rows = [...host.querySelectorAll('[data-testid="members-only-placeholder"]')].map((r) => r.textContent?.replace(/\s+/g, ' ').trim())
    expect(rows).toEqual(['Members-only comment · @alice · 2h ago', 'Members-only review · @bob approved · 2h ago'])
  })

  it('a locked member: one line for all of them, with Unlock to read', () => {
    act(() => root.render(<MembersOnlySummary entries={[entry('comment', 'alice'), entry('comment', 'bob'), entry('review', 'bob')]} lane={{ access: 'locked' } as MembersAccess} />))
    expect(q('members-only-locked')?.textContent).toContain('3 members-only comments')
    act(() => q('members-only-unlock')!.click())
    expect(q('members-only-unlock-panel')?.textContent).toBe('Unlock to read members-only content')
  })

  it('the "#N · members-only" page, never "not found"', () => {
    const target: MembersOnlyTarget = { placeholder: { ...entry('comment', 'alice').item, type: 'issue', number: 3 }, number: 3, open: true, merged: false, comments: 4 }
    act(() => root.render(<MembersOnlyTargetPage home={homeWith()} target={target} />))
    const page = q('members-only-target')!
    expect(page.querySelector('h1')?.textContent).toBe('#3 · members-only')
    expect(page.textContent).toContain('Members-only issue')
    expect(page.textContent).toContain('open')
    expect(page.textContent).toContain('4 comments')
    expect(page.textContent).toContain('Only members of this repo can read this issue.')
    expect(page.textContent).not.toMatch(/not found/i)
  })
})

describe('the hidden-items note of a public repo', () => {
  const by = (over: Partial<HiddenCounts>): HiddenCounts => ({ notEncrypted: 0, wrongKey: 0, late: 0, lateEdit: 0, membersOnly: 0, letter: 0, ...over })

  it('calls encrypted items nobody proved a member wrote "private messages from people outside this repo"', () => {
    act(() => root.render(<HiddenNote hidden={3} what="comment" home={homeWith()} by={by({ membersOnly: 3 })} shown={1} />))
    expect(q('hidden-note')?.textContent).toBe("2 private messages from people outside this repo aren't shown.")
    expect(host.textContent).not.toContain('encrypted by someone who is not a member')
  })

  it('says nothing when every hidden item is shown as a placeholder', () => {
    act(() => root.render(<HiddenNote hidden={2} what="comment" home={homeWith()} by={by({ membersOnly: 2 })} shown={2} />))
    expect(q('hidden-note')).toBeNull()
  })

  it('names other unreadable items plainly', () => {
    act(() => root.render(<HiddenNote hidden={1} what="issue" home={homeWith()} by={by({ notEncrypted: 1 })} />))
    expect(q('hidden-note')?.textContent).toBe("1 issue isn't shown: not readable in this repo.")
  })
})

describe('after a create whose members-only step failed', () => {
  it('says so and offers Turn on while it is still off, to its owner only; nothing otherwise', async () => {
    params = { membersOnly: 'failed' }
    // someone else's repo (a shared link): no notice
    act(() => root.render(<MembersOnlyCreateNotice home={homeWith({ access: 'none' })} />))
    expect(q('members-only-create-notice')).toBeNull()
    const mine = (lane: MembersAccess): RepoHome => ({ repo: { ...repo, ownerId: 'me' }, lane }) as unknown as RepoHome
    act(() => root.render(<MembersOnlyCreateNotice home={mine({ access: 'none' })} />))
    expect(q('members-only-create-notice')?.textContent).toBe("Your repo is created. Members-only content isn't set up yet.Finish setting up")
    act(() => q('create-notice-turn-on')!.click())
    await flush()
    expect(q('confirm')?.textContent).toContain('Turn on members-only content?')
    // on by now (another tab turned it on): no notice
    act(() => root.render(<MembersOnlyCreateNotice home={mine({ access: 'no-key' })} />))
    expect(q('members-only-create-notice')).toBeNull()
    // no failure reported: no notice
    params = {}
    act(() => root.render(<MembersOnlyCreateNotice home={mine({ access: 'none' })} />))
    expect(q('members-only-create-notice')).toBeNull()
  })
})
