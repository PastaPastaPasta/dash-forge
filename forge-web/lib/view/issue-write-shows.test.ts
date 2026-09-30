import { describe, expect, it } from 'vitest'

import { issueWriteShows, type IssueThread } from './issues-view'
import { readUntil } from './retry'

/** A thread with only the fields {@link issueWriteShows} reads. */
function thread(over: {
  comments?: { id: string; body: string }[]
  open?: boolean
  labels?: string[]
  assignees?: string[]
  defs?: string[]
  pinned?: boolean
  locked?: boolean
  milestone?: string | null
  title?: string
  body?: string
}): IssueThread {
  return {
    issue: {
      title: over.title ?? 't',
      body: over.body ?? 'b',
      state: { open: over.open ?? true, labels: over.labels ?? [], assignees: over.assignees ?? [] },
    },
    timeline: (over.comments ?? []).map((c) => ({ kind: 'comment', at: 0, comment: { ...c, author: 'a', createdAt: 0, replyTo: null } })),
    labels: (over.defs ?? []).map((name) => ({ name })),
    meta: { milestone: over.milestone ?? null, pinned: over.pinned ?? false, pinnedAt: null, locked: over.locked ?? false },
  } as unknown as IssueThread
}

describe('issueWriteShows', () => {
  it('a posted comment shows once its document is in the timeline', () => {
    expect(issueWriteShows(thread({}), { kind: 'comment', id: 'c1' })).toBe(false)
    expect(issueWriteShows(thread({ comments: [{ id: 'c1', body: 'x' }] }), { kind: 'comment', id: 'c1' })).toBe(true)
  })

  it('state, labels, assignees, pin, lock and milestone follow the write', () => {
    expect(issueWriteShows(thread({ open: true }), { kind: 'state', open: false })).toBe(false)
    expect(issueWriteShows(thread({ open: false }), { kind: 'state', open: false })).toBe(true)
    expect(issueWriteShows(thread({ labels: ['bug'] }), { kind: 'label', label: 'bug', remove: false })).toBe(true)
    expect(issueWriteShows(thread({ labels: ['bug'] }), { kind: 'label', label: 'bug', remove: true })).toBe(false)
    expect(issueWriteShows(thread({ assignees: [] }), { kind: 'assign', who: 'w', remove: true })).toBe(true)
    expect(issueWriteShows(thread({ assignees: [] }), { kind: 'assign', who: 'w', remove: false })).toBe(false)
    expect(issueWriteShows(thread({ pinned: true }), { kind: 'flag', flag: 'pin', on: true })).toBe(true)
    expect(issueWriteShows(thread({ pinned: false }), { kind: 'flag', flag: 'pin', on: true })).toBe(false)
    expect(issueWriteShows(thread({ locked: false }), { kind: 'flag', flag: 'lock', on: true })).toBe(false)
    expect(issueWriteShows(thread({ milestone: 'v1' }), { kind: 'milestone', title: null })).toBe(false)
    expect(issueWriteShows(thread({ milestone: null }), { kind: 'milestone', title: null })).toBe(true)
  })

  it('a defined label shows once defined, and applied when asked', () => {
    expect(issueWriteShows(thread({ defs: ['new'] }), { kind: 'defineLabel', name: 'new', apply: true })).toBe(false)
    expect(issueWriteShows(thread({ defs: ['new'], labels: ['new'] }), { kind: 'defineLabel', name: 'new', apply: true })).toBe(true)
    expect(issueWriteShows(thread({ defs: ['new'] }), { kind: 'defineLabel', name: 'new', apply: false })).toBe(true)
  })

  it('edits show once the new text is read back', () => {
    expect(issueWriteShows(thread({ title: 'old' }), { kind: 'editIssue', title: 'new', body: 'b' })).toBe(false)
    expect(issueWriteShows(thread({ title: 'new' }), { kind: 'editIssue', title: 'new', body: 'b' })).toBe(true)
    expect(issueWriteShows(thread({ title: 'new', body: 'old' }), { kind: 'editIssue', title: 'new', body: 'b' })).toBe(false)
    expect(issueWriteShows(thread({ comments: [{ id: 'c1', body: 'old' }] }), { kind: 'editComment', id: 'c1', body: 'new' })).toBe(false)
    expect(issueWriteShows(thread({ comments: [{ id: 'c1', body: 'new' }] }), { kind: 'editComment', id: 'c1', body: 'new' })).toBe(true)
  })

  it('a lagging node that first answers without the comment is read again until it shows (D-12)', async () => {
    const reads = [thread({}), thread({}), thread({ comments: [{ id: 'c1', body: 'x' }] })]
    let n = 0
    const got = await readUntil(async () => reads[Math.min(n++, reads.length - 1)] ?? null, [(t) => issueWriteShows(t, { kind: 'comment', id: 'c1' })], { delayMs: 1 })
    expect(n).toBe(3)
    expect(got && issueWriteShows(got, { kind: 'comment', id: 'c1' })).toBe(true)
  })
})
