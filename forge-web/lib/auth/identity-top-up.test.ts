/**
 * Topping up an identity from the browser (QW-012): the words must be the identity's, the deposit
 * goes to DIP-13's identity-bound top-up path, a lock is built once and saved before it is sent,
 * a top-up whose answer could not be checked is judged by whether Platform used the lock, and a
 * finished top-up moves to the next index. The chain and Core are fakes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvoSDK } from '@dashevo/evo-sdk'

import { resetMemoryStores } from '../idb'
import { encodeWif } from './wif'
import { prepareTopUp, readTopUpJournal, topUpIdentity, topUpKeyPath } from './identity-top-up'

const NET = 'devnet' as const
const ID = '4EfA9Jrvv3nnCFdSf7fad59851iiTRZ6Wcu6YVJ4iSeF'
const WORDS = Array(12).fill('abandon').join(' ')
const MASTER = vi.hoisted(() => ({ wif: '' }))
MASTER.wif = encodeWif(new Uint8Array(32).fill(4), 'devnet')

const chain = vi.hoisted(() => ({
  wordsMatch: true,
  lock: 'unused' as 'unused' | 'fully',
  topUp: 'ok' as 'ok' | 'stale-landed' | 'refused',
  locksBuilt: 0,
  topUps: 0,
  watched: [] as string[],
}))

vi.mock('@dashevo/evo-sdk', () => ({
  OutPoint: class {
    free(): void {}
  },
  PrivateKey: { fromWIF: () => ({ free() {} }) },
  AssetLockProof: {
    createChainAssetLockProof: () => ({ outPoint: { toBytes: () => new Uint8Array(36).fill(9) } }),
    createInstantAssetLockProof: () => ({ outPoint: { toBytes: () => new Uint8Array(36).fill(9) } }),
  },
}))
vi.mock('./asset-lock', () => ({
  coreEndpoints: () => ({ insight: 'https://insight.invalid' }),
  broadcastTx: async () => undefined,
  obtainLockProof: async () => ({ type: 'chain', txid: 'ab'.repeat(32), height: 100 }),
  currentHeight: async () => 1,
  waitForDeposit: async (_ep: unknown, address: string) => {
    chain.watched.push(address)
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
        if (chain.topUp === 'stale-landed') {
          chain.lock = 'fully'
          throw new Error('Proof verification error: Quorum not found in cache')
        }
        chain.lock = 'fully'
        return 500n
      },
    },
    system: {
      status: async () => ({ toJSON: () => ({ chain: { coreChainLockedHeight: 200 } }) }),
      pathElements: async () => [chain.lock === 'fully' ? { elementType: 'item', valueBytes: new Uint8Array() } : {}],
    },
  } as unknown as EvoSDK
}

beforeEach(() => {
  resetMemoryStores()
  Object.assign(chain, { wordsMatch: true, lock: 'unused', topUp: 'ok', locksBuilt: 0, topUps: 0, watched: [] })
})

describe('the top-up deposit key', () => {
  it("is DIP-13's identity-bound top-up funding path", () => {
    expect(topUpKeyPath('mainnet', 0)).toBe("m/9'/5'/5'/2'/0'/0")
    expect(topUpKeyPath('devnet', 3)).toBe("m/9'/1'/5'/2'/0'/3")
  })

  it("refuses words that are not the identity's, before showing any address", async () => {
    chain.wordsMatch = false
    await expect(prepareTopUp(fakeSdk(), { network: NET, identityId: ID, mnemonic: WORDS })).rejects.toThrow(/not this identity's recovery phrase/)
    await expect(topUpIdentity(fakeSdk(), { network: NET, identityId: ID, mnemonic: WORDS })).rejects.toThrow(/not this identity's/)
    expect(await readTopUpJournal(NET, ID)).toBeUndefined()
    expect(chain.watched).toEqual([])
  })
})

describe('topUpIdentity', () => {
  it('deposit → lock → top-up, then the next top-up uses the next index', async () => {
    expect((await prepareTopUp(fakeSdk(), { network: NET, identityId: ID, mnemonic: WORDS })).address).toBe(`addr:${topUpKeyPath(NET, 0)}`)
    const stages: string[] = []
    const out = await topUpIdentity(fakeSdk(), { network: NET, identityId: ID, mnemonic: WORDS, onStage: (s) => stages.push(s) })
    expect(out.balance).toBe(500n)
    expect(chain.watched).toEqual([`addr:${topUpKeyPath(NET, 0)}`])
    expect(stages).toEqual(['waiting-deposit', 'locking', 'proving', 'topping-up'])
    expect(await readTopUpJournal(NET, ID)).toBeUndefined()
    expect((await prepareTopUp(fakeSdk(), { network: NET, identityId: ID, mnemonic: WORDS })).address).toBe(`addr:${topUpKeyPath(NET, 1)}`)
  })

  it('an answer that could not be checked, with the lock used: done, not a failure', async () => {
    chain.topUp = 'stale-landed'
    const out = await topUpIdentity(fakeSdk(), { network: NET, identityId: ID, mnemonic: WORDS })
    expect(out.balance).toBe(777n)
    expect(await readTopUpJournal(NET, ID)).toBeUndefined()
  })

  it('a refused top-up keeps the lock; trying again sends the same lock, never a second one', async () => {
    chain.topUp = 'refused'
    await expect(topUpIdentity(fakeSdk(), { network: NET, identityId: ID, mnemonic: WORDS })).rejects.toThrow(/"Try again" sends it again/)
    const kept = await readTopUpJournal(NET, ID)
    expect(kept?.lockTxid).toBe('ef'.repeat(32))
    expect(kept?.index).toBe(0)
    chain.topUp = 'ok'
    await topUpIdentity(fakeSdk(), { network: NET, identityId: ID, mnemonic: WORDS })
    expect(chain.locksBuilt).toBe(1)
    expect(chain.watched).toHaveLength(1)
    expect(chain.topUps).toBe(2)
  })

  it('a resumed top-up whose lock Platform already used finishes without sending it again', async () => {
    chain.topUp = 'refused'
    await expect(topUpIdentity(fakeSdk(), { network: NET, identityId: ID, mnemonic: WORDS })).rejects.toThrow()
    // It landed after all (the tab closed before the answer).
    chain.lock = 'fully'
    const out = await topUpIdentity(fakeSdk(), { network: NET, identityId: ID, mnemonic: WORDS })
    expect(out.balance).toBe(777n)
    expect(chain.topUps).toBe(1)
    expect(await readTopUpJournal(NET, ID)).toBeUndefined()
  })
})
