/**
 * L-06: an IdentityCreate whose answer cannot be verified ("Quorum not found in cache" after the
 * broadcast) must not end as "Failed to create identity" when Platform recorded it. The chain is
 * a fake: the create "lands" (or not) and then throws the stale-quorum error wasm-sdk raises; the
 * flow must renew the connection first, then probe what happened.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvoSDK } from '@dashevo/evo-sdk'

import { resetMemoryStores } from '../idb'
import type { GroupTrust } from '../deployments'
import {
  IdentityNotCreatedError,
  createIdentityFromMnemonic,
  createOutcomeUnknown,
  readCreationJournal,
  type CreationJournal,
} from './create-identity'
import { idbPut } from '../idb'

const IDENTITY = '4EfA9Jrvv3nnCFdSf7fad59851iiTRZ6Wcu6YVJ4iSeF'
const OUTPOINT = new Uint8Array(36).fill(9)
const GROUP = 'GroupGroupGroupGroupGroupGroupGroupGroupGrou'
const STALE = new Error(
  'Failed to create identity: Proof verification error: context provider error: invalid quorum: Quorum not found in cache for hash 00ab',
)

vi.mock('@dashevo/evo-sdk', () => {
  class Fake {
    free(): void {}
  }
  class Identity extends Fake {
    constructor(readonly id: string) {
      super()
    }
    addPublicKey(): void {}
  }
  class IdentitySigner extends Fake {
    addKeyFromWif(): void {}
    addKey(): void {}
  }
  class IdentityPublicKey extends Fake {}
  const key = {
    free() {},
    toWIF: () => 'BROWSER-WIF',
    getPublicKey: () => ({ toBytes: () => new Uint8Array(33) }),
  }
  return {
    Identity,
    IdentitySigner,
    IdentityPublicKey,
    ContractBounds: { ContractGroup: (g: string) => ({ group: g }) },
    OutPoint: class extends Fake {},
    PrivateKey: { fromBytes: () => key, fromWIF: () => ({ free() {} }) },
    AssetLockProof: {
      createChainAssetLockProof: () => ({
        createIdentityId: () => ({ toBase58: () => IDENTITY }),
        outPoint: { toBytes: () => OUTPOINT },
      }),
    },
  }
})
vi.mock('./asset-lock', () => ({
  coreEndpoints: () => ({ insight: 'https://insight.invalid' }),
  broadcastTx: async () => undefined,
  obtainLockProof: async () => ({ type: 'chain', txid: 'ab'.repeat(32), height: 100 }),
  currentHeight: async () => 1,
  waitForDeposit: async () => [],
  buildAssetLock: () => {
    throw new Error('the journal already holds the lock')
  },
  wifBytes: () => new Uint8Array(32),
  depositHeld: async () => 0,
}))
vi.mock('./hd', async (orig) => {
  const real = await orig<typeof import('./hd')>()
  return {
    ...real,
    deriveAt: async () => ({ wif: 'WIF', publicKeyHex: '02'.padEnd(66, '0'), address: 'yDepositAddress' }),
    deriveMasterKey: async () => ({ wif: 'MASTER-WIF', publicKeyHex: '', address: '' }),
  }
})
vi.mock('./group-trust', () => ({ assertGroupHolds: async () => ({ unknown: [] }) }))

const renewed = vi.hoisted(() => ({ calls: [] as { replaceKeyId?: number }[] }))
vi.mock('./limited-key', async (orig) => {
  const real = await orig<typeof import('./limited-key')>()
  const limits = { remaining: 5n, total: 5n, expiresAt: Date.now() + 1_000 }
  return {
    ...real,
    verifyLimitedKey: async () => {
      if (chain.key5 !== 'ours') throw new Error('the stored private key does not control key 5')
      return limits
    },
    registerLimitedKey: async (_sdk: unknown, p: { replaceKeyId?: number }) => {
      renewed.calls.push(p)
      return { keyId: 5, wif: 'RENEWED-WIF', limits }
    },
  }
})

/** The fake chain. */
const chain = vi.hoisted(() => ({
  exists: false,
  /** Whose key 5 the identity carries once created. */
  key5: 'ours' as 'ours' | 'earlier',
  lock: 'unused' as 'unused' | 'fully',
  /** What `identities.create` does before it throws (or not). */
  create: 'lands-then-stale' as 'lands-then-stale' | 'refused-then-stale' | 'ok',
  /** Reads of the identity that answer "not found" after it exists (a lagging node). */
  lag: 0,
  fetchFails: false,
  events: [] as string[],
}))

