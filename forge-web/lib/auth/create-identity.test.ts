/**
 * L-06: an IdentityCreate whose answer cannot be verified ("Quorum not found in cache" after the
 * broadcast) must not end as "Failed to create identity" when Platform recorded it. The chain is
 * a fake: the create "lands" (or not) and then throws the stale-quorum error wasm-sdk raises; the
 * flow must renew the connection first, then probe what happened.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvoSDK } from '@dashevo/evo-sdk'

import { idbPut, resetMemoryStores } from '../idb'
import type { GroupTrust } from '../deployments'
import {
  CREATE_MIN_LOCK_CREDITS,
  IdentityNotCreatedError,
  createIdentityFromMnemonic,
  createOutcomeUnknown,
  readCreationJournal,
  remainingLockCredits,
  type CreationJournal,
} from './create-identity'
import { encodeWif } from './wif'

const IDENTITY = '4EfA9Jrvv3nnCFdSf7fad59851iiTRZ6Wcu6YVJ4iSeF'
const OUTPOINT = new Uint8Array(36).fill(9)
const GROUP = 'GroupGroupGroupGroupGroupGroupGroupGroupGrou'
const STALE = new Error(
  'Failed to create identity: Proof verification error: context provider error: invalid quorum: Quorum not found in cache for hash 00ab',
)

/** The browser key this run generates (a real WIF, so `controlsKey` can decode it). */
const BROWSER_WIF = vi.hoisted(() => ({ value: '' }))
BROWSER_WIF.value = encodeWif(new Uint8Array(32).fill(3), 'devnet')

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
    toWIF: () => BROWSER_WIF.value,
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
      if (chain.readsFailAfterVerify) chain.fetchFails = true
      if (chain.verifyFails) throw new Error(chain.verifyFails)
      if (chain.key5 !== 'ours') throw new real.UnusableLimitedKeyError('the stored private key does not control key 5')
      if (chain.key5Expired) throw new real.UnusableLimitedKeyError('key 5 has expired')
      return limits
    },
    // Production registers the renewed key under a new id (the old key 5 is disabled).
    registerLimitedKey: async (_sdk: unknown, p: { replaceKeyId?: number }) => {
      renewed.calls.push(p)
      return { keyId: 6, wif: 'RENEWED-WIF', limits }
    },
  }
})

/** The fake chain. */
const chain = vi.hoisted(() => ({
  exists: false,
  /** Whose key 5 the identity carries once created. */
  key5: 'ours' as 'ours' | 'earlier',
  lock: 'unused' as 'unused' | 'fully' | 'partly' | 'tree' | 'throws' | 'two',
  /** Credits left in a partly used lock. */
  remaining: 0n,
  /** What `identities.create` does before it throws (or not). */
  create: 'lands-then-stale' as 'lands-then-stale' | 'refused-then-stale' | 'timeout' | 'no-addresses' | 'refused' | 'ok',
  /** Reads of the identity that answer "not found" after it exists (a lagging node). */
  lag: 0,
  fetchFails: false,
  balanceFails: false,
  /** verifyLimitedKey fails with this message (a transient failure), when set. */
  verifyFails: '',
  /** Our key 5 is on the identity but has expired (a definite "cannot be used"). */
  key5Expired: false,
  /** Identity reads do not show key 5 (a node behind). */
  key5Hidden: false,
  /** Identity reads fail from the key check on. */
  readsFailAfterVerify: false,
  /** Aborts this controller on the first probe read. */
  abortOnProbe: null as AbortController | null,
  events: [] as string[],
}))

/** bincode 2 varint, big-endian (a u64 marker for anything past one byte). */
function varint(n: bigint): number[] {
  if (n <= 250n) return [Number(n)]
  const [marker, width] = n <= 0xffffn ? [251, 2] : n <= 0xffffffffn ? [252, 4] : [253, 8]
  const out = [marker]
  for (let i = width - 1; i >= 0; i--) out.push(Number((n >> BigInt(i * 8)) & 0xffn))
  return out
}

/**
 * Golden vector: rs-dpp 6c95cd8 `AssetLockValue::new(3_000_000_000, <P2PKH script>, 2_900_000_000,
 * vec![Bytes32([7; 32])], PlatformVersion::latest()).serialize_to_bytes()`, printed by a scratch
 * Rust test against the workspace's dash-sdk (v4.2.0-beta.5).
 */
