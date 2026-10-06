import { afterEach, describe, expect, it, vi } from 'vitest'

const reads: string[][] = []
let operates: string[] = []
vi.mock('../sdk', async (orig) => ({
  ...(await orig<typeof import('../sdk')>()),
  queryDocuments: async (_sdk: unknown, q: { where: [string, string, string[]][] }) => {
    const ids = q.where[0]?.[2] ?? []
    reads.push(ids)
    return ids.flatMap((id) => (id === base58(2) ? [{ $ownerId: id, bot: { operator: base58(1) } }] : id === base58(1) ? [{ $ownerId: id, bot: { operates } }] : []))
  },
}))

const { base58Encode } = await import('../auth/base58')
const base58 = (b: number): string => base58Encode(new Uint8Array(32).fill(b))
const { CLAIM_TTL_MS, readBotOperators, resetBotClaims } = await import('./bots')

describe('readBotOperators', () => {
  afterEach(() => {
    vi.useRealTimers()
    resetBotClaims()
    reads.length = 0
  })

  it('reads the participants, then their operators, at most twice, and keeps the answer for a while', async () => {
    operates = [base58(2)]
    vi.useFakeTimers()
    expect((await readBotOperators({} as never, 'C', [base58(3), base58(2)])).get(base58(2))).toBe(base58(1))
    expect(reads).toHaveLength(2)
    await readBotOperators({} as never, 'C', [base58(3), base58(2)])
    expect(reads).toHaveLength(2)
    // a withdrawn claim shows once the kept answer is old enough
    operates = []
    vi.advanceTimersByTime(CLAIM_TTL_MS + 1)
    expect((await readBotOperators({} as never, 'C', [base58(3), base58(2)])).has(base58(2))).toBe(false)
    expect(reads).toHaveLength(4)
  })
})
