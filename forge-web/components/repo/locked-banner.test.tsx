// @vitest-environment jsdom
/**
 * The locked conversation (RC1: a thread whose transition sum is 16 or more takes comments and
 * reviews from members only). Two things are proved here:
 *
 * - the lock bit costs the PR and issue pages nothing: `loadPullThread` / `loadIssueThread` make
 *   exactly the same requests for a locked thread as for an unlocked one (the lock is folded from
 *   the transitions the composite already reads), and the viewer's membership the banner needs is
 *   then answered from the members the composite seeded, with no request;
 * - `LockedBanner`, which both pages wrap their composer in: it shows the banner and keeps the
 *   composer for a member, replaces the composer for anyone else (signed out, a non-member, and
 *   while the membership is read or when it could not be), and shows nothing but the composer
 *   when the thread is not locked.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { base58Encode } from '@/lib/auth/base58'
import type { ForgeIds } from '@/lib/deployments'
import { invalidateMembers, readViewerPermissions, type RepoRef } from '@/lib/repo'
import { mockSdk, newSeen, type Doc, type Seen, type Store } from '@/lib/repo/drive-mock'
import { bytesToBase64, hexToBase64, setPlatformVersion } from '@/lib/sdk'
import { clearDpnsCache } from '@/lib/view/dpns'
import { loadIssueThread, loadPullThread } from '@/lib/view/issues-view'
import { LockToggle, LockedBanner, lockConfirm, lockStateText, lockViewerOf, type LockViewer } from './locked-banner'

const FORGE: ForgeIds = { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY', group: 'GROUP' }
const REPO_ID = 'C8XSf6R4shR1kqFKUZQnuaEZ5DkW7uoe9qtQYZpS5SRd'
const OWNER = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const MAINT = 'Ehyw8VygZh5LjjYHUbKqgyJamgetiVPLFnJewrfmgQUs'
const AUTHOR = '7Ej2YTftCL23mVwvhviak8ZJMmpqcsVj7CU5KPxzyy4h'
const STRANGER = 'BTJPjCLCnRaJQkqakpcdLYFsaHgFf5XSEBNxFCyYBteH'
const MAIN_HASH = bytesToBase64(sha256(new TextEncoder().encode('refs/heads/main')))
const PR = base58Encode(sha256(new TextEncoder().encode('pr1')))
const ISSUE = base58Encode(sha256(new TextEncoder().encode('issue2')))
const repo: RepoRef = { forge: FORGE, repoId: REPO_ID, ownerId: OWNER, name: 'demo', visibility: 'public' }

/** PR #1 and issue #2, each with a comment; `locked`: a maintainer locked both (kinds 18 and 3, delta 16). */
function store(locked: boolean): Store {
  let t = 1_000
  const tr = (targetId: string, number: number, targetKind: number, kind: number): Doc => ({
    $id: `t${t}`,
    $ownerId: MAINT,
    $createdAt: t++,
    repoId: REPO_ID,
    targetId,
    targetNumber: number,
    targetKind,
    kind,
    delta: 16,
    asAuthor: 0,
  })
  return {
    COLLAB: {
      patch: [
        {
          $id: PR,
          $ownerId: AUTHOR,
          $createdAt: 10,
          repoId: REPO_ID,
          number: 1,
          title: 'A PR',
          body: '',
          baseRefName: 'refs/heads/main',
          baseRefNameHash: MAIN_HASH,
          headOid: hexToBase64('ab'.repeat(20)),
          sourceRepoId: REPO_ID,
        },
      ],
      issue: [{ $id: ISSUE, $ownerId: AUTHOR, $createdAt: 11, repoId: REPO_ID, number: 2, title: 'An issue', body: '' }],
      comment: [
        { $id: 'c1', $ownerId: STRANGER, $createdAt: 20, repoId: REPO_ID, targetId: PR, body: 'before the lock' },
        { $id: 'c2', $ownerId: STRANGER, $createdAt: 21, repoId: REPO_ID, targetId: ISSUE, body: 'before the lock' },
      ],
      transition: locked ? [tr(PR, 1, 1, 18), tr(ISSUE, 2, 0, 3)] : [],
    },
    COMMUNITY: { event: [] },
    CORE: {
      maintainer: [
        { $id: 'm1', $ownerId: OWNER, $createdAt: 5, repoId: REPO_ID, memberId: OWNER, role: 'maintainer' },
        { $id: 'm2', $ownerId: OWNER, $createdAt: 5, repoId: REPO_ID, memberId: MAINT, role: 'maintainer' },
      ],
      writer: [],
      config: [{ $id: 'cfg', $ownerId: OWNER, $createdAt: 5, repoId: REPO_ID, defaultBranch: 'main', protectedPatterns: [] }],
      refUpdate: [],
      protectedRefUpdate: [],
    },
  }
}

