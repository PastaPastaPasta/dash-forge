/**
 * One action that signs several writes (a repo's creation, a fork, a Settings save) shows one
 * toast with their total, not one per write or the last write's cost (QW2-034, QW3-039).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useToasts } from '../hooks/use-toasts'
import { currentSpendAction } from './sdk/spend-scope'
import type { WriteAuth } from './sdk/write'
import { spendAction, spendTitle, toastSpend, type TagSigner } from './spend-toast'

vi.mock('./sdk/write', () => ({ measurementsSettled: () => Promise.resolve() }))

const SIGNER: WriteAuth = { identityId: 'I', network: 'devnet', getSigningKeyWif: () => 'wif' }

/** A write reported now, as `reportSpend` does: its signer's action, else the open scope's. */
const spend = (kind: string, credits: number | null, auth: WriteAuth = SIGNER): void => {
  const action = auth.spendAction ?? currentSpendAction()
  toastSpend({ kind, ...(action !== null ? { action } : {}) }, credits)
}

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
    await spendAction({ running: 'Forking dips…', done: 'Forked dips as dips' }, async (tag) => {
      const auth = tag(SIGNER)
      spend('create:repo', 91_400_000, auth)
      spend('create:maintainer', 40_400_000, auth)
      spend('create:config', 35_500_000, auth)
      for (let i = 0; i < 2; i++) spend('create:packManifest', 85_000_000, auth)
      for (let i = 0; i < 27; i++) spend('create:refUpdate', 66_000_000, auth)
      expect(shown()).toEqual([{ title: 'Forking dips…', credits: 2_119_300_000, writes: 32 }])
    })
    await settle()
    expect(shown()).toEqual([{ title: 'Forked dips as dips', credits: 2_119_300_000, writes: 32 }])
  })

  it('a repo creation in its (modal) dialog folds its repo, maintainer and config writes (QW2-034)', async () => {
    await spendAction(
      { running: 'Creating the repository…', done: 'Repository created' },
      async () => {
        spend('create:repo', 81_700_000)
        spend('create:maintainer', 48_100_000)
        spend('create:config', 35_500_000)
      },
      { scope: true },
    )
    await settle()
    expect(shown()).toEqual([{ title: 'Repository created', credits: 165_300_000, writes: 3 }])
  })

  it('a Settings save: the repo replace and its topic writes are one toast', async () => {
    await spendAction(
      { done: 'Repository details saved' },
      async () => {
        spend('replace:repo', 5_800_000)
        spend('create:topic', 61_700_000)
        expect(shown()).toEqual([{ title: 'Topic added', credits: 67_500_000, writes: 2 }])
        spend('create:topic', 62_600_000)
        spend('delete:topic', -20_000_000)
      },
      { scope: true },
    )
    await settle()
    expect(shown()).toEqual([{ title: 'Repository details saved', credits: 110_100_000, writes: 4 }])
  })

  it('the last write measured after the action returned still joins its toast', async () => {
    let auth = SIGNER
    await spendAction({ running: 'Merging #4…', done: 'Merged #4' }, async (tag) => {
      auth = tag(SIGNER)
      spend('create:packManifest', 87_000_000, auth)
    })
    // Reported after the action returned (its measurement took longer), by the action's signer.
    spend('create:refUpdate', 59_000_000, auth)
    await settle()
    expect(shown()).toEqual([{ title: 'Merged #4', credits: 146_000_000, writes: 2 }])
  })

  it('an action of one write ends under that write\'s own title', async () => {
    await spendAction({ done: 'Saved' }, async () => spend('replace:comment', 7_800_000), { scope: true })
    await settle()
    expect(shown()).toEqual([{ title: 'Comment edited', credits: 7_800_000, writes: 1 }])
  })

  it('an action that failed says so, even after one write, with what its landed writes cost', async () => {
    for (const writes of [1, 2]) {
      useToasts.setState({ toasts: [] })
      await expect(
        spendAction({ running: 'Forking dash…', done: 'Forked dash', failed: 'Fork of dash stopped part-way' }, async (tag) => {
          for (let i = 0; i < writes; i++) spend('create:repo', 91_000_000, tag(SIGNER))
          throw new Error('refused')
        }),
      ).rejects.toThrow('refused')
      await settle()
      expect(shown()).toEqual([{ title: 'Fork of dash stopped part-way', credits: 91_000_000 * writes, writes, tone: 'warn' }])
    }
  })

  it('an unread charge makes the total unknown rather than short', async () => {
    await spendAction({ done: 'Forked' }, async (tag) => {
      spend('create:repo', 81_700_000, tag(SIGNER))
      spend('create:maintainer', null, tag(SIGNER))
    })
    await settle()
    expect(useToasts.getState().toasts[0]!.credits).toBeNull()
  })

  it('a toast dismissed or timed out mid-way still ends with the whole total', async () => {
    await spendAction({ running: 'Forking…', done: 'Forked' }, async (tag) => {
      spend('create:repo', 81_700_000, tag(SIGNER))
      useToasts.getState().dismiss(useToasts.getState().toasts[0]!.id)
      // A step longer than the toast waits.
      await vi.advanceTimersByTimeAsync(61_000)
      spend('create:maintainer', 48_100_000, tag(SIGNER))
    })
    await settle()
    expect(shown()).toEqual([{ title: 'Forked', credits: 129_800_000, writes: 2 }])
  })

  it('a write by another signer while an action runs beside the page is its own toast', async () => {
    let tagged: TagSigner = (a) => a
    const merge = spendAction({ running: 'Merging #4…', done: 'Merged #4' }, async (tag) => {
      tagged = tag
      await vi.advanceTimersByTimeAsync(1000)
    })
    spend('create:packManifest', 87_000_000, tagged(SIGNER))
    spend('create:star', 19_400_000)
    spend('create:refUpdate', 59_000_000, tagged(SIGNER))
    await merge
    await settle()
    expect(shown().map((t) => t.title)).toEqual(['Merged #4', 'Starred'])
  })

  it('writes outside an action, and the next action, are their own toasts', async () => {
    spend('create:star', 19_400_000)
    for (const name of ['A', 'B']) {
      await spendAction({ done: `${name} done` }, async (tag) => {
        spend('create:label', 34_000_000, tag(SIGNER))
        spend('create:event', 43_000_000, tag(SIGNER))
      })
    }
    await settle()
    expect(shown().map((t) => t.title)).toEqual(['Starred', 'A done', 'B done'])
  })

  it('a finished toast goes like any other', async () => {
    await spendAction({ done: 'Forked' }, async (tag) => {
      spend('create:repo', 81_700_000, tag(SIGNER))
      spend('create:maintainer', 48_100_000, tag(SIGNER))
    })
    await settle()
    await vi.advanceTimersByTimeAsync(9000)
    expect(shown()).toEqual([])
  })

  it('a refused write is its own warning, never folded into its action', async () => {
    await spendAction({ done: 'Forked' }, async (tag) => {
      spend('create:repo', 81_700_000, tag(SIGNER))
      spend('refused:maintainer', 1_000_000, tag(SIGNER))
    })
    await settle()
    expect(shown().map((t) => t.title)).toEqual(['Repository created', 'Platform refused that write'])
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
