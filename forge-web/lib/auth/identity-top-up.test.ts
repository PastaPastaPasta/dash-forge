/**
 * Topping up an identity from the browser (QW-012): the words must be the identity's, the deposit
 * goes to DIP-13's identity-bound top-up path and the journal is saved before the address is
 * shown, a lock is built once and saved before it is sent, a resumed or unverifiable top-up is
 * judged by whether Platform used the lock, and the next top-up moves to a new address only once
 * this one is seen empty. The chain and Core are fakes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvoSDK } from '@dashevo/evo-sdk'

import { resetMemoryStores } from '../idb'
import { encodeWif } from './wif'
import { discardTopUp, readTopUpJournal, topUpIdentity, topUpKeyPath } from './identity-top-up'

const NET = 'devnet' as const
const ID = '4EfA9Jrvv3nnCFdSf7fad59851iiTRZ6Wcu6YVJ4iSeF'
const WORDS = Array(12).fill('abandon').join(' ')
const MASTER = vi.hoisted(() => ({ wif: '' }))
MASTER.wif = encodeWif(new Uint8Array(32).fill(4), 'devnet')

const chain = vi.hoisted(() => ({
  wordsMatch: true,
  lock: 'unused' as 'unused' | 'fully',
  topUp: 'ok' as 'ok' | 'stale-landed' | 'refused',
  /** What the deposit address still holds after a top-up (null: could not be read). */
  left: 0 as number | null,
  height: 100,
  locksBuilt: 0,
  topUps: 0,
  broadcasts: 0,
  watched: [] as { address: string; from: unknown }[],
}))

vi.mock('@dashevo/evo-sdk', () => ({
  OutPoint: class {
    free(): void {}
    toBytes(): Uint8Array {
      return new Uint8Array(36).fill(9)
    }
  },
  PrivateKey: { fromWIF: () => ({ free() {} }) },
  AssetLockProof: {
    createChainAssetLockProof: () => ({}),
    createInstantAssetLockProof: () => ({}),
  },
}))
vi.mock('./asset-lock', () => ({
  coreEndpoints: () => ({ insight: 'https://insight.invalid' }),
  broadcastTx: async () => {
    chain.broadcasts++
  },
  obtainLockProof: async () => ({ type: 'chain', txid: 'ab'.repeat(32), height: 100 }),
  currentHeight: async () => chain.height,
  depositHeld: async () => {
    if (chain.left === null) throw new Error('unreachable')
    return chain.left
  },
  waitForDeposit: async (_ep: unknown, address: string, _min: number, o: { from: unknown }) => {
    chain.watched.push({ address, from: o.from })
    return [{ txid: 'cd'.repeat(32), vout: 0, satoshis: 2_000_000, scriptPubKey: '' }]
  },
  buildAssetLock: () => {
    chain.locksBuilt++
    return { raw: new Uint8Array([1, 2, 3]), txid: 'ef'.repeat(32), lockedDuffs: 1_999_000 }
  },
  wifBytes: () => new Uint8Array(32),
}))
vi.mock('./hd', async (orig) => ({
  ...(await orig<typeof import('./hd')>()),
  deriveAt: async (_m: string, path: string) => ({ wif: MASTER.wif, publicKeyHex: '', address: `addr:${path}` }),
  deriveMasterKey: async () => ({ wif: MASTER.wif, publicKeyHex: '', address: '' }),
}))
vi.mock('../sdk/service', () => ({ evoSdkService: { ensureFresh: async () => true } }))

function fakeSdk(): EvoSDK {
  return {
    identities: {
      fetch: async () => ({ publicKeys: [{ keyId: 0, validatePrivateKey: () => chain.wordsMatch }] }),
      balance: async () => 777n,
      topUp: async () => {
        chain.topUps++
        if (chain.topUp === 'refused') throw new Error('asset lock transaction not found')
        chain.lock = 'fully'
        if (chain.topUp === 'stale-landed') throw new Error('Proof verification error: Quorum not found in cache')
        return 500n
      },
    },
    system: {
      status: async () => ({ toJSON: () => ({ chain: { coreChainLockedHeight: 200 } }) }),
      pathElements: async () => [chain.lock === 'fully' ? { elementType: 'item', valueBytes: new Uint8Array() } : {}],
    },
  } as unknown as EvoSDK
}

const run = (extra: Partial<Parameters<typeof topUpIdentity>[1]> = {}): ReturnType<typeof topUpIdentity> =>
  topUpIdentity(fakeSdk(), { network: NET, identityId: ID, mnemonic: WORDS, ...extra })

