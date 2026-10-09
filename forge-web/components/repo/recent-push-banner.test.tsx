// @vitest-environment jsdom
/**
 * #451: "Compare & pull request" for a branch the viewer pushed in the last hour. It reads nothing
 * without such a branch, shows only once the covering-PR check answers, links to the New pull request
 * form with the branch as the head (a fork's to its parent's), and a dismissal holds per tip.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoHome } from '@/lib/view'

const ME = 'MeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMe11'
const PARENT = { forge: { core: 'C', collab: 'L', community: 'M' }, repoId: 'PARENTID', ownerId: 'PO', name: 'proj', visibility: 'public' }

const s = vi.hoisted(() => ({
  identity: null as string | null,
  parent: null as unknown,
  asked: [] as string[][],
  open: new Set<string>() as ReadonlySet<string> | null,
  answer: null as Promise<void> | null,
}))
vi.mock('next/link', () => ({ default: (props: React.ComponentProps<'a'>) => <a {...props} /> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, network: 'devnet', ready: true }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: s.identity }) }))
vi.mock('@/hooks/use-repo-chrome', () => ({ useRepoWriteGeneration: () => 0 }))
vi.mock('@/components/repo/fork-contribute', async (orig) => ({ ...(await orig<typeof import('@/components/repo/fork-contribute')>()), useForkParent: () => s.parent }))
vi.mock('@/lib/repo', async (orig) => ({
  ...(await orig<typeof import('@/lib/repo')>()),
  coveredPushes: async (_sdk: unknown, _repo: unknown, pushes: { refName: string }[]) => {
    s.asked.push(pushes.map((p) => p.refName))
    if (s.answer) await s.answer
    return s.open
  },
}))

import { RecentPushBanner } from './recent-push-banner'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let n = 0
/** A home whose `feature` ME pushed `ago` ms before now; a fresh repo id per test (the answer is session-cached). */
function home({ ago = 5 * 60_000, author = ME, forkOf = null as string | null } = {}): RepoHome {
  n += 1
  return {
    repo: { forge: PARENT.forge, repoId: `REPO${n}`, ownerId: ME, name: 'proj', visibility: 'public' },
    config: null,
    defaultBranch: 'main',
    v2: { forkOf },
    branches: [
      { refName: 'refs/heads/main', refNameHash: 'm', state: { state: 'resolved', oid: 'a'.repeat(40), author: 'X', createdAt: 1 } },
      { refName: 'refs/heads/feature/x', refNameHash: 'f', state: { state: 'resolved', oid: 'b'.repeat(40), author, createdAt: Date.now() - ago } },
    ],
    tags: [],
  } as unknown as RepoHome
}

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  s.identity = ME
  s.parent = null
  s.asked = []
  s.open = new Set()
  s.answer = null
  window.localStorage.clear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) })
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

async function render(h: RepoHome): Promise<void> {
  await act(async () => root.render(<RecentPushBanner home={h} addr={{ owner: 'alice', name: 'proj' }} />))
  await settle()
}

describe('RecentPushBanner', () => {
  it('offers the branch the viewer just pushed, with its age, linking to the form with it as the head', async () => {
    await render(home())
    expect(s.asked).toEqual([['refs/heads/feature/x']])
    expect(q('recent-push-branch')?.textContent).toBe('feature/x')
    expect(q('recent-push')?.textContent).toContain('had recent pushes 5m ago')
    const href = q('recent-push-compare')?.getAttribute('href') ?? ''
    expect(href.startsWith('/repo/pulls/new/?')).toBe(true)
    const params = new URLSearchParams(href.split('?')[1])
    expect([params.get('owner'), params.get('name'), params.get('head')]).toEqual(['alice', 'proj', 'feature/x'])
  })

  it('shows nothing until the covering-PR check answers, and nothing when the branch has an open PR', async () => {
    let release!: () => void
    s.answer = new Promise((r) => (release = r))
    s.open = new Set(['refs/heads/feature/x'])
    await render(home())
    expect(q('recent-pushes')).toBeNull()
    release()
    await settle()
    expect(q('recent-pushes')).toBeNull()
  })

  it('shows nothing when the check cannot tell (null)', async () => {
    s.open = null
    await render(home())
    expect(q('recent-pushes')).toBeNull()
  })

  it('reads nothing for a signed-out viewer, another pusher, or a push over an hour old', async () => {
    s.identity = null
    await render(home())
    await render(home({ author: 'SOMEONE' }))
    s.identity = ME
    await render(home({ ago: 61 * 60_000 }))
    expect(s.asked).toEqual([])
    expect(q('recent-pushes')).toBeNull()
  })

  it("on a fork, opens the parent's form with the fork's branch", async () => {
    s.parent = PARENT
    const h = home({ forkOf: 'PARENTID' })
    await render(h)
    const params = new URLSearchParams((q('recent-push-compare')?.getAttribute('href') ?? '').split('?')[1])
    expect([params.get('owner'), params.get('name'), params.get('head')]).toEqual(['PO', 'proj', `${h.repo.repoId}:feature/x`])
  })

  it('a dismissal hides the banner and holds for that tip, without another read', async () => {
    const h = home()
    await render(h)
    await act(async () => q('recent-push-dismiss')?.click())
    expect(q('recent-pushes')).toBeNull()
    act(() => root.unmount())
    root = createRoot(host)
    await render(h)
    expect(q('recent-pushes')).toBeNull()
    expect(s.asked).toHaveLength(1)
    expect(window.localStorage.getItem('forge.recent-push.dismissed')).toContain(`${h.repo.repoId}:refs/heads/feature/x@${'b'.repeat(40)}`)
  })

  it('dismissing one of two banners leaves the other without another read', async () => {
    const h = home()
    const branches = [...h.branches, { refName: 'refs/heads/second', refNameHash: 's', state: { state: 'resolved', oid: 'c'.repeat(40), author: ME, createdAt: Date.now() - 60_000 } }]
    await render({ ...h, branches } as RepoHome)
    expect(host.querySelectorAll('[data-testid="recent-push"]')).toHaveLength(2)
    await act(async () => q('recent-push-dismiss')?.click())
    await settle()
    expect([...host.querySelectorAll('[data-testid="recent-push-branch"]')].map((e) => e.textContent)).toEqual(['feature/x'])
    expect(s.asked).toEqual([['refs/heads/second', 'refs/heads/feature/x']])
  })
})
