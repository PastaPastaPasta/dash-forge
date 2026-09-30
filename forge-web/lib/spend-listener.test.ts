/** The inbox hears of this tab's writes once their ledger row is stored (QW-066). */

import { beforeEach, describe, expect, it } from 'vitest'

import { resetMemoryStores } from './idb'
import { onSpendRecorded, readLedger, recordSpend } from './spend'
import type { SpendEvent } from './sdk/write'

const event: SpendEvent = { identityId: 'ME', network: 'devnet', kind: 'create:comment', repo: 'R', documentId: 'D', estimateCredits: 1, actualCredits: 1, balanceBefore: null }

beforeEach(() => resetMemoryStores())

describe('onSpendRecorded', () => {
  it('tells each listener after the row is stored, until it unsubscribes', async () => {
    const heard: { kind: string; rows: number }[] = []
    const off = onSpendRecorded((e) => {
      void readLedger('devnet', 'ME').then((rows) => heard.push({ kind: e.kind, rows: rows.length }))
    })
    await recordSpend(event)
    await new Promise((r) => setTimeout(r, 0))
    expect(heard).toEqual([{ kind: 'create:comment', rows: 1 }])
    off()
    await recordSpend({ ...event, documentId: 'D2' })
    await new Promise((r) => setTimeout(r, 0))
    expect(heard).toHaveLength(1)
  })

  it('keeps recording when a listener throws', async () => {
    const off = onSpendRecorded(() => {
      throw new Error('boom')
    })
    await expect(recordSpend(event)).resolves.toBeUndefined()
    off()
  })
})
