// @vitest-environment jsdom
/**
 * Blame's run state in React's StrictMode (F-5): the mount-time effect runs twice, and the first
 * run is aborted by its cleanup. That aborted run must settle into nothing: before the fix it set
 * "Blame stopped" after the second run had started, so the page said it was cancelled until the
 * second run's first progress (or for good, when the second run finished first).
 */

import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('next/navigation', () => ({ usePathname: () => '/repo/blame/', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: () => undefined, push: () => undefined }) }))

/** Each call's deferred result; the test settles them in the order it wants. */
const calls: { signal: AbortSignal; resume: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = []
vi.mock('@/lib/view/blame', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/view/blame')>()
  return {
    ...real,
    blameFile: (_r: unknown, _t: string, _p: string, { signal, resume }: { signal: AbortSignal; resume?: unknown }) =>
      new Promise((resolve, reject) => {
        calls.push({ signal, resume, resolve, reject })
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }),
  }
})

import { BlameBody, blameProgressText } from './blame-content'

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls.length = 0
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

describe('BlameBody in StrictMode', () => {
  it('never shows "Blame stopped" for the run StrictMode aborted', async () => {
    await act(async () => {
      root.render(
        <StrictMode>
          <BlameBody reader={{} as never} tipOid={'a'.repeat(40)} path="f" addr={{ owner: 'o', name: 'n' }} repo={{ repoId: 'r' } as never} />
        </StrictMode>,
      )
    })
    // StrictMode ran the effect twice: the first run aborted, the second still going.
    expect(calls).toHaveLength(2)
    expect(calls[0]?.signal.aborted).toBe(true)
    await act(async () => {
      await Promise.resolve()
    })
    expect(el.textContent).not.toContain('Blame stopped')
    expect(el.querySelector('[data-testid="blame-progress"]')).not.toBeNull()
  })

  it('Cancel still stops the current run and says so', async () => {
    await act(async () => {
      root.render(<BlameBody reader={{} as never} tipOid={'a'.repeat(40)} path="f" addr={{ owner: 'o', name: 'n' }} repo={{ repoId: 'r' } as never} />)
    })
    await act(async () => {
      ;(el.querySelector('[data-testid="blame-cancel"]') as HTMLButtonElement).click()
    })
    expect(el.textContent).toContain('Blame stopped')
  })

  it('Cancel after some versions keeps the partial table, marked stopped, with Run again (L-23)', async () => {
    const { BlameStoppedError } = await import('@/lib/view/blame')
    await act(async () => {
      root.render(<BlameBody reader={{} as never} tipOid={'a'.repeat(40)} path="f" addr={{ owner: 'o', name: 'n' }} />)
    })
    const c = 'c'.repeat(40)
    const partial = {
      lines: ['one\n', 'two\n'],
      hunks: [{ start: 1, count: 2, oid: c }],
      commits: new Map([[c, { oid: c, subject: 'subject', author: { name: 'a', when: 0 } }]]),
      partial: true,
      boundary: { oid: c, reason: 'stopped', lines: 0 },
      cursor: null,
      approximate: false,
      versions: 3,
      renames: [],
    }
    // The run answers its abort with what it had (the real blameFile does); rejected before the
    // click, so the mock's own AbortError on the signal comes too late to count.
    await act(async () => {
      const run = calls[0]!
      run.reject(new BlameStoppedError(partial as never))
      ;(el.querySelector('[data-testid="blame-cancel"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(el.querySelector('[data-testid="blame-table"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="blame-stopped"]')?.textContent).toContain('Run again')
    expect(el.textContent).not.toContain('Stopped before')
  })
})

// QW-005: lines past the walk's cap were shown on the 200th version's commit, dated and linked as
// if it were theirs. They read "not attributed yet", name no commit, and Continue goes on.
describe('BlameBody past the version cap', () => {
  const a = 'a'.repeat(40)
  const b = 'b'.repeat(40)
  const cursor = { marker: 'cursor' }
  const capped = {
    lines: ['new\n', 'old\n', 'older\n'],
    hunks: [
      { start: 1, count: 1, oid: a },
      { start: 2, count: 2, oid: b, unresolved: true },
    ],
    commits: new Map([
      [a, { oid: a, subject: 'the newest change', author: { name: 'x', when: Date.UTC(2025, 0, 1) } }],
      [b, { oid: b, subject: 'the boundary commit', author: { name: 'y', when: Date.UTC(2023, 5, 4) } }],
    ]),
    partial: true,
    boundary: { oid: b, reason: 'versions', lines: 2 },
    cursor,
    approximate: false,
    versions: 200,
    renames: [],
  }

  it('marks the unattributed lines, names no commit for them, and Continue resumes from the cursor', async () => {
    await act(async () => {
      root.render(<BlameBody reader={{} as never} tipOid={'f'.repeat(40)} path="f" addr={{ owner: 'o', name: 'n' }} />)
    })
    await act(async () => {
      calls[0]!.resolve(capped)
      await Promise.resolve()
    })
    const rows = [...el.querySelectorAll('[data-testid="blame-table"] tr[id]')]
    expect(rows.map((r) => r.getAttribute('data-oid'))).toEqual([a, null, null])
    expect(rows.map((r) => r.getAttribute('data-unresolved-at'))).toEqual([null, b, b])
    // The boundary's subject is never shown as a line's commit.
    expect(el.querySelector('[data-testid="blame-table"]')?.textContent).not.toContain('the boundary commit')
    expect(el.querySelector('[data-testid="blame-unresolved"]')?.textContent).toContain('bbbbbbb or older')
    const summary = el.querySelector('[data-testid="blame-partial"]')?.textContent ?? ''
    expect(summary).toContain('2 lines are not attributed yet')
    expect(summary).toContain('bbbbbbb')
    // One commit owns lines; the boundary does not count.
    expect(el.querySelector('[data-testid="blame-summary"]')?.textContent).toContain('1 commit ·')
    await act(async () => {
      ;(el.querySelector('[data-testid="blame-continue"]') as HTMLButtonElement).click()
    })
    expect(calls).toHaveLength(2)
    expect(calls[1]!.resume).toBe(cursor)
    expect(calls[0]!.resume).toBeUndefined()
  })

  // QW4-015: Continue blame replaced the attributed table with a full-panel progress view.
  it('keeps the attributed table on screen while Continue runs, with its progress and Cancel inline', async () => {
    await act(async () => {
      root.render(<BlameBody reader={{} as never} tipOid={'f'.repeat(40)} path="f" addr={{ owner: 'o', name: 'n' }} />)
    })
    await act(async () => {
      calls[0]!.resolve(capped)
      await Promise.resolve()
    })
    await act(async () => {
      ;(el.querySelector('[data-testid="blame-continue"]') as HTMLButtonElement).click()
    })
    expect(el.querySelector('[data-testid="blame-progress"]')).toBeNull()
    expect(el.querySelectorAll('[data-testid="blame-table"] tr[id]')).toHaveLength(3)
    const status = el.querySelector('[data-testid="blame-continuing"]')
    expect(status?.textContent).toContain('Reading the file')
    // No second Continue (and no clickable "or older" cell) while one runs.
    expect(el.querySelector('[data-testid="blame-continue"]')).toBeNull()
    expect(el.querySelector('button[data-testid="blame-unresolved"]')).toBeNull()
    // Cancel keeps a table too.
    await act(async () => {
      ;(el.querySelector('[data-testid="blame-cancel"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(calls[1]!.signal.aborted).toBe(true)
    expect(el.querySelector('[data-testid="blame-continuing"]')).toBeNull()
    expect(el.querySelectorAll('[data-testid="blame-table"] tr[id]')).toHaveLength(3)
    expect(el.querySelector('[data-testid="blame-continue"]')).not.toBeNull()
  })
})

// QW-060: blame names each hunk's author and highlights the code as the file view does.
describe('BlameBody rows', () => {
  it('shows the author beside the subject and highlights the code', async () => {
    const a = 'a'.repeat(40)
    const done = {
      lines: ['fn main() {\n', '    let x = 1;\n', '}\n'],
      hunks: [{ start: 1, count: 3, oid: a }],
      commits: new Map([[a, { oid: a, subject: 'add main', author: { name: 'Satoshi', when: Date.UTC(2025, 0, 1) } }]]),
      partial: false,
      boundary: null,
      cursor: null,
      approximate: false,
      versions: 1,
      renames: [],
    }
    await act(async () => {
      root.render(<BlameBody reader={{} as never} tipOid={'f'.repeat(40)} path="src/main.rs" addr={{ owner: 'o', name: 'n' }} />)
    })
    await act(async () => {
      calls[0]!.resolve(done)
      await Promise.resolve()
    })
    expect(el.querySelector('[data-testid="blame-author"]')?.textContent).toBe('Satoshi')
    // highlight.js loads in its own chunk; the rows swap to highlighted HTML once it has.
    await vi.waitFor(() => expect(el.querySelector('[data-testid="blame-table"] .hljs-keyword')).not.toBeNull())
    const code = [...el.querySelectorAll('[data-testid="blame-table"] tr[id] td:last-child')].map((td) => td.textContent)
    expect(code).toEqual(['fn main() {', '    let x = 1;', '}'])
  })
})

describe('blameProgressText (QW2-039)', () => {
  const base = { versions: 3, versionLimit: 200, pending: 10, total: 40, indexed: 0, searching: false }
  it('counts commits only while they are walked', () => {
    expect(blameProgressText({ ...base, examined: 0, indexed: 3 })).toBe('Compared 3 versions of up to 200 · 30 lines of 40 attributed')
    expect(blameProgressText({ ...base, examined: 12 })).toBe('Compared 3 versions of up to 200 · 30 lines of 40 attributed · after examining 12 commits')
    // Searching for older versions: the commit count is what moves, so it leads.
    expect(blameProgressText({ ...base, examined: 88, searching: true })).toBe(
      'Looking for older versions · 88 commits examined · compared 3 versions of up to 200 · 30 lines of 40 attributed so far',
    )
    expect(blameProgressText({ ...base, versions: 0, examined: 0 })).toBe('Looking for the file’s versions')
    expect(blameProgressText({ ...base, versions: 0, examined: 1 })).toBe('Looking for the file’s versions · 1 commit examined')
    expect(blameProgressText(null)).toBe('Reading the file’s history…')
  })
})
