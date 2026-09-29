// @vitest-environment jsdom
/**
 * The tags list's commit chips (L-02): a chip shows the commit its tag names, and a tag that is
 * force-moved to another commit gets a fresh chip rather than the old commit it already showed.
 * The branches list starts no browse index (it has nothing to peel).
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
let indexed = true
vi.mock('@/hooks/use-browse', () => ({
  useBrowse: (repo: unknown) => {
    browseCalls.push(repo)
    if (repo === null) return { data: null, error: null }
    return { data: indexed ? { kind: 'ready', context: { reader: READER } } : { kind: 'unindexed' }, error: null }
  },
}))
vi.mock('@/hooks/use-trust-view', () => ({ useTrustView: () => 'tags' }))
vi.mock('@/lib/view/tip', () => ({
  peekDeclared: () => undefined,
  peelCached: async (_r: unknown, tip: string) => ({ oid: peelTo.get(tip) ?? tip, type: 'commit' }),
}))
const READER: Record<string, unknown> = {
  forView: () => READER,
  forHistoryWalk: () => READER,
  readObject: async () => ({ type: 'commit', bytes: new Uint8Array() }),
}

import type { RepoHome } from '@/lib/view'
import { RefListContent } from './ref-list-content'

const TAG_A = 'a'.repeat(40)
const TAG_B = 'b'.repeat(40)
const COMMIT_A = '1'.repeat(40)
const COMMIT_B = '2'.repeat(40)

function home(tagTip: string): RepoHome {
  const ref = (refName: string, oid: string) => ({ refName, refNameHash: 'x', state: { state: 'resolved', oid, author: 'id', createdAt: 1 } })
  return {
    repo: { repoId: 'r' },
    defaultBranch: 'main',
    branches: [ref('refs/heads/main', COMMIT_A)],
    tags: [ref('refs/tags/v1', tagTip)],
  } as unknown as RepoHome
}

const addr = { owner: 'o', name: 'n' }
let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  browseCalls.length = 0
  peelTo.clear()
  peelTo.set(TAG_A, COMMIT_A)
  peelTo.set(TAG_B, COMMIT_B)
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

const chip = (): HTMLAnchorElement => el.querySelector('[data-testid="tag-commit"]') as HTMLAnchorElement
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

describe('RefListContent tag chips', () => {
  it('shows the commit a tag names, and follows a force-moved tag', async () => {
    await act(async () => root.render(<RefListContent home={home(TAG_A)} addr={addr} kind="tags" />))
    await settle()
    expect(chip().getAttribute('href')).toContain(`oid=${COMMIT_A}`)
    expect(chip().textContent).toContain(COMMIT_A.slice(0, 7))

    await act(async () => root.render(<RefListContent home={home(TAG_B)} addr={addr} kind="tags" />))
    await settle()
    expect(chip().getAttribute('href')).toContain(`oid=${COMMIT_B}`)
    expect(chip().textContent).toContain(COMMIT_B.slice(0, 7))
  })

  it('shows the tip itself when the repo has no published index (and starts no in-browser clone)', async () => {
    indexed = false
    try {
      await act(async () => root.render(<RefListContent home={home(TAG_A)} addr={addr} kind="tags" />))
      await settle()
      expect(chip().getAttribute('href')).toContain(`oid=${TAG_A}`)
      expect(chip().textContent).toContain(TAG_A.slice(0, 7))
    } finally {
      indexed = true
    }
  })

  it('starts no browse index for the branches list', async () => {
    await act(async () => root.render(<RefListContent home={home(TAG_A)} addr={addr} kind="branches" />))
    expect(browseCalls.every((r) => r === null)).toBe(true)
    expect(el.querySelector('[data-testid="tag-commit"]')).toBeNull()
  })
})