function fakeSdk(): EvoSDK {
  return {
    identities: {
      balance: async () => (chain.exists ? 10n : undefined),
      fetch: async () => {
        chain.events.push('fetch')
        if (chain.fetchFails) throw new Error('no available addresses to retry')
        if (!chain.exists) return undefined
        if (chain.lag > 0) {
          chain.lag--
          return undefined
        }
        return { publicKeys: [] }
      },
      create: async () => {
        chain.events.push('create')
        if (chain.create === 'ok') {
          chain.exists = true
          return
        }
        if (chain.create === 'lands-then-stale') {
          chain.exists = true
          chain.lock = 'fully'
        }
        throw STALE
      },
    },
    system: {
      status: async () => ({ toJSON: () => ({ chain: { coreChainLockedHeight: 100 } }) }),
      pathElements: async (path: Uint8Array[], keys: Uint8Array[]) => {
        chain.events.push('pathElements')
        expect(path).toEqual([Uint8Array.of(72)])
        expect(keys).toEqual([OUTPOINT])
        return [chain.lock === 'unused' ? {} : { elementType: 'item', valueBytes: new Uint8Array(0) }]
      },
    },
  } as unknown as EvoSDK
}

const JOURNAL: CreationJournal = {
  network: 'devnet',
  depositAddress: 'yDepositAddress',
  identityId: null,
  lockTxid: 'ab'.repeat(32),
  lockRaw: '00',
  lockedDuffs: 3_000_000,
  startedAt: 1,
  startHeight: 1,
}

function run(overrides: { freshen?: () => Promise<unknown> } = {}) {
  const persisted: { keyId: number; wif: string }[] = []
  const charges: string[] = []
  const stages: string[] = []
  const freshen = overrides.freshen ?? vi.fn(async () => {
    chain.events.push('freshen')
    return true
  })
  const promise = createIdentityFromMnemonic(fakeSdk(), {
    network: 'devnet',
    mnemonic: 'abandon '.repeat(11) + 'about',
    group: GROUP,
    trust: {} as GroupTrust,
    persistKey: async (_id, k) => {
      persisted.push(k)
    },
    onCharge: (_id, c) => charges.push(c.kind),
    onStage: (s, detail) => stages.push(detail ?? s),
    freshen,
    landedCheckMs: 1,
  })
  return { promise, persisted, charges, stages, freshen }
}

beforeEach(async () => {
  resetMemoryStores()
  Object.assign(chain, { exists: false, key5: 'ours', lock: 'unused', create: 'lands-then-stale', lag: 0, fetchFails: false, events: [] })
  renewed.calls = []
  await idbPut('journal', 'create-identity:devnet', JOURNAL)
})

