/**
 * A repo's creation signs three writes (four for a private repo); its toast gives their total,
 * not the first write's cost under "Repository created" (QW2-034).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { toast, useToasts } from '../hooks/use-toasts'
import { spendToast } from './spend-toast'

const spend = (kind: string, repo: string | null, credits: number | null): void => toast({ ...spendToast({ kind, repo }), credits })

beforeEach(() => {
  vi.useFakeTimers()
  useToasts.setState({ toasts: [] })
})
afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
})

describe('a repo creation shows one toast with its total (QW2-034)', () => {
  it('folds the repo, maintainer and config writes into "Repository created" and their sum', () => {
    spend('create:repo', 'R', 81_700_000)
    expect(useToasts.getState().toasts).toMatchObject([{ title: 'Creating the repository', credits: 81_700_000, writes: 1 }])
    spend('create:maintainer', 'R', 48_100_000)
    spend('create:config', 'R', 35_500_000)
    expect(useToasts.getState().toasts).toMatchObject([{ title: 'Repository created', credits: 165_300_000, writes: 3 }])
  })

  it('a private creation folds its key hand-out in too', () => {
    spend('create:repo', 'P', 80_000_000)
    spend('create:maintainer', 'P', 48_000_000)
    spend('create:repoKey', 'P', 40_000_000)
    spend('create:config', 'P', 36_000_000)
    expect(useToasts.getState().toasts).toMatchObject([{ title: 'Repository created', credits: 204_000_000, writes: 4 }])
  })

  it('an unread charge makes the total unknown rather than short', () => {
    spend('create:repo', 'R', 81_700_000)
    spend('create:maintainer', 'R', null)
    expect(useToasts.getState().toasts[0]!.credits).toBeNull()
  })

  it('a maintainer added later, or to another repo, is its own toast', () => {
    spend('create:maintainer', 'R', 48_000_000)
    spend('create:repo', 'S', 81_700_000)
    spend('create:maintainer', 'T', 48_000_000)
    expect(useToasts.getState().toasts.map((t) => t.title)).toEqual(['Maintainer added', 'Creating the repository', 'Maintainer added'])
  })

  it('a creation whose toast has gone starts afresh', () => {
    spend('create:repo', 'R', 81_700_000)
    vi.advanceTimersByTime(9000)
    expect(useToasts.getState().toasts).toEqual([])
    spend('create:config', 'R', 35_500_000)
    expect(useToasts.getState().toasts).toMatchObject([{ title: 'Repository config written', writes: 1 }])
  })
})
