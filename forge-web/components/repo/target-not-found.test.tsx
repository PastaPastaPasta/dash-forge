// @vitest-environment jsdom
/**
 * QW-063: an issue URL for a PR's number (and the reverse) opens the PR, as GitHub redirects
 * `/issues/N` to `/pull/N`; only a number neither holds says "not found".
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CircleDot, GitPullRequest } from 'lucide-react'

import type { RepoHome } from '@/lib/view'

const replaced: string[] = []
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: (u: string) => void replaced.push(u), push: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet', status: { phase: 'ready' } }) }))
let held: { issue: boolean; pull: boolean } = { issue: false, pull: false }
vi.mock('@/lib/view/jump', async (orig) => ({
  ...(await orig<typeof import('@/lib/view/jump')>()),
  numberTargets: async () => held,
}))

const { TargetNotFound } = await import('./number-content')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HOME = { repo: { repoId: 'r', forge: { core: 'C', collab: 'L', community: 'M', group: 'G' }, ownerId: 'o', name: 'n', visibility: 'public' }, description: '' } as unknown as RepoHome
const addr = { owner: 'o', name: 'n' }

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  replaced.length = 0
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

const render = async (kind: 'issue' | 'pull'): Promise<void> => {
  await act(async () =>
    root.render(<TargetNotFound home={HOME} addr={addr} number={2} kind={kind} icon={kind === 'issue' ? CircleDot : GitPullRequest} title="not found" body="nothing at 2" />),
  )
  await act(async () => undefined)
}

describe('TargetNotFound (QW-063)', () => {
  it('opens the PR when an issue URL names a PR number', async () => {
    held = { issue: false, pull: true }
    await render('issue')
    expect(replaced).toEqual(['/repo/pull/?owner=o&name=n&number=2'])
    expect(el.textContent).toContain('is a pull request; opening it')
  })

  it('opens the issue when a PR URL names an issue number', async () => {
    held = { issue: true, pull: false }
    await render('pull')
    expect(replaced).toEqual(['/repo/issue/?owner=o&name=n&number=2'])
  })

  it('says not found only when neither holds the number', async () => {
    held = { issue: false, pull: false }
    await render('issue')
    expect(replaced).toEqual([])
    expect(el.textContent).toContain('not found')
    expect(el.textContent).toContain('nothing at 2')
  })
})