describe('IdentityCreate with a stale quorum after the broadcast (L-06)', () => {
  it('renews the connection before the create', async () => {
    chain.create = 'ok'
    const { promise } = run()
    await expect(promise).resolves.toMatchObject({ identityId: IDENTITY })
    expect(chain.events.indexOf('freshen')).toBeGreaterThanOrEqual(0)
    expect(chain.events.indexOf('freshen')).toBeLessThan(chain.events.indexOf('create'))
  })

  it('the identity landed: the flow finishes instead of failing', async () => {
    // One lagging node first: the probe keeps reading.
    chain.lag = 2
    const { promise, persisted, charges, stages } = run()
    const out = await promise
    expect(out).toEqual({ identityId: IDENTITY, key: { keyId: 5, wif: 'BROWSER-WIF', limits: expect.anything() } })
    expect(persisted).toEqual([{ keyId: 5, wif: 'BROWSER-WIF' }])
    expect(charges).toEqual(['identity:create'])
    expect(stages).toContain('Checking whether Platform recorded your identity…')
    // Nothing was renewed and nothing was sent twice.
    expect(renewed.calls).toEqual([])
    expect(chain.events.filter((e) => e === 'create')).toHaveLength(1)
    // The journal keeps the identity id until the caller adopts the key.
    expect((await readCreationJournal('devnet'))?.identityId).toBe(IDENTITY)
  })

  it('an earlier attempt landed with its own key 5: the master key renews it', async () => {
    chain.create = 'lands-then-stale'
    chain.key5 = 'earlier'
    const { promise, persisted } = run()
    const out = await promise
    expect(out.key.wif).toBe('RENEWED-WIF')
    expect(renewed.calls).toEqual([expect.objectContaining({ replaceKeyId: 5 })])
    expect(persisted.at(-1)).toEqual(expect.objectContaining({ keyId: 5, wif: 'RENEWED-WIF' }))
  })

  it('it did not land and the lock is unused: IdentityNotCreatedError, and a retry reuses the lock', async () => {
    chain.create = 'refused-then-stale'
    const first = run()
    const err = await first.promise.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IdentityNotCreatedError)
    expect((err as Error).message).toMatch(/same deposit, with nothing new to pay/)
    expect(chain.events).toContain('pathElements')
    // The journal still holds the lock for the retry.
    const journal = await readCreationJournal('devnet')
    expect(journal?.lockTxid).toBe(JOURNAL.lockTxid)
    expect(journal?.lockRaw).toBe(JOURNAL.lockRaw)

    // "Try again": the same lock, a fresh connection, and this time the create lands.
    chain.create = 'ok'
    chain.events = []
    const second = run()
    await expect(second.promise).resolves.toMatchObject({ identityId: IDENTITY })
    expect(chain.events).toEqual(['freshen', 'create'])
  })

  it('neither answer is clear: a named error, never "Failed to create identity" alone', async () => {
    chain.create = 'refused-then-stale'
    chain.fetchFails = true
    const { promise } = run()
    await expect(promise).rejects.toThrow(/Could not confirm whether identity .* was created .*reuses your deposit/)
  })

  it('an error that says nothing about the outcome is reported as it is', async () => {
    const sdk = fakeSdk() as unknown as { identities: { create: () => Promise<void> } }
    sdk.identities.create = async () => {
      throw new Error('Failed to create identity: invalid signature')
    }
    const err = await createIdentityFromMnemonic(sdk as unknown as EvoSDK, {
      network: 'devnet',
      mnemonic: 'abandon '.repeat(11) + 'about',
      group: GROUP,
      trust: {} as GroupTrust,
      persistKey: async () => undefined,
      freshen: async () => true,
      landedCheckMs: 1,
    }).catch((e: unknown) => e)
    expect((err as Error).message).toBe('Failed to create identity: invalid signature')
    expect(chain.events).not.toContain('fetch')
  })

  it('a failed renewal does not stop the create', async () => {
    chain.create = 'ok'
    const { promise } = run({ freshen: async () => false })
    await expect(promise).resolves.toMatchObject({ identityId: IDENTITY })
  })
})

describe('createOutcomeUnknown', () => {
  it('open outcomes', () => {
    for (const m of [
      STALE.message,
      'no available addresses to retry, last error: x',
      'SDK operation timeout 30 secs reached: wait',
      'Failed to create identity: Dapi client error: transport error: deadline exceeded',
      'Asset lock transaction ab output 0 already completely used',
      'Identity 4Ef… already exists',
    ]) {
      expect(createOutcomeUnknown(new Error(m)), m).toBe(true)
    }
  })
  it('definite refusals', () => {
    for (const m of ['invalid signature', 'Failed to create identity: Protocol error: insufficient balance']) {
      expect(createOutcomeUnknown(new Error(m)), m).toBe(false)
    }
  })
})
