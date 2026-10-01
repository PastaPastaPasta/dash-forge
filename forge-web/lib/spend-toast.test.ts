/**
 * One action that signs several writes (a repo's creation, a fork, a Settings save) shows one
 * toast with their total, not one per write or the last write's cost (QW2-034, QW3-039).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { toast, useToasts } from '../hooks/use-toasts'
import { currentSpendAction } from './sdk/spend-scope'
import { spendAction, spendTitle, spendToast } from './spend-toast'

vi.mock('./sdk/write', () => ({ measurementsSettled: () => Promise.resolve() }))

/** A write reported now, as `reportSpend` does: tagged with the action open now. */
const spend = (kind: string, credits: number | null, action = currentSpendAction()): void =>
  toast({ ...spendToast({ kind, ...(action !== null ? { action } : {}) }), credits })

const shown = () => useToasts.getState().toasts.map(({ title, credits, writes, tone }) => ({ title, credits, writes, ...(tone ? { tone } : {}) }))

/** Let the action's end (it waits for the last measurement) run. */
const settle = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  useToasts.setState({ toasts: [] })
})
afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
})

describe('an action of several writes shows one toast with their total (QW3-039)', () => {
  it('a fork: 32 writes, one "Forked" toast with the sum, not the last write', async () => {
    await spendAction({ running: 'Forking dips…', done: 'Forked dips as dips' }, async () => {
      spend('create:repo', 91_400_000)
      spend('create:maintainer', 40_400_000)
      spend('create:config', 35_500_000)
      for (let i = 0; i < 2; i++) spend('create:packManifest', 85_000_000)
      for (let i = 0; i < 27; i++) spend('create:refUpdate', 66_000_000)
      expect(shown()).toEqual([{ title: 'Forking dips…', credits: 91_400_000 + 40_400_000 + 35_500_000 + 170_000_000 + 27 * 66_000_000, writes: 32 }])
    })
    await settle()
    expect(shown()).toEqual([{ title: 'Forked dips as dips', credits: 2_119_300_000, writes: 32 }])
  })

  it('a repo creation folds its repo, maintainer and config writes (QW2-034)', async () => {
    await spendAction({ running: 'Creating the repository…', done: 'Repository created' }, async () => {
      spend('create:repo', 81_700_000)
      spend('create:maintainer', 48_100_000)
      spend('create:config', 35_500_000)
    })
    await settle()
    expect(shown()).toEqual([{ title: 'Repository created', credits: 165_300_000, writes: 3 }])
  })

  it('a Settings save: the repo replace and its topic writes are one toast', async () => {
    await spendAction({ running: 'Saving the repo details…', done: 'Repository details saved' }, async () => {
      spend('replace:repo', 5_800_000)
      spend('create:topic', 61_700_000)
      spend('create:topic', 62_600_000)
      spend('delete:topic', -20_000_000)
    })
    await settle()
    expect(shown()).toEqual([{ title: 'Repository details saved', credits: 110_100_000, writes: 4 }])
  })

  it('the last write measured after the action returned still joins its toast', async () => {
    let late: string | null = null
    await spendAction({ running: 'Merging #4…', done: 'Merged #4' }, async () => {
      spend('create:packManifest', 87_000_000)
      late = currentSpendAction()
    })
    // Reported after the action returned (its measurement took longer), tagged when it was made.
    spend('create:refUpdate', 59_000_000, late)
    await settle()
    expect(shown()).toEqual([{ title: 'Merged #4', credits: 146_000_000, writes: 2 }])
  })

  it('an action of one write ends under that write\'s own title', async () => {
    await spendAction({ running: 'Writing to Platform…', done: 'Saved' }, async () => {
      spend('replace:comment', 7_800_000)
      expect(shown()).toEqual([{ title: 'Writing to Platform…', credits: 7_800_000, writes: 1 }])
    })
    await settle()
    expect(shown()).toEqual([{ title: 'Comment edited', credits: 7_800_000, writes: 1 }])
  })

  it('an action that failed part-way says so, with what its landed writes cost', async () => {
    await expect(
      spendAction({ running: 'Forking dash…', done: 'Forked dash' }, async () => {
        spend('create:repo', 91_000_000)
        spend('create:maintainer', 40_000_000)
        throw new Error('refused')
      }),
    ).rejects.toThrow('refused')
    await settle()
    expect(shown()).toEqual([{ title: 'Forking dash stopped part-way', credits: 131_000_000, writes: 2, tone: 'warn' }])
  })

  it('an unread charge makes the total unknown rather than short', async () => {
    await spendAction({ running: 'Forking…', done: 'Forked' }, async () => {
      spend('create:repo', 81_700_000)
      spend('create:maintainer', null)
    })
    await settle()
    expect(useToasts.getState().toasts[0]!.credits).toBeNull()
  })

  it('an action inside another is part of it', async () => {
    await spendAction({ running: 'Merging #4…', done: 'Merged #4' }, async () => {
      spend('create:packManifest', 87_000_000)
      await spendAction({ running: 'Closing…', done: 'Closed' }, async () => spend('create:transition', 50_000_000))
    })
    await settle()
    expect(shown()).toEqual([{ title: 'Merged #4', credits: 137_000_000, writes: 2 }])
  })

  it('writes outside an action, and the next action, are their own toasts', async () => {
    spend('create:star', 19_400_000)
    await spendAction({ running: 'A…', done: 'A done' }, async () => {
      spend('create:label', 34_000_000)
      spend('create:event', 43_000_000)
    })
    await spendAction({ running: 'B…', done: 'B done' }, async () => {
      spend('create:label', 34_000_000)
      spend('create:event', 43_000_000)
    })
    await settle()
    expect(shown().map((t) => t.title)).toEqual(['Starred', 'A done', 'B done'])
  })

  it('waits for a slow write, then lets the finished toast go like any other', async () => {
    const run = spendAction({ running: 'Forking…', done: 'Forked' }, async () => {
      spend('create:repo', 81_700_000)
      // One write (reads, broadcast, confirmation, measurement) can take longer than 8 s.
      await vi.advanceTimersByTimeAsync(20_000)
      spend('create:maintainer', 48_100_000)
    })
    await run
    await settle()
    expect(shown()).toEqual([{ title: 'Forked', credits: 129_800_000, writes: 2 }])
    await vi.advanceTimersByTimeAsync(9000)
    expect(shown()).toEqual([])
  })
})

describe('every write kind the web signs has a title of its own', () => {
  it('names the kinds that used to read "Write confirmed"', () => {
    for (const kind of ['replace:repo', 'create:topic', 'create:packManifest', 'create:refUpdate', 'create:transition', 'create:label', 'replace:comment']) {
      expect(spendTitle(kind)).not.toBe('Write confirmed')
    }
    expect(spendTitle('create:somethingNew')).toBe('Saved')
  })
})
