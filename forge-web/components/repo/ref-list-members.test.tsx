// @vitest-environment jsdom
/**
 * The branches list of a public repo with members-only branches (mixed-visibility DESIGN §10
 * "Branches"): a member's two groups, "Public" and "Members only", with no branch administration on
 * a members-only row; an outsider's one line and never a number; a locked member's unlock.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/link', async () => {
  const { forwardRef } = await import('react')
  return { default: forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>((props, ref) => <a ref={ref} {...props} />) }
})

/** The repo each useBrowse call was given (null: no browse index read). */
const browseCalls: unknown[] = []
/** tip → the commit the fake peel answers. */
const peelTo = new Map<string, string>()
/** What the published index says: ready, or not indexed (no reader will come). */
const indexed = true
vi.mock('@/hooks/use-browse', () => ({
  useBrowse: (repo: unknown) => {
    browseCalls.push(repo)
    if (repo === null) return { data: null, error: null }
    return { data: indexed ? { kind: 'ready', context: { reader: READER } } : { kind: 'unindexed' }, error: null }
  },
}))
vi.mock('@/hooks/use-trust-view', () => ({ useTrustView: () => 'tags' }))
/** tip → the date (ms) the fake tip read answers; missing: the read fails. */
const dateOf = new Map<string, number>()
vi.mock('@/lib/view/tip', () => ({
  peekDeclared: () => undefined,
  peelCached: async (_r: unknown, tip: string) => ({ oid: peelTo.get(tip) ?? tip, type: 'commit' }),
  tipDateCached: async (_r: unknown, tip: string) => {
    const ms = dateOf.get(tip)
    if (ms === undefined) throw new Error('unreadable')
    return ms
  },
}))
/** The viewer's role on the repo (branch administration, P1-4). */
let role: string | null = null
vi.mock('@/hooks/use-repo-chrome', () => ({ useViewerRole: () => ({ role, known: true }) }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, network: 'devnet', ready: true }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signer: { identityId: 'M', network: 'devnet' } }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/components/repo/private-compose', () => ({ privateComposeBlock: () => null }))
const READER: Record<string, unknown> = {
  forView: () => READER,
  forHistoryWalk: () => READER,
  readObject: async () => ({ type: 'commit', bytes: new Uint8Array() }),
}

import type { RepoHome } from '@/lib/view'
import { RefListContent } from './ref-list-content'


const MAIN = '1'.repeat(40)
const FIX = '2'.repeat(40)

const ref = (refName: string, oid: string, audience?: 'members') => ({ refName, refNameHash: 'x', state: { state: 'resolved', oid, author: 'id', createdAt: 1 }, ...(audience ? { audience } : {}) })

function home(extra: Partial<RepoHome> & { readonly members?: boolean }): RepoHome {
  const { members, ...rest } = extra
  return {
    repo: { repoId: 'r', visibility: 'public', forge: { core: 'c', collab: 'l', community: 'm' } },
    config: { protectedPatterns: [] },
    defaultBranch: 'main',
    branches: [ref('refs/heads/main', MAIN), ...(members === true ? [ref('refs/heads/sec/fix', FIX, 'members')] : [])],
    tags: [],
    ...rest,
  } as unknown as RepoHome
}

const addr = { owner: 'o', name: 'n' }
let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  role = 'writer'
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

const q = (id: string): HTMLElement | null => el.querySelector(`[data-testid="${id}"]`)

describe('members-only branches on the branches page', () => {
  it('an outsider sees the public branches and one line, never a name or a number', async () => {
    await act(async () => root.render(<RefListContent home={home({ membersOnlyRefs: true })} addr={addr} kind="branches" />))
    expect(q('members-only-refs-note')?.textContent).toBe('This repo also has members-only branches.')
    expect(q('refs-group-members')).toBeNull()
    expect(q('refs-group-public')).toBeNull()
    expect(el.textContent).not.toMatch(/sec\/fix/)
    expect(q('members-only-refs-note')?.textContent).not.toMatch(/\d/)
  })

  it('a member sees "Public" and "Members only", the members-only row without delete, and Publish…', async () => {
    const session = { members: [{ identity: 'o', role: 'maintainer' }, { identity: 'w', role: 'writer' }, { identity: 'b', role: 'bot' }] }
    await act(async () => root.render(<RefListContent home={home({ members: true, membersOnlyRefs: true, lane: { access: 'member', session } as unknown as RepoHome['lane'] })} addr={addr} kind="branches" />))
    expect(q('refs-group-public')?.textContent).toBe('Public')
    const group = q('refs-group-members')
    expect(group?.textContent).toContain('Members only')
    expect(group?.textContent).toContain('Visible to 2 members.')
    const row = el.querySelector('[data-testid="members-ref-row"][data-ref="sec/fix"]')
    expect(row).not.toBeNull()
    expect(row?.querySelector('[data-testid="members-ref-publish"]')?.getAttribute('href')).toContain('head=sec%2Ffix')
    // no branch administration on a members-only row (the web writes no members-only ref)
    expect(row?.textContent).not.toMatch(/Delete/)
    expect(q('members-only-refs-note')).toBeNull()
  })

  it('a member whose tab is locked is offered the unlock', async () => {
    await act(async () => root.render(<RefListContent home={home({ membersOnlyRefs: true, lane: { access: 'locked' } })} addr={addr} kind="branches" />))
    expect(q('members-only-refs-note')?.textContent).toContain('This repo also has members-only branches.')
    expect(q('members-refs-unlock')?.textContent).toBe('Unlock to see them')
  })
})
