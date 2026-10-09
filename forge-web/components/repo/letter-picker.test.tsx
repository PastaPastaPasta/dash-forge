// @vitest-environment jsdom
/**
 * The picker's specific-people options as people use them (DESIGN §10; stream 2A): the role
 * groups with their sizes, a group over 16 disabled with its size, the people picker greying out
 * someone who can't receive messages yet, a thread's people re-listed (leaving one out refused),
 * and a placeholder that says how many people a message went to.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoHome, MembersOnlyEntry } from '@/lib/view'
import type { MembersAccess } from '@/lib/view/repo-view'
import type { Membership } from '@/lib/rules/v2'

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: 'me', unlockScope: 'full' }) }))
vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span>@{identityId}</span> }))
vi.mock('@/components/auth/unlock-more', () => ({
  UNLOCK_MEMBERS_ONLY: 'Unlock to read members-only content',
  UnlockMore: ({ title, testId }: { title: string; testId: string }) => <div data-testid={testId}>{title}</div>,
}))
vi.mock('@/hooks/use-private-write', () => ({ usePrivateWrite: () => ({ context: null, done: () => undefined }) }))
/** Who has no usable encryption key. */
let keyless = new Set<string>()
vi.mock('@/lib/auth/encryption-key', () => ({
  encryptionKeyState: async () => 'open',
  fetchIdentityKeys: async (_sdk: unknown, id: string) => (keyless.has(id) ? [] : [{ keyId: 1 }]),
  usableEncryptionKey: (keys: readonly unknown[]) => keys[0] ?? null,
}))
vi.mock('@/lib/view/dpns', () => ({
  cachedDpnsName: () => undefined,
  looksLikeDpnsName: () => true,
  resolveDpnsId: async (_sdk: unknown, name: string) => name.replace(/\.dash$/, ''),
  resolveDpnsNames: async (_sdk: unknown, ids: readonly string[]) => new Map(ids.map((i) => [i, `${i}.dash`])),
}))
vi.mock('@/lib/repo/checks', () => ({ readRunners: async () => [] }))
vi.mock('@/hooks/use-query-param', () => ({ useParam: () => '' }))
let members: Membership[] = []
vi.mock('@/lib/repo', async (orig) => ({
  ...(await orig<typeof import('@/lib/repo')>()),
  repoContractIds: () => [],
  readMembershipsCached: async () => members,
}))

import { AudienceChip, MembersOnlyRow, useAudienceWarnings, useComposerAudience, type LetterThreadContext } from './audience'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const m = (identity: string, role: Membership['role']): Membership => ({ identity, role, createdAt: 0 })
const repo = { forge: { core: 'C', collab: 'C', community: 'C', group: 'G' }, repoId: 'R', ownerId: 'alice', name: 'demo', visibility: 'public' } as const
const home = { repo, lane: { access: 'member' } as MembersAccess } as unknown as RepoHome

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  members = [m('alice', 'maintainer'), m('carol', 'maintainer'), m('bob', 'writer'), m('me', 'writer'), m('rae', 'reader')]
  keyless = new Set()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const q = (id: string): HTMLElement | null => host.querySelector(`[data-testid="${id}"]`)
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

function Composer({ thread }: { thread?: LetterThreadContext }): JSX.Element {
  const state = useComposerAudience(home, { members, ...(thread ? { thread } : {}) })
  const warnings = useAudienceWarnings(state, '', null)
  return (
    <>
      <AudienceChip home={home} state={state} />
      <span data-testid="audience">{state.audience}</span>
      <span data-testid="blocked">{state.blocked ?? ''}</span>
      <span data-testid="warnings">{warnings.join(' | ')}</span>
    </>
  )
}

const radio = (value: string): HTMLInputElement => q(`audience-option-${value}`)?.querySelector('input') as HTMLInputElement