const GOLDEN_ASSET_LOCK_VALUE =
  '00fcb2d05e001976a914111111111111111111111111111111111111111188acfcacda7d00010707070707070707070707070707070707070707070707070707070707070707'

/** rs-dpp `AssetLockValue::V0` bytes, as Platform stores a partly used lock. */
function assetLockValue(initial: bigint, remaining: bigint): Uint8Array {
  const script = new Array(25).fill(0x76)
  return Uint8Array.from([0, ...varint(initial), ...varint(BigInt(script.length)), ...script, ...varint(remaining), 1, ...new Array(32).fill(7)])
}

function fakeSdk(): EvoSDK {
  return {
    identities: {
      balance: async () => {
        if (chain.balanceFails) throw new Error('no available addresses to retry')
        return chain.exists ? 10n : undefined
      },
      fetch: async () => {
        chain.events.push('fetch')
        if (chain.abortOnProbe) {
          chain.abortOnProbe.abort()
          return undefined
        }
        if (chain.fetchFails) throw new Error('no available addresses to retry')
        if (!chain.exists) return undefined
        if (chain.lag > 0) {
          chain.lag--
          return undefined
        }
        return { publicKeys: chain.key5Hidden ? [] : [{ keyId: 5, validatePrivateKey: () => chain.key5 === 'ours' }] }
      },
      create: async () => {
        chain.events.push('create')
        if (chain.create === 'ok') {
          chain.exists = true
          return
        }
        if (chain.create === 'refused') throw new Error('Failed to create identity: invalid signature')
        if (chain.create === 'timeout') throw new Error('Failed to create identity: Dapi client error: transport error: deadline exceeded')
        if (chain.create === 'no-addresses') throw new Error('Failed to create identity: no available addresses to retry, last error: x')
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
        if (chain.lock === 'throws') throw new Error('no available addresses to retry')
        if (chain.lock === 'unused') return [{}]
        if (chain.lock === 'tree') return [{ elementType: 'tree' }]
        if (chain.lock === 'two') return [{}, {}]
        if (chain.lock === 'partly') return [{ elementType: 'item', valueBytes: assetLockValue(3_000_000_000n, chain.remaining) }]
        return [{ elementType: 'item', valueBytes: new Uint8Array(0) }]
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

function run(
  overrides: {
    freshen?: () => Promise<unknown>
    signal?: AbortSignal
    heldKey?: (id: string) => Promise<{ keyId: number; wif: string } | null>
  } = {},
) {
  const persisted: { keyId: number; wif: string }[] = []
  const charges: string[] = []
  const stages: string[] = []
  const freshen =
    overrides.freshen ??
    (async () => {
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
    signal: overrides.signal,
    heldKey: overrides.heldKey,
  })
  return { promise, persisted, charges, stages }
}

beforeEach(async () => {
  resetMemoryStores()
  Object.assign(chain, {
    exists: false,
    key5: 'ours',
    lock: 'unused',
    remaining: 0n,
    create: 'lands-then-stale',
    lag: 0,
    fetchFails: false,
    balanceFails: false,
    verifyFails: '',
    key5Expired: false,
    key5Hidden: false,
    readsFailAfterVerify: false,
    abortOnProbe: null,
    events: [],
  })
  renewed.calls = []
  await idbPut('journal', 'create-identity:devnet', JOURNAL)
})

describe('IdentityCreate with a stale quorum after the broadcast (L-06)', () => {
  it('renews the connection before the create', async () => {
    chain.create = 'ok'
    const { promise } = run()
    await expect(promise).resolves.toMatchObject({ identityId: IDENTITY })
    expect(chain.events).toEqual(['freshen', 'create'])
  })

  it('the identity landed: the flow finishes instead of failing', async () => {
    // One lagging node first: the probe keeps reading.
    chain.lag = 2
    const { promise, persisted, charges, stages } = run()
    const out = await promise
    expect(out).toEqual({ identityId: IDENTITY, key: { keyId: 5, wif: BROWSER_WIF.value, limits: expect.anything() } })
    expect(persisted).toEqual([{ keyId: 5, wif: BROWSER_WIF.value }])
    expect(charges).toEqual(['identity:create'])
    expect(stages).toContain('Checking whether Platform recorded your identity…')
    // Nothing was renewed and nothing was sent twice.
    expect(renewed.calls).toEqual([])
    expect(chain.events.filter((e) => e === 'create')).toHaveLength(1)
    // The journal keeps the identity id until the caller adopts the key.
    expect((await readCreationJournal('devnet'))?.identityId).toBe(IDENTITY)
  })

  it('an earlier attempt landed with its own key 5: the master key renews it', async () => {
    chain.key5 = 'earlier'
    const { promise, persisted } = run()
    const out = await promise
    expect(out.key.wif).toBe('RENEWED-WIF')
    expect(renewed.calls).toEqual([expect.objectContaining({ replaceKeyId: 5 })])
    expect(out.key.keyId).toBe(6)
    expect(persisted.at(-1)).toEqual(expect.objectContaining({ keyId: 6, wif: 'RENEWED-WIF' }))
  })

  it('M1: landed, but the key check fails transiently: no paid renewal, a named error', async () => {
    chain.verifyFails = 'no available addresses to retry, last error: x'
    await expect(run().promise).rejects.toThrow(/was created, but this browser's key could not be checked \(no available addresses/)
    expect(renewed.calls).toEqual([])
  })

  it('M1: landed, the key check fails, and the identity cannot be read again: no renewal', async () => {
    chain.verifyFails = 'key 5 is not on identity x'
    chain.readsFailAfterVerify = true
    await expect(run().promise).rejects.toThrow(/browser's key could not be checked/)
    expect(renewed.calls).toEqual([])
  })

  it('M1: "Try again" after a transient key-check failure keeps the stored key, no renewal', async () => {
    chain.verifyFails = 'no available addresses to retry, last error: x'
    const first = run()
    await expect(first.promise).rejects.toThrow(/could not be checked/)
    const stored = first.persisted.at(-1)!
    // The retry: the identity exists now; the key this browser stored is on it.
    chain.verifyFails = ''
    chain.create = 'ok'
    chain.events = []
    const second = run({ heldKey: async (id) => (id === IDENTITY ? stored : null) })
    const out = await second.promise
    expect(out.key).toEqual({ keyId: 5, wif: BROWSER_WIF.value, limits: expect.anything() })
    expect(renewed.calls).toEqual([])
    expect(chain.events).not.toContain('create')
  })

  it('L-06: the sheet reopened later, the identity exists and the stored key 5 is its key: no renewal', async () => {
    // A new sheet: no key of this run in memory; heldKey reads the vault (storedKeyFor).
    chain.exists = true
    const vault: { identityId: string; keyId: number; wif: string }[] = [{ identityId: IDENTITY, keyId: 5, wif: BROWSER_WIF.value }]
    const out = await run({ heldKey: async (id) => vault.find((v) => v.identityId === id) ?? null }).promise
    expect(out.key).toEqual({ keyId: 5, wif: BROWSER_WIF.value, limits: expect.anything() })
    expect(renewed.calls).toEqual([])
  })

  it('L-06: the sheet reopened, the stored key 5 is ours but expired: renews instead of a retry that cannot succeed', async () => {
    chain.exists = true
    chain.key5Expired = true
    const out = await run({ heldKey: async () => ({ keyId: 5, wif: BROWSER_WIF.value }) }).promise
    expect(out.key.keyId).toBe(6)
    expect(renewed.calls).toHaveLength(1)
  })

  it('L-06: a stored key 5 a lagging node does not show yet: "Try again", never a paid renewal', async () => {
    chain.exists = true
    chain.key5Hidden = true
    chain.verifyFails = 'key 5 is not on identity x'
    await expect(run({ heldKey: async () => ({ keyId: 5, wif: BROWSER_WIF.value }) }).promise).rejects.toThrow(/could not be checked/)
    expect(renewed.calls).toEqual([])
  })

  it('L-06: the stored key is not a Forge key (a wallet key) with grants beside it: the renewal disables them all', async () => {
    chain.exists = true
    chain.key5Expired = true
    const out = await run({ heldKey: async () => ({ keyId: 5, wif: BROWSER_WIF.value, alsoHeld: [{ keyId: 6, wif: 'GRANT' }] }) }).promise
    expect(out.key.keyId).toBe(6)
    expect(renewed.calls[0]).toMatchObject({ disableHeld: [{ keyId: 5, wif: BROWSER_WIF.value }, { keyId: 6, wif: 'GRANT' }] })
  })

  it('L-06: the sheet reopened, the identity exists, no stored key opens: renews (paid) as before', async () => {
    chain.exists = true
    const out = await run({ heldKey: async () => null }).promise
    expect(out.key.keyId).toBe(6)
    expect(renewed.calls).toHaveLength(1)
  })

  it('M1: "Try again" when the identity exists but holds another key 5: renews it', async () => {
    chain.exists = true
    chain.key5 = 'earlier'
    const out = await run({ heldKey: async () => ({ keyId: 5, wif: BROWSER_WIF.value }) }).promise
    expect(out.key.keyId).toBe(6)
    expect(renewed.calls).toHaveLength(1)
  })

  it('M1: "Try again" with a held key whose check fails transiently: a named error, no renewal', async () => {
    chain.exists = true
    chain.verifyFails = 'no available addresses to retry, last error: x'
    await expect(run({ heldKey: async () => ({ keyId: 5, wif: BROWSER_WIF.value }) }).promise).rejects.toThrow(/could not be checked/)
    expect(renewed.calls).toEqual([])
  })

  it('it did not land and the lock is unused: IdentityNotCreatedError, and a retry reuses the lock', async () => {
    chain.create = 'refused-then-stale'
    const first = run()
    const err = await first.promise.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IdentityNotCreatedError)
    expect((err as IdentityNotCreatedError).retryable).toBe(true)
    expect((err as Error).message).toMatch(/shows no record of identity .* yet/)
    expect((err as Error).message).toMatch(/Try again with the same deposit/)
    expect((err as Error).message).not.toMatch(/nothing new to pay/)
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
    await expect(promise).rejects.toThrow(/^Could not confirm whether identity .* was created/)
  })

  it('the lock is fully used but no identity is visible: unknown, never a same-deposit offer', async () => {
    chain.create = 'refused-then-stale'
    chain.lock = 'fully'
    const err = await run().promise.catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(IdentityNotCreatedError)
    expect((err as Error).message).toMatch(/^Could not confirm whether identity .* was created/)
    expect((err as Error).message).not.toMatch(/same deposit/)
  })

  it('the lock read fails: unknown', async () => {
    chain.create = 'refused-then-stale'
    chain.lock = 'throws'
    const err = await run().promise.catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(IdentityNotCreatedError)
    expect((err as Error).message).toMatch(/^Could not confirm/)
  })

  it('the lock read returns other than one element: unknown', async () => {
    chain.create = 'refused-then-stale'
    chain.lock = 'two'
    const err = await run().promise.catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(IdentityNotCreatedError)
    expect((err as Error).message).toMatch(/^Could not confirm/)
  })

  it('"no available addresses" gets the long probe, like a transport error', async () => {
    chain.create = 'refused-then-stale'
    await run().promise.catch(() => undefined)
    const answered = chain.events.filter((e) => e === 'fetch').length
    chain.events = []
    chain.create = 'no-addresses'
    await run().promise.catch(() => undefined)
    expect(chain.events.filter((e) => e === 'fetch').length).toBeGreaterThan(answered)
  })

  it('the lock element is not an item: unknown', async () => {
    chain.create = 'refused-then-stale'
    chain.lock = 'tree'
    const err = await run().promise.catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(IdentityNotCreatedError)
  })

  it('M2: a partly used lock with enough left: says a fee was kept, retry warns it may cost again', async () => {
    chain.create = 'refused-then-stale'
    chain.lock = 'partly'
    chain.remaining = 2_900_000_000n
    const err = (await run().promise.catch((e: unknown) => e)) as IdentityNotCreatedError
    expect(err).toBeInstanceOf(IdentityNotCreatedError)
    expect(err.retryable).toBe(true)
    expect(err.message).toMatch(/An attempt with this deposit was rejected and Platform kept a fee; 0\.02900 DASH remains/)
    expect(err.message).toMatch(/keeps another fee/)
  })

  it('M2: a partly used lock with too little left: no retry with it', async () => {
    chain.create = 'refused-then-stale'
    chain.lock = 'partly'
    chain.remaining = CREATE_MIN_LOCK_CREDITS - 1n
    const err = (await run().promise.catch((e: unknown) => e)) as IdentityNotCreatedError
    expect(err).toBeInstanceOf(IdentityNotCreatedError)
    expect(err.retryable).toBe(false)
    expect(err.message).toMatch(/cannot succeed/)
  })

  it('an abort while the probe waits: AbortError, not "not created"', async () => {
    chain.create = 'refused-then-stale'
    const abort = new AbortController()
    chain.abortOnProbe = abort
    const err = await run({ signal: abort.signal }).promise.catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(IdentityNotCreatedError)
    expect((err as DOMException).name).toBe('AbortError')
  })

  it('an abort during the connection renewal: nothing is broadcast', async () => {
    chain.create = 'ok'
    const abort = new AbortController()
    const err = await run({
      signal: abort.signal,
      freshen: async () => {
        abort.abort()
        return true
      },
    }).promise.catch((e: unknown) => e)
    expect((err as DOMException).name).toBe('AbortError')
    expect(chain.events).not.toContain('create')
  })

  it('a transport error reads the identity longer than a stale-quorum error does', async () => {
    chain.create = 'refused-then-stale'
    await run().promise.catch(() => undefined)
    const answered = chain.events.filter((e) => e === 'fetch').length
    chain.events = []
    chain.create = 'timeout'
    await run().promise.catch(() => undefined)
    expect(chain.events.filter((e) => e === 'fetch').length).toBeGreaterThan(answered)
  })

  it('a stale-quorum error renews the connection before the probe reads', async () => {
    chain.create = 'refused-then-stale'
    await run().promise.catch(() => undefined)
    expect(chain.events.slice(0, 4)).toEqual(['freshen', 'create', 'freshen', 'fetch'])
  })

  it('L5: a failing existence check before the create is not "no identity"', async () => {
    chain.balanceFails = true
    await expect(run().promise).rejects.toThrow(/Could not check whether identity .* already exists/)
    expect(chain.events).not.toContain('create')
  })

  it('an error that says nothing about the outcome is reported as it is', async () => {
    chain.create = 'refused'
    await expect(run().promise).rejects.toThrow(/^Failed to create identity: invalid signature$/)
    expect(chain.events).not.toContain('fetch')
  })

  it('a failed renewal does not stop the create', async () => {
    chain.create = 'ok'
    const { promise } = run({ freshen: async () => false })
    await expect(promise).resolves.toMatchObject({ identityId: IDENTITY })
  })
})

describe('remainingLockCredits', () => {
  it('matches the bytes rs-dpp writes (golden vector, u32 varints)', () => {
    const bytes = Uint8Array.from(Buffer.from(GOLDEN_ASSET_LOCK_VALUE, 'hex'))
    expect(remainingLockCredits(bytes)).toBe(2_900_000_000n)
    // The helper this suite builds values with writes the same bytes.
    const script = [0x76, 0xa9, 0x14, ...new Array(20).fill(0x11), 0x88, 0xac]
    const built = Uint8Array.from([0, ...varint(3_000_000_000n), ...varint(25n), ...script, ...varint(2_900_000_000n), 1, ...new Array(32).fill(7)])
    expect(Buffer.from(built).toString('hex')).toBe(GOLDEN_ASSET_LOCK_VALUE)
  })

  it('reads remaining_credit_value from AssetLockValue::V0', () => {
    expect(remainingLockCredits(assetLockValue(3_000_000_000n, 2_900_000_000n))).toBe(2_900_000_000n)
    expect(remainingLockCredits(assetLockValue(200n, 7n))).toBe(7n)
  })
  it('is null for anything else', () => {
    expect(remainingLockCredits(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(remainingLockCredits(new Uint8Array([0, 253, 1]))).toBeNull()
  })
})

describe('createOutcomeUnknown', () => {
  it.each([
    STALE.message,
    'no available addresses to retry, last error: x',
    'SDK operation timeout 30 secs reached: wait',
    'Failed to create identity: Dapi client error: transport error: deadline exceeded',
    'Asset lock transaction ab output 0 already completely used',
    'Identity 4Ef… already exists',
  ])('open outcome: %s', (m) => {
    expect(createOutcomeUnknown(new Error(m))).toBe(true)
  })
  it.each(['invalid signature', 'Failed to create identity: Protocol error: insufficient balance'])('definite refusal: %s', (m) => {
    expect(createOutcomeUnknown(new Error(m))).toBe(false)
  })
})
