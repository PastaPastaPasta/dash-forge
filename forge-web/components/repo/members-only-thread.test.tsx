// @vitest-environment jsdom
/**
 * The page of a thread this reader cannot open, with what it can read of the conversation (DESIGN
 * §4.10 L3, D14): the public replies in the timeline's style, members-only ones as placeholders;
 * and, only on a members-only thread written while a repo made public since was private, a
 * composer for a public reply ("Public" only, said so under it). Not on a thread written since, one
 * to specific people, or in a private repo; a locked thread takes a reply from members alone.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MembersOnlyTarget, RepoHome } from '@/lib/view'
import type { MembersOnlyItem } from '@/lib/repo/private-content'

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))
vi.mock('@/hooks/use-dpns-name', () => ({ useDpnsName: () => undefined }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
const auth = vi.hoisted(() => ({ identity: 'me' as string | null, locked: false }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: auth.identity, signer: auth.identity === null ? null : { identityId: auth.identity }, locked: auth.locked, unlockScope: 'full' }) }))
vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span>@{identityId}</span> }))
vi.mock('@/components/auth/unlock-more', () => ({
  UNLOCK_MEMBERS_ONLY: 'Unlock to read members-only content',
  UNLOCK_LETTERS: 'Unlock to read messages sent to you',
  UnlockMore: ({ title, testId }: { title: string; testId: string }) => <div data-testid={testId}>{title}</div>,
}))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/lib/repo/bans', () => ({ readBans: async () => [], readStandingBans: async () => new Map() }))
const writes = vi.hoisted(() => ({ member: false, posted: [] as unknown[] }))
vi.mock('@/lib/repo', async (orig) => ({
  ...(await orig<typeof import('@/lib/repo')>()),
  repoContractIds: () => [],
  readViewerPermissions: async () => (writes.member ? { member: true, maintain: false, role: 'writer' } : { member: false, maintain: false, role: null }),
  commentFirsts: async () => ({}),
  createComment: async (_sdk: unknown, _signer: unknown, _repo: unknown, input: unknown) => {
    writes.posted.push(input)
    return { documentId: 'NEWREPLY' }
  },
}))

import { MembersOnlyThread } from './members-only-thread'
import { mergeTimeline, toCommentView } from '@/lib/view/issues-view'
import { publicReplyOffered, whilePrivateNote } from '@/lib/view/audience'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const repo = { forge: { core: 'C', collab: 'C', community: 'C', group: 'G' }, repoId: 'R', ownerId: 'alice', name: 'demo', visibility: 'public' } as const
const homeWith = (visibility: 'public' | 'private' = 'public', over: Partial<RepoHome> = {}): RepoHome => ({ repo: { ...repo, visibility }, description: '', ...over }) as unknown as RepoHome

const item = (over: Partial<MembersOnlyItem> = {}): MembersOnlyItem => ({
  type: 'issue',
  id: 'THREAD',
  author: 'carol',
  createdAt: 1_000,
  asMember: true,
  number: 4,
  replyTo: null,
  audience: 'members',
  why: 'noKey',
  ...over,
})

const reply = toCommentView({ $id: 'PUB1', $ownerId: 'bob', $createdAt: 2_000, targetId: 'THREAD', body: 'P5B-WEB-PUBLIC-REPLY by the maintainer' })
const target = (over: Partial<MembersOnlyTarget> = {}): MembersOnlyTarget => ({
  placeholder: item(),
  number: 4,
  open: true,
  merged: false,
  comments: 2,
  timeline: mergeTimeline([reply], [], [], [], true),
  membersOnly: [{ item: item({ type: 'comment', id: 'MEM1', author: 'dave', createdAt: 3_000, number: null }) }],
  locked: false,
  writtenWhilePrivate: true,
  ...over,
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  auth.identity = 'me'
  auth.locked = false
  writes.member = false
  writes.posted = []
  localStorage.clear()
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
const render = async (t: MembersOnlyTarget, home = homeWith(), onPosted: (id: string) => void = () => undefined): Promise<void> => {
  act(() => root.render(<MembersOnlyThread home={home} target={t} onPosted={onPosted} />))
  await flush()
}
const type = (text: string): void => {
  const area = host.querySelector('textarea#comment-body') as HTMLTextAreaElement
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(area, text)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the members-only page lists the replies this reader can read', () => {
  it('shows the public replies in the timeline and the members-only ones as placeholders, under the page', async () => {
    auth.identity = null
    await render(target())
    const page = q('members-only-target')!
    const replies = page.querySelector('[data-testid="members-only-replies"]')!
    expect(replies.textContent).toContain('P5B-WEB-PUBLIC-REPLY by the maintainer')
    expect(replies.textContent).toContain('@bob')
    const placeholder = replies.querySelector('[data-testid="members-only-placeholder"]')!
    expect(placeholder.textContent).toContain('Members-only comment')
    expect(placeholder.textContent).toContain('@dave')
    // the page's own facts stay
    expect(q('members-only-comments')?.textContent).toBe(' · 2 comments')
    // signed out: no composer
    expect(q('members-only-reply-composer')).toBeNull()
  })

  it('shows nothing more for a thread with no replies', async () => {
    await render(target({ timeline: [], membersOnly: [], comments: 0, writtenWhilePrivate: undefined }))
    expect(q('members-only-replies')).toBeNull()
    expect(q('members-only-reply-composer')).toBeNull()
  })
})

describe('a public reply to a thread written while the repo was private', () => {
  it('is offered to a signed-in reader who cannot open it: Public only, said so, written as a public comment', async () => {
    const onPosted = vi.fn()
    await render(target(), homeWith(), onPosted)
    const composer = q('members-only-reply-composer')!
    expect(composer).not.toBeNull()
    expect(q('while-private-note')?.textContent).toBe(whilePrivateNote(false))
    // no audience picker: the reply is public
    expect(q('audience-chip')).toBeNull()
    type('a public answer')
    await act(async () => {
      ;(q('members-only-reply-post') as HTMLButtonElement).click()
    })
    await flush()
    expect(writes.posted).toEqual([expect.objectContaining({ targetId: 'THREAD', body: 'a public answer', audience: 'public', post: { isMember: false, locked: false } })])
    expect(onPosted).toHaveBeenCalledWith('NEWREPLY')
  })

  it('is offered on a PR written while private too', async () => {
    await render(target({ placeholder: item({ type: 'patch', number: 5 }), number: 5 }))
    expect(q('members-only-target')?.getAttribute('data-kind')).toBe('pull')
    expect(q('members-only-reply-composer')).not.toBeNull()
  })

  it('is not offered on a members-only thread written since the conversion', async () => {
    await render(target({ writtenWhilePrivate: undefined }))
    expect(q('members-only-replies')).not.toBeNull()
    expect(q('members-only-reply-composer')).toBeNull()
  })

  it('is not offered on a thread to specific people, nor in a private repo', async () => {
    await render(target({ placeholder: item({ audience: 'specificPeople', why: 'letter' }) }))
    expect(q('members-only-reply-composer')).toBeNull()
    await render(target(), homeWith('private'))
    expect(q('members-only-reply-composer')).toBeNull()
  })

  it('follows the lock: a non-member sees the locked banner and no Comment, a member may still reply', async () => {
    await render(target({ locked: true }))
    expect(q('locked-banner')?.getAttribute('data-viewer')).toBe('outsider')
    expect(q('members-only-reply-post')).toBeNull()
    writes.member = true
    act(() => root.unmount())
    root = createRoot(host)
    await render(target({ locked: true }))
    expect(q('locked-banner')?.getAttribute('data-viewer')).toBe('member')
    expect(q('members-only-reply-post')).not.toBeNull()
  })
})

describe('a member who may yet read the thread is not offered the Public-only composer', () => {
  it.each(['locked', 'no-key', 'no-key-shared'] as const)('not while their access is %s', async (access) => {
    await render(target(), homeWith('public', { lane: { access } as RepoHome['lane'] }))
    expect(q('members-only-target')).not.toBeNull()
    expect(q('members-only-reply-composer')).toBeNull()
  })

  it('not while their key session is still loading', async () => {
    await render(target(), homeWith('public', { laneLoading: true }))
    expect(q('members-only-reply-composer')).toBeNull()
  })

  it('but to a non-member, a former member, and a member holding no key for that old thread', async () => {
    for (const lane of [undefined, { access: 'none' }, { access: 'former', session: {} }, { access: 'member', session: {} }]) {
      act(() => root.unmount())
      root = createRoot(host)
      await render(target(), homeWith('public', lane === undefined ? {} : { lane: lane as RepoHome['lane'] }))
      expect(q('members-only-reply-composer'), JSON.stringify(lane)).not.toBeNull()
    }
  })
})

describe('the quote check knows the replies this page shows', () => {
  it('asks before a public reply repeats a members-only reply of the page', async () => {
    const SECRET = 'The staging database password rotates on Friday at noon.'
    const secret = { ...reply, id: 'MEM2', audience: 'members' as const, body: SECRET }
    await render(target({ timeline: mergeTimeline([reply, secret], [], [], [], true) }))
    type(`> ${SECRET}\nAgreed.`)
    await act(async () => {
      ;(q('members-only-reply-post') as HTMLButtonElement).click()
    })
    await flush()
    expect(writes.posted).toEqual([])
    expect(document.body.querySelector('[data-testid="quote-confirm"]')).not.toBeNull()
  })
})

describe('publicReplyOffered', () => {
  it('only a public repo’s members-only thread written while it was private', () => {
    const t = { placeholder: { audience: 'members' as const }, writtenWhilePrivate: true as const }
    expect(publicReplyOffered('public', t)).toBe(true)
    expect(publicReplyOffered('private', t)).toBe(false)
    expect(publicReplyOffered('public', { placeholder: { audience: 'members' } })).toBe(false)
    expect(publicReplyOffered('public', { ...t, placeholder: { audience: 'specificPeople' } })).toBe(false)
    // a member who may yet read: loading, or locked / no key / none shared
    expect(publicReplyOffered('public', t, { laneLoading: true })).toBe(false)
    for (const access of ['locked', 'no-key', 'no-key-shared'] as const) expect(publicReplyOffered('public', t, { lane: { access } })).toBe(false)
    for (const lane of [undefined, { access: 'none' as const }, { access: 'bot' as const }]) expect(publicReplyOffered('public', t, { lane })).toBe(true)
  })
})
