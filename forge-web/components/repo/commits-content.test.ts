/**
 * The Commits page's paging state (F-5): a log restarts for a new reader instead of appending page
 * one again (the same tip reached by another URL, `?ref=main` → the default branch, remounted the
 * walk on a new reader and listed every commit twice), and a page never repeats a shown commit.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ usePathname: () => '/repo/commits/', useSearchParams: () => new URLSearchParams() }))

import type { LogEntry } from '@/lib/view'
import type { LogPage } from '@/lib/view/path-history'
import { freshLog, withPage } from './commits-content'

const entry = (oid: string): LogEntry => ({ oid, subject: oid, commit: { tree: '', parents: [], author: { name: '', email: '', when: 0 }, committer: { name: '', email: '', when: 0 }, message: oid } })
const page = (oids: string[], next: string | null): LogPage => ({ entries: oids.map(entry), next, examined: oids.length, capped: false })

describe('commit log paging state', () => {
  it('appends each older page once', () => {
    const s = withPage(withPage(freshLog('c3'), page(['c3', 'c2'], 'c1')), page(['c1'], null))
    expect(s.entries.map((e) => e.oid)).toEqual(['c3', 'c2', 'c1'])
    expect(s.next).toBeNull()
  })

  it('a first page landing twice (a new reader re-ran the walk) is not listed twice', () => {
    const once = withPage(freshLog('c3'), page(['c3', 'c2'], 'c1'))
    expect(withPage(once, page(['c3', 'c2'], 'c1')).entries.map((e) => e.oid)).toEqual(['c3', 'c2'])
  })

  it('a restart starts empty at the tip', () => {
    expect(freshLog('c3')).toMatchObject({ entries: [], next: 'c3', loading: true })
  })
})
