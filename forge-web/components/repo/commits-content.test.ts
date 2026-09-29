/**
 * The Commits page's paging state (F-5): a log restarts for a new reader instead of appending page
 * one again (the same tip reached by another URL, `?ref=main` → the default branch, remounted the
 * walk on a new reader and listed every commit twice), and a page never repeats a shown commit.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ usePathname: () => '/repo/commits/', useSearchParams: () => new URLSearchParams() }))

import type { LogEntry } from '@/lib/view'
import type { PathVersionsPage } from '@/lib/view/path-history'
import { freshLog, logStatus, MAX_URL_PAGES, pagesParam, withPage } from './commits-content'

const entry = (oid: string): LogEntry => ({ oid, subject: oid, author: { name: '', when: 0 } })
const page = (oids: string[], next: string | null): PathVersionsPage => ({ entries: oids.map(entry), next, examined: oids.length, capped: false, indexed: 0 })

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

  it('counts the entries the history index listed', () => {
    const s = withPage(withPage(freshLog('c3'), { ...page(['c3', 'c2'], 'c1'), indexed: 2 }), page(['c1'], null))
    expect(s.indexed).toBe(2)
  })

  it('a restart starts empty at the tip', () => {
    expect(freshLog('c3')).toMatchObject({ entries: [], next: 'c3', loading: true })
  })
})

// L-31: how many pages are shown lives in the URL, so Back from a commit rebuilds the same list.
describe('?pages=', () => {
  it('reads 1 to MAX_URL_PAGES, 1 for anything else', () => {
    expect([null, '', '0', '-2', '2.5', 'x'].map(pagesParam)).toEqual([1, 1, 1, 1, 1, 1])
    expect(pagesParam('3')).toBe(3)
    expect(pagesParam('9999')).toBe(MAX_URL_PAGES)
  })

  it('counts the loaded pages', () => {
    const s = withPage(withPage(freshLog('c3'), page(['c3', 'c2'], 'c1')), page(['c1'], null))
    expect(s.pages).toBe(2)
  })
})

// L-35: the footer says how many commits are shown, never the loaded rows as if they were the history.
describe('logStatus', () => {
  const shown = withPage(freshLog('c3'), page(['c3', 'c2'], 'c1'))
  it('out of the first-parent count a history index gives', () => {
    expect(logStatus(shown, 7979)).toBe('Showing 2 of 7,979 commits')
  })
  it('as the newest ones while the total is unknown', () => {
    expect(logStatus(shown, null)).toBe('Showing the newest 2 commits')
  })
  it('as the whole history once the walk reached the root', () => {
    expect(logStatus(withPage(shown, page(['c1'], null)), null)).toBe('The whole history: 3 commits')
  })
  it("as a path's History", () => {
    expect(logStatus(shown, 99, 'src/a.c')).toBe('Showing 2 commits that changed src/a.c')
    expect(logStatus(withPage(shown, page(['c1'], null)), null, 'src/a.c')).toBe('The whole history of src/a.c: 3 commits')
  })
})