const requests = (seen: Seen): number => seen.composites.length + seen.queries.length + seen.counts.length + seen.sums.length
/** Every request, reduced to what it asked (contract and type), by kind, each kind in the order sent. */
const asked = (seen: Seen): string[] => [
  ...seen.composites.map((c) => `composite ${c.dataContractId}.${c.documentType} [${c.subQueries.map((s) => s.documentType).join(',')}]`),
  ...seen.queries.map((q) => `query ${q.dataContractId}.${q.documentTypeName}`),
  ...seen.counts.map((q) => `count ${q.dataContractId}.${q.documentTypeName}`),
  ...seen.sums.map((q) => `sum ${q.dataContractId}.${q.documentTypeName}`),
]

beforeAll(() => setPlatformVersion(14))

describe('the lock bit is in the thread read (no request of its own)', () => {
  it("the PR page's load: the same requests locked as unlocked, one composite, and the banner's membership from its seed", async () => {
    const runs: { seen: Seen; locked: boolean | undefined }[] = []
    for (const locked of [false, true]) {
      // Each run from cold caches (members, names), as a first page view.
      invalidateMembers(repo, 'devnet')
      clearDpnsCache()
      const seen = newSeen()
      const sdk = mockSdk(store(locked), seen)
      const thread = await loadPullThread(sdk, repo, 1, 'devnet')
      runs.push({ seen, locked: thread?.locked })
      // The viewer's role (member or not: the banner's two texts) comes from the members the
      // composite seeded: no request.
      const before = requests(seen)
      expect(await readViewerPermissions(sdk, repo, STRANGER, 'devnet')).toEqual({ member: false, maintain: false, role: null })
      expect(await readViewerPermissions(sdk, repo, MAINT, 'devnet')).toEqual({ member: true, maintain: true, role: 'maintainer' })
      expect(requests(seen)).toBe(before)
    }
    const [open, locked] = runs as [(typeof runs)[0], (typeof runs)[0]]
    expect(open.locked).toBe(false)
    expect(locked.locked).toBe(true)
    // One composite carries the transitions; no sum or count reads the lock separately.
    expect(locked.seen.composites).toHaveLength(1)
    expect(locked.seen.composites[0]?.subQueries.some((s) => s.documentType === 'transition')).toBe(true)
    expect(locked.seen.sums).toHaveLength(0)
    // The one count is the merge box's proved verdict count (`review.verdicts`), not the lock.
    expect(locked.seen.counts.map((q) => q.documentTypeName)).toEqual(['review'])
    expect(locked.seen.queries.filter((q) => q.documentTypeName === 'transition')).toHaveLength(0)
    expect(asked(locked.seen)).toEqual(asked(open.seen))
    // The page's whole budget: the composite, the names (one DPNS read), the base ref's history
    // and config, and the verdict count. Not the repo's bans: the page reads them beside the thread.
    expect(requests(locked.seen)).toBe(6)
    expect(requests(open.seen)).toBe(6)
    expect(open.seen.queries.some((q) => q.documentTypeName === 'ban')).toBe(false)
  })

  it("the issue page's load: the same requests locked as unlocked", async () => {
    const runs: { seen: Seen; locked: boolean | undefined }[] = []
    for (const locked of [false, true]) {
      // Each run from cold caches (members, names), as a first page view.
      invalidateMembers(repo, 'devnet')
      clearDpnsCache()
      const seen = newSeen()
      const thread = await loadIssueThread(mockSdk(store(locked), seen), repo, 2, 'devnet')
      runs.push({ seen, locked: thread?.meta.locked })
    }
    const [open, locked] = runs as [(typeof runs)[0], (typeof runs)[0]]
    expect([open.locked, locked.locked]).toEqual([false, true])
    expect(locked.seen.queries.filter((q) => q.documentTypeName === 'transition')).toHaveLength(0)
    expect(asked(locked.seen)).toEqual(asked(open.seen))
    // The repo's bans are the page's own read, beside the thread: the issue never waits on them.
    expect(open.seen.queries.some((q) => q.documentTypeName === 'ban')).toBe(false)
  })
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** The composer both pages pass as the banner's children. */
const composerEl = <textarea aria-label="Comment" data-testid="composer" />

function render(locked: boolean, viewer: LockViewer, target: 'issue' | 'pull' = 'pull'): { banner: HTMLElement | null; composer: HTMLElement | null } {
  act(() => root.render(<LockedBanner locked={locked} viewer={viewer} target={target}>{composerEl}</LockedBanner>))
  return { banner: host.querySelector('[data-testid="locked-banner"]'), composer: host.querySelector('[data-testid="composer"]') }
}

describe('LockedBanner', () => {
  it('a non-member on a locked thread: the banner replaces the composer', () => {
    const { banner, composer } = render(true, 'outsider')
    expect(banner?.textContent).toMatch(/This conversation has been locked and limited to collaborators\./)
    expect(banner?.textContent).toMatch(/Only this repo's members can comment or review/)
    expect(composer).toBeNull()
    // An issue takes no reviews: the note says so.
    expect(render(true, 'outsider', 'issue').banner?.textContent).toMatch(/Only this repo's members can comment;/)
  })

  it('signed out, still checking, or a membership that could not be read: the banner, no composer', () => {
    for (const [viewer, says] of [
      ['signedOut', /Sign in as a member of this repo/],
      ['checking', /Checking whether/],
      ['unknown', /Couldn't check/],
    ] as const) {
      const { banner, composer } = render(true, viewer)
      expect(banner?.textContent).toMatch(says)
      expect(composer).toBeNull()
    }
  })

  it('a member on a locked thread: the banner says they can still comment, and the composer stays', () => {
    const { banner, composer } = render(true, 'member')
    expect(banner?.textContent).toMatch(/You can still comment because you're a member of this repo/)
    expect(composer).not.toBeNull()
  })

  it('an unlocked thread: no banner, the composer for anyone', () => {
    for (const viewer of ['member', 'outsider', 'signedOut', 'checking', 'unknown'] as const) {
      const { banner, composer } = render(false, viewer)
      expect(banner).toBeNull()
      expect(composer).not.toBeNull()
    }
  })
})

describe('LockToggle (the rail button of both pages)', () => {
  const clicked: boolean[] = []
  const toggle = (locked: boolean): HTMLButtonElement => {
    act(() => root.render(<LockToggle locked={locked} onToggle={(lock) => clicked.push(lock)} />))
    return host.querySelector('[data-testid="lock-toggle"]') as HTMLButtonElement
  }

  it('offers the other state and asks for it on click', () => {
    clicked.length = 0
    const lock = toggle(false)
    expect(lock.textContent).toBe('Lock conversation')
    act(() => lock.click())
    const unlock = toggle(true)
    expect(unlock.textContent).toBe('Unlock conversation')
    act(() => unlock.click())
    expect(clicked).toEqual([true, false])
  })

  it('confirms with the target\'s own words', () => {
    expect(lockConfirm(true, 'PR #5', 'pull')).toMatchObject({ title: 'Lock conversation on PR #5', label: 'Sign & lock' })
    expect(lockConfirm(true, 'PR #5', 'pull').description).toMatch(/refuses comments and reviews from anyone/)
    // Triage locks and unlocks too (QW4-032): the dialog names every role that can.
    expect(lockConfirm(true, 'PR #5', 'pull').description).toMatch(/not a member of this repo. Any of its maintainers, writers and triage members can unlock it./)
    expect(lockConfirm(false, 'issue #3', 'issue')).toEqual({ title: 'Unlock conversation on issue #3', description: 'Records an unlock: everyone can comment again.', label: 'Sign & unlock' })
    expect(lockStateText(true)).toBe('Locked to members')
  })
})

describe('lockViewerOf', () => {
  it("reads the page's membership read: signed out, loading, failed, a role or none", () => {
    expect(lockViewerOf(null, { settled: false, data: null })).toBe('signedOut')
    expect(lockViewerOf(MAINT, { settled: false, data: null })).toBe('checking')
    expect(lockViewerOf(MAINT, { settled: true, data: null })).toBe('unknown')
    expect(lockViewerOf(MAINT, { settled: true, data: { member: true, maintain: false, role: 'writer' } })).toBe('member')
    expect(lockViewerOf(MAINT, { settled: true, data: { member: true, maintain: false, role: 'reader' } })).toBe('member')
    expect(lockViewerOf(STRANGER, { settled: true, data: { member: false, maintain: false, role: null } })).toBe('outsider')
  })
})
