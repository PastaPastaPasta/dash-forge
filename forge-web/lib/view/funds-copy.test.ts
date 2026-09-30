/**
 * Funds and cost copy (QA wave bonsia): no dollar value for test DASH (QW-046), a price that is
 * still an upper bound says so (QW-043), and a repo's creation is listed under the repo in
 * Settings → Spend (QW-054).
 */

import { describe, expect, it } from 'vitest'

import { firstWriteRead, previewCreate, STEADY } from '../sdk/cost'
import { repairRepo, spendKindLabel, summarize, type SpendRow } from '../spend'
import { dashToUsd, dashValueNote, priceLabel } from './format'

describe('USD only on mainnet (QW-046)', () => {
  it('devnet and testnet DASH has no dollar figure', () => {
    expect(dashToUsd(1, 'devnet')).toBeNull()
    expect(dashToUsd(1, 'testnet')).toBeNull()
    expect(dashValueNote(0.19, 'devnet')).toBe('test DASH, no cash value')
  })

  it('mainnet keeps its estimate', () => {
    expect(dashToUsd(1, 'mainnet')).toBe('$30.00')
    expect(dashValueNote(1, 'mainnet')).toBe('≈ $30.00')
  })
})

describe('an upper-bound price says so (QW-043)', () => {
  it('"≤" until the first-write reads answer, "~" after', () => {
    const unread = previewCreate('star', {}, {})
    const read = previewCreate('star', {}, STEADY)
    expect(firstWriteRead({})).toBe(false)
    expect(firstWriteRead(STEADY)).toBe(true)
    expect(priceLabel(unread.credits, !firstWriteRead({}))).toMatch(/^≤0\.000/)
    expect(priceLabel(read.credits, !firstWriteRead(STEADY))).toMatch(/^~0\.000/)
    // The bound is never below the exact figure it later becomes.
    expect(unread.credits).toBeGreaterThanOrEqual(read.credits)
  })
})

describe("a repo's creation is listed under the repo (QW-054)", () => {
  const CORE = '6SbihK14KP8RhUpSH4Tc6WNvWKziWEoAbkNZmi7RadwJ'
  const REPO = 'C8XSf6R4shR1kqFKUZQnuaEZ5DkW7uoe9qtQYZpS5SRd'
  const row = (over: Partial<SpendRow>): SpendRow => ({
    identityId: 'me',
    network: 'devnet',
    kind: 'create:config',
    repo: REPO,
    documentId: 'doc',
    estimateCredits: 10,
    actualCredits: 10,
    at: 1,
    ...over,
  })

  it("an older row that named forge-core's id reads as the repo's own", () => {
    const old = row({ kind: 'create:repo', repo: CORE, documentId: REPO })
    expect(repairRepo(old).repo).toBe(REPO)
    const s = summarize([old, row({})].map(repairRepo))
    expect(s.byRepo.map((r) => r.repo)).toEqual([REPO])
    expect(s.byRepo[0]!.writes).toBe(2)
  })

  it('leaves every other row alone', () => {
    const r = row({})
    expect(repairRepo(r)).toBe(r)
    expect(spendKindLabel('create:repo')).toBe('Create repo')
  })
})
