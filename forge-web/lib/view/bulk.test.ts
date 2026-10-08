/** Bulk actions: what a batch changes, and how it runs, stops, fails and retries. */

import { describe, expect, it } from 'vitest'

import { actionTitle, allReopenable, closeBlocked, labelCoverage, menuPlacement, planBulk, retryable, runBatch, tally, unchangedNote, unchangedSummary, unchangedWord, type BulkOutcome, type BulkRow } from './bulk'

const row = (n: number, over: Partial<BulkRow> = {}): BulkRow => ({ id: `id${n}`, number: n, title: `T${n}`, author: 'a', open: true, merged: false, labels: [], ...over })

describe('planBulk', () => {
  it('closes only open rows, reopens only closed unmerged ones, labels only where it changes', () => {
    const rows = [row(1), row(2, { open: false }), row(3, { open: false, merged: true }), row(4, { labels: ['bug'] })]
    expect(planBulk({ kind: 'close' }, rows).apply.map((r) => r.number)).toEqual([1, 4])
    expect(planBulk({ kind: 'reopen' }, rows).apply.map((r) => r.number)).toEqual([2])
    const add = planBulk({ kind: 'label', label: 'bug', add: true }, rows)
    expect(add.apply.map((r) => r.number)).toEqual([1, 2, 3])
    expect(add.unchanged).toBe(1)
    expect(planBulk({ kind: 'label', label: 'bug', add: false }, rows).apply.map((r) => r.number)).toEqual([4])
  })

  it('offers Reopen only when every selected row is closed and none merged', () => {
    expect(allReopenable([row(1, { open: false }), row(2, { open: false })])).toBe(true)
    expect(allReopenable([row(1, { open: false }), row(2)])).toBe(false)
    expect(allReopenable([row(1, { open: false, merged: true })])).toBe(false)
    expect(allReopenable([])).toBe(false)
  })

  it('ticks a label on all, some or none of the selection', () => {
    const rows = [row(1, { labels: ['bug'] }), row(2)]
    expect(labelCoverage(rows, 'bug')).toBe('some')
    expect(labelCoverage([rows[0] as BulkRow], 'bug')).toBe('all')
    expect(labelCoverage(rows, 'docs')).toBe('none')
  })

  it('names the batch', () => {
    expect(actionTitle({ kind: 'close', reason: 'not_planned' }, 'issue', 3)).toBe('Close 3 issues as not planned')
    expect(actionTitle({ kind: 'label', label: 'bug', add: true }, 'pull', 1)).toBe('Add bug to 1 pull request')
    expect(actionTitle({ kind: 'label', label: 'bug', add: false }, 'pull', 2)).toBe('Remove bug from 2 pull requests')
  })
})

describe('runBatch', () => {
  const ok = { message: '', unconfirmed: false, stop: false }

  it('writes each item in order with its own intent and reports progress', async () => {
    const seen: string[] = []
    const events: [string, string][] = []
    const out = await runBatch([row(1), row(2)], {
      intent: 'b1',
      write: async (r, intent) => {
        seen.push(intent)
        return { changed: r.number === 1 }
      },
      classify: () => ok,
      onOutcome: (id, o) => events.push([id, o.status]),
    })
    expect(seen).toEqual(['b1:id1', 'b1:id2'])
    expect(events).toEqual([['id1', 'running'], ['id1', 'done'], ['id2', 'running'], ['id2', 'unchanged']])
    expect(tally(out)).toMatchObject({ done: 1, unchanged: 1 })
  })

  it('keeps going past an item that fails, and leaves it for Retry failed with the reason', async () => {
    const out = await runBatch([row(1), row(2), row(3)], {
      intent: 'b',
      write: async (r) => {
        if (r.number === 2) throw new Error('refused')
        return { changed: true }
      },
      classify: (e) => ({ message: (e as Error).message, unconfirmed: false, stop: false }),
    })
    expect(out.get('id2')).toEqual({ status: 'failed', message: 'refused' })
    expect(out.get('id3')?.status).toBe('done')
    expect([...out.values()].filter(retryable)).toHaveLength(1)
  })

  it('stops at a failure no later write can pass (funds), marking the rest not tried', async () => {
    const out = await runBatch([row(1), row(2), row(3)], {
      intent: 'b',
      write: async (r) => {
        if (r.number === 1) throw new Error('balance')
        return { changed: true }
      },
      classify: () => ({ message: 'Your balance is too low', unconfirmed: false, stop: true }),
    })
    expect([...out.values()].map((o: BulkOutcome) => o.status)).toEqual(['failed', 'stopped', 'stopped'])
  })

  it('reports a sent write not yet shown as unconfirmed, and a retry re-uses its intent', async () => {
    const intents: string[] = []
    const write = async (r: BulkRow, intent: string) => {
      intents.push(intent)
      if (intents.length === 1) throw new Error('not yet visible')
      return { changed: true }
    }
    const first = await runBatch([row(1)], { intent: 'b', write, classify: (e) => ({ message: (e as Error).message, unconfirmed: true, stop: false }) })
    expect(first.get('id1')?.status).toBe('unconfirmed')
    const again = await runBatch([row(1)], { intent: 'b', write, classify: () => ok })
    expect(again.get('id1')?.status).toBe('done')
    expect(intents).toEqual(['b:id1', 'b:id1'])
  })

  it('keeps what an item that needed no write says apart from one that was written', async () => {
    const out = await runBatch([row(1), row(2), row(3)], {
      intent: 'b',
      write: async (r) => (r.number === 1 ? { changed: true } : r.number === 2 ? { changed: false } : { changed: false, note: 'Already merged.' }),
      classify: () => ok,
    })
    expect(out.get('id1')).toEqual({ status: 'done' })
    expect(out.get('id2')).toEqual({ status: 'unchanged' })
    expect(out.get('id3')).toEqual({ status: 'unchanged', message: 'Already merged.' })
  })

  it('leaves what a stop did not reach as stopped, which a retry takes up', async () => {
    let stop = false
    const out = await runBatch([row(1), row(2), row(3)], {
      intent: 'b',
      write: async () => {
        stop = true
        return { changed: true }
      },
      classify: () => ok,
      shouldStop: () => stop,
    })
    expect(tally(out)).toMatchObject({ done: 1, stopped: 2, failed: 0 })
    expect([...out.values()].filter(retryable)).toHaveLength(2)
  })

  it('stops between items when asked', async () => {
    let stop = false
    const out = await runBatch([row(1), row(2)], {
      intent: 'b',
      write: async () => {
        stop = true
        return { changed: true }
      },
      classify: () => ok,
      shouldStop: () => stop,
    })
    expect(out.get('id1')?.status).toBe('done')
    expect(out.get('id2')?.status).toBe('stopped')
  })
})