beforeEach(() => {
  resetMemoryStores()
  Object.assign(chain, { wordsMatch: true, lock: 'unused', topUp: 'ok', left: 0, height: 100, locksBuilt: 0, topUps: 0, broadcasts: 0, watched: [] })
})

describe('the top-up deposit key', () => {
  it("is DIP-13's identity-bound top-up funding path", () => {
    expect(topUpKeyPath('mainnet', 0)).toBe("m/9'/5'/5'/2'/0'/0")
    expect(topUpKeyPath('devnet', 3)).toBe("m/9'/1'/5'/2'/0'/3")
  })

  it("refuses words that are not the identity's, before any address is shown or recorded", async () => {
    chain.wordsMatch = false
    const shown: string[] = []
    await expect(run({ onAddress: (a) => shown.push(a) })).rejects.toThrow(/not this identity's recovery phrase/)
    expect(shown).toEqual([])
    expect(await readTopUpJournal(NET, ID)).toBeUndefined()
  })

  it('the address is shown only once the journal (and the watch start) is recorded', async () => {
    let recorded: unknown = 'not checked'
    await run({ onAddress: () => void readTopUpJournal(NET, ID).then((j) => (recorded = j?.startHeight)) })
    await Promise.resolve()
    expect(recorded).toBe(100)
  })
})

describe('topUpIdentity', () => {
  it('deposit → lock → top-up; the next top-up uses the next index once this address is empty', async () => {
    const stages: string[] = []
    const shown: [string, boolean][] = []
    const out = await run({ onStage: (s) => stages.push(s), onAddress: (a, l) => shown.push([a, l]) })
    expect(out.balance).toBe(500n)
    expect(shown).toEqual([[`addr:${topUpKeyPath(NET, 0)}`, false]])
    expect(stages).toEqual(['waiting-deposit', 'locking', 'proving', 'topping-up'])
    expect(await readTopUpJournal(NET, ID)).toBeUndefined()
    chain.lock = 'unused'
    chain.height = 150
    await run()
    expect(chain.watched[1]).toEqual({ address: `addr:${topUpKeyPath(NET, 1)}`, from: 150 })
  })

  it('money left at the address (a second payment): the next top-up reuses it and watches from the same height', async () => {
    chain.left = 3_000_000
    await run()
    chain.lock = 'unused'
    chain.height = 150
    await run()
    expect(chain.watched[1]).toEqual({ address: `addr:${topUpKeyPath(NET, 0)}`, from: 100 })
  })

  it('an address that could not be read is treated as not empty (never stranded)', async () => {
    chain.left = null
    await run()
    chain.lock = 'unused'
    await run()
    expect(chain.watched[1]!.address).toBe(`addr:${topUpKeyPath(NET, 0)}`)
  })

  it('an answer that could not be checked, with the lock used: done, not a failure', async () => {
    chain.topUp = 'stale-landed'
    expect((await run()).balance).toBe(777n)
    expect(await readTopUpJournal(NET, ID)).toBeUndefined()
  })

  it('a refused top-up keeps the lock; trying again sends the same lock, never a second one, and shows it locked', async () => {
    chain.topUp = 'refused'
    await expect(run()).rejects.toThrow(/"Try again" sends it again/)
    expect((await readTopUpJournal(NET, ID))?.lockTxid).toBe('ef'.repeat(32))
    chain.topUp = 'ok'
    const shown: boolean[] = []
    await run({ onAddress: (_a, locked) => shown.push(locked) })
    expect(shown).toEqual([true])
    expect(chain.locksBuilt).toBe(1)
    expect(chain.watched).toHaveLength(1)
    expect(chain.topUps).toBe(2)
  })

  it('a resumed top-up whose lock Platform already used finishes before sending or proving anything', async () => {
    chain.topUp = 'refused'
    await expect(run()).rejects.toThrow()
    const sent = chain.broadcasts
    chain.lock = 'fully'
    expect((await run()).balance).toBe(777n)
    expect(chain.broadcasts).toBe(sent)
    expect(chain.topUps).toBe(1)
    expect(await readTopUpJournal(NET, ID)).toBeUndefined()
  })

  it('giving up keeps the address for the next top-up (whatever is unspent there is swept)', async () => {
    chain.topUp = 'refused'
    await expect(run()).rejects.toThrow()
    await discardTopUp(NET, ID)
    expect(await readTopUpJournal(NET, ID)).toBeUndefined()
    chain.topUp = 'ok'
    chain.height = 300
    await run()
    expect(chain.watched[1]).toEqual({ address: `addr:${topUpKeyPath(NET, 0)}`, from: 100 })
  })
})