describe('the role groups', () => {
  it('offers Maintainers and Writers and maintainers with their people now, and sends to one', async () => {
    act(() => root.render(<Composer />))
    await flush()
    act(() => (q('audience-chip') as HTMLButtonElement).click())
    await flush()
    const picker = q('audience-picker') as HTMLElement
    // the owner (a maintainer too) and the maintainers; then the writers too (never the reader)
    expect(q('audience-option-maintainers')?.textContent).toContain('Maintainers (2)')
    expect(q('audience-option-maintainers')?.textContent).toContain('Sent to the 2 current maintainers.')
    expect(q('audience-option-writers')?.textContent).toContain('Writers and maintainers (4)')
    expect(picker.textContent).toContain('Specific people…')
    act(() => radio('maintainers').click())
    await flush()
    expect(q('audience')?.textContent).toBe('specificPeople')
    expect(q('audience-chip')?.textContent).toContain('Maintainers (2)')
    expect(q('blocked')?.textContent).toBe('')
  })

  it('disables a group over 16 and says how big it is', async () => {
    members = [...members, ...Array.from({ length: 20 }, (_, i) => m(`w${i}`, 'writer'))]
    act(() => root.render(<Composer />))
    await flush()
    act(() => (q('audience-chip') as HTMLButtonElement).click())
    await flush()
    expect(radio('writers').disabled).toBe(true)
    expect(q('audience-option-writers')?.textContent).toContain('Writers and maintainers is 24 people. A message can go to at most 16. Choose All members or pick people.')
    expect(radio('maintainers').disabled).toBe(false)
  })
})

describe('the people picker', () => {
  it('adds people by name, greys out who can’t receive messages yet, and keeps the writer', async () => {
    keyless = new Set(['dana'])
    act(() => root.render(<Composer />))
    await flush()
    act(() => (q('audience-chip') as HTMLButtonElement).click())
    await flush()
    act(() => radio('people').click())
    await flush()
    expect(q('people-picker-you')?.textContent).toContain('(you)')
    // nobody named yet: refused, and said so
    expect(q('blocked')?.textContent).toBe('Choose who to send it to.')
    const input = q('people-picker-input') as HTMLInputElement
    const type = async (text: string): Promise<void> => {
      act(() => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        set.call(input, text)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      act(() => (q('people-picker-add') as HTMLButtonElement).click())
      await flush()
    }
    await type('@dana')
    expect(q('people-picker-no-key')?.textContent).toBe("dana · can't receive members-only messages yet")
    expect(host.querySelectorAll('[data-testid="people-picker-person"]')).toHaveLength(0)
    await type('@bob')
    expect([...host.querySelectorAll('[data-testid="people-picker-person"]')].map((e) => e.getAttribute('data-id'))).toEqual(['bob'])
    expect(q('blocked')?.textContent).toBe('')
    expect(q('audience-chip')?.textContent).toContain('bob and you')
  })
})

describe('a thread of messages to specific people', () => {
  it('offers only Specific people, re-lists its people, says who reads from now on, and refuses leaving one out', async () => {
    act(() => root.render(<Composer thread={{ parents: [{ recipients: ['alice', 'me', 'bob'], group: null }] }} />))
    await flush()
    expect(q('audience')?.textContent).toBe('specificPeople')
    act(() => (q('audience-chip') as HTMLButtonElement).click())
    await flush()
    expect(q('audience-option-public')).toBeNull()
    expect(q('audience-option-members')).toBeNull()
    expect(q('audience-option-maintainers')).toBeNull()
    expect([...host.querySelectorAll('[data-testid="people-picker-person"]')].map((e) => e.getAttribute('data-id'))).toEqual(['alice', 'bob'])
    // leaving bob out is refused
    act(() => (host.querySelector('[aria-label="Remove bob"]') as HTMLButtonElement).click())
    await flush()
    expect(q('blocked')?.textContent).toBe("Replies can't leave out people who could read earlier messages: @bob.")
  })

  it('says only its recipients can reply to one this viewer cannot read', async () => {
    act(() => root.render(<Composer thread={{ parents: [], unreadable: true }} />))
    await flush()
    expect(q('blocked')?.textContent).toBe('Only the people this was sent to can reply.')
  })
})

describe('a placeholder', () => {
  it('says how many people a message went to, and offers an unlock while this tab is locked', () => {
    const entry: MembersOnlyEntry = { item: { type: 'comment', id: 'x', author: 'dana', createdAt: Date.now(), asMember: true, number: null, replyTo: null, audience: 'specificPeople', why: 'letter', recipientCount: 3, locked: true } }
    act(() => root.render(<MembersOnlyRow entry={entry} />))
    const row = q('members-only-placeholder') as HTMLElement
    expect(row.textContent).toContain('Comment to 3 people · @dana')
    expect(row.getAttribute('data-recipients')).toBe('3')
    act(() => (q('letter-unlock') as HTMLButtonElement).click())
    expect(q('letter-unlock-panel')).not.toBeNull()
  })
})