describe('what an item that needed no write says', () => {
  it('names the state it already was in', () => {
    expect(unchangedWord({ kind: 'close' })).toBe('Already closed.')
    expect(unchangedWord({ kind: 'reopen' })).toBe('Already open.')
    expect(unchangedWord({ kind: 'label', label: 'bug', add: true })).toBe('Already has the label.')
    expect(unchangedWord({ kind: 'label', label: 'bug', add: false })).toBe("Doesn't have the label.")
  })

  it('counts them for the summary', () => {
    expect(unchangedSummary(1)).toBe('1 was already that way.')
    expect(unchangedSummary(3)).toBe('3 were already that way.')
  })
})

describe('menuPlacement', () => {
  const desktop = { width: 1280, height: 800 }
  it('opens below its button at its width on a roomy screen', () => {
    expect(menuPlacement({ left: 200, top: 100, bottom: 130 }, desktop)).toEqual({ left: 200, width: 240, top: 134, maxHeight: 288 })
  })

  it('stays inside a phone: shifted left and never wider than the screen', () => {
    const phone = { width: 390, height: 844 }
    const p = menuPlacement({ left: 230, top: 100, bottom: 130 }, phone)
    expect(p.left + p.width).toBeLessThanOrEqual(390 - 8)
    expect(p.left).toBeGreaterThanOrEqual(8)
    expect(menuPlacement({ left: 10, top: 100, bottom: 130 }, { width: 200, height: 800 }).width).toBe(184)
  })

  it('opens above the button when there is more room above, and fits its height to the room', () => {
    const p = menuPlacement({ left: 20, top: 700, bottom: 730 }, { width: 1280, height: 800 })
    expect(p.top).toBeUndefined()
    expect(p.bottom).toBe(800 - 700 + 4)
    expect(p.maxHeight).toBe(288)
    const short = menuPlacement({ left: 20, top: 150, bottom: 180 }, { width: 800, height: 260 })
    expect(short.top).toBeUndefined()
    expect(short.maxHeight).toBe(138)
  })
})

describe('a batch over merged pull requests (Q5)', () => {
  const merged = row(1, { open: false, merged: true })
  const closed = row(2, { open: false })
  it('offers no Close when nothing selected is open', () => {
    expect(closeBlocked([merged, closed])).toBe('Nothing selected is open.')
    expect(closeBlocked([merged])).toBe("Merged pull requests can't be closed.")
    expect(closeBlocked([merged, row(3)])).toBeNull()
  })
  it('says a merged pull request is already merged, not "already that way"', () => {
    const plan = planBulk({ kind: 'close' }, [merged, closed, row(3)])
    expect(plan).toMatchObject({ unchanged: 2, merged: 1 })
    expect(unchangedNote(plan)).toBe('1 selected is already that way and is left as it is. 1 selected is already merged and is left as it is.')
    expect(unchangedNote(planBulk({ kind: 'close' }, [merged, row(3)]))).toBe('1 selected is already merged and is left as it is.')
    expect(unchangedNote(planBulk({ kind: 'close' }, [row(3)]))).toBeNull()
    // A label leaves a merged pull request as any other.
    expect(planBulk({ kind: 'label', label: 'bug', add: false }, [merged]).merged).toBe(0)
  })
})
