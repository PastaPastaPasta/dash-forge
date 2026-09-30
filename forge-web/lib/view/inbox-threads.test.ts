/**
 * QW-066: the inbox lists one row per thread (an issue, a PR, a repo's pushes), newest thread
 * first, as GitHub does, instead of one row per event; and a write that joins a thread makes
 * the poller recompute its subscriptions at once.
 */

import { describe, expect, it } from 'vitest'

import { groupThreads, refreshesSubscriptions, threadKey, type InboxItem } from './inbox'

const repo = { id: 'R', ownerId: 'O', name: 'demo', private: false }
const other = { id: 'S', ownerId: 'O', name: 'other', private: false }
const item = (id: string, at: number, target: InboxItem['target'] | undefined, read = false, r = repo): InboxItem => ({
  id,
  kind: target ? 'comment' : 'push',
  repo: r,
  ...(target ? { target } : {}),
  what: `event ${id}`,
  actor: 'A',
  at,
  read,
})
const issue1 = { kind: 'issue' as const, number: 1, title: 'Old title' }
const issue1Renamed = { kind: 'issue' as const, number: 1, title: 'New title' }
const pull1 = { kind: 'pull' as const, number: 1, title: 'A PR' }

describe('groupThreads', () => {
  it('groups by repo and target (an issue and a PR with the same number are two threads)', () => {
    const threads = groupThreads([item('a', 10, issue1), item('b', 30, issue1Renamed, true), item('c', 20, pull1), item('d', 5, undefined), item('e', 40, issue1, false, other)])
    expect(threads.map((t) => t.key)).toEqual(['S:issue:1', 'R:issue:1', 'R:pull:1', 'R:push'])
    const i1 = threads[1]!
    expect(i1.items.map((i) => i.id)).toEqual(['b', 'a'])
    // The newest item's title names the thread; one of its two items is unread.
    expect(i1.target?.title).toBe('New title')
    expect(i1.unread).toBe(1)
  })

  it('keys a push without a target by its repo', () => {
    expect(threadKey(item('p', 1, undefined))).toBe('R:push')
  })
})

describe('refreshesSubscriptions', () => {
  it('is true for writes that join a thread or change what is watched', () => {
    for (const k of ['create:comment', 'create:issue', 'create:patch', 'create:review', 'create:watch', 'delete:watch', 'create:star', 'create:repo', 'create:writer']) {
      expect(refreshesSubscriptions(k), k).toBe(true)
    }
  })
  it('is false for the rest', () => {
    for (const k of ['create:refUpdate', 'key:register', 'create:release', 'refused:comment', 'create']) {
      expect(refreshesSubscriptions(k), k).toBe(false)
    }
  })
})
