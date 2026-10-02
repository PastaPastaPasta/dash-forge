/**
 * D-016: a browser import or renewal stores the new key (and reads it back) BEFORE the
 * identity update registers it and disables the old key and wallet grants. If this browser
 * cannot keep the key, nothing changes on chain; if the tab dies after the update, the next
 * unlock finishes the renewal from the staged copy.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resetMemoryStores } from '../idb'
import { encodeWif, decodeWif } from './wif'
import { bytesToHex } from '@noble/hashes/utils.js'

const NET = 'devnet' as const
const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const PASS = { passphrase: 'correct horse battery' }
const GROUP = 'G6T1mjQZJ4pqjaraEw71RRSbVasd7JSbgsWfmLUgNhL2'
const wifOf = (n: number): string => encodeWif(new Uint8Array(32).fill(n), NET)

/** What reached the chain: identity updates (added key ids, disabled key ids). */
const chain = vi.hoisted(() => ({
  updates: [] as { add: number[]; disable: number[] }[],
  failUpdate: null as Error | null,
  /** Fail this many updates with this error first (then they go through). */
  failFirst: { times: 0, error: null as Error | null },
  nonceReads: 0,
  budgetsLag: false,
}))

vi.mock('@dashevo/evo-sdk', () => {
  class PK {
    constructor(readonly bytes: Uint8Array) {}
    static fromWIF(wif: string): PK {
      return new PK(decodeWif(wif).privateKey)
    }
    static fromBytes(b: Uint8Array): PK {
      return new PK(new Uint8Array(32).fill(21 + (b[0]! % 3)))
    }
    toBytes(): Uint8Array {
      return new Uint8Array(this.bytes)
    }
    toWIF(): string {
      return encodeWif(this.bytes, 'devnet')
    }
    getPublicKey(): { toBytes(): Uint8Array } {
      return { toBytes: () => this.bytes }
    }
    free(): void {}
  }
  return {
    PrivateKey: PK,
    IdentitySigner: class {
      addKey(): void {}
      free(): void {}
    },
    IdentityPublicKeyInCreation: class {
      constructor(readonly o: { keyId: number; data: Uint8Array; totalBudget: bigint; expiresAt: bigint }) {}
    },
    ContractBounds: { ContractGroup: (id: string) => ({ id }) },
  }
})

interface Key {
  keyId: number
  purposeNumber: number
  securityLevelNumber: number
  disabledAt?: bigint
  totalBudget?: bigint
  expiresAt?: bigint
  contractBounds?: { toJSON(): { $type: string; id: string } }
  validatePrivateKey(bytes: Uint8Array): boolean
}
const keyFor = (keyId: number, bytes: Uint8Array, level: number, extra: Partial<Key> = {}): Key => ({
  keyId,
  purposeNumber: 0,
  securityLevelNumber: level,
  validatePrivateKey: (b) => bytesToHex(b) === bytesToHex(bytes),
  ...extra,
})
const browserKey = (keyId: number, bytes: Uint8Array): Key =>
  keyFor(keyId, bytes, 2, {
    totalBudget: 5_000_000_000n,
    expiresAt: BigInt(Date.now() + 1e9),
    contractBounds: { toJSON: () => ({ $type: 'contractGroup', id: GROUP }) },
  })

let keys: Key[] = []
const sdk = {
  identities: {
    fetch: async () => ({ balance: 10n ** 11n, publicKeys: keys, getPublicKeyById: () => ({}) }),
    // `budgetsLag`: a node that has not seen the new key's remaining budget yet answers with no entry.
    keysRemainingBudgets: async (_id: string, ids: number[]) => (chain.budgetsLag ? new Map() : new Map(ids.map((i) => [i, 5_000_000_000n]))),
    nonce: async () => {
      chain.nonceReads += 1
      return 7n
    },
    update: async (o: { addPublicKeys?: { o: { keyId: number; data: Uint8Array; totalBudget: bigint; expiresAt: bigint } }[]; disablePublicKeys?: number[] }) => {
      if (chain.failFirst.times > 0 && chain.failFirst.error) {
        chain.failFirst.times -= 1
        throw chain.failFirst.error
      }
      if (chain.failUpdate) throw chain.failUpdate
      const add = (o.addPublicKeys ?? []).map((k) => k.o.keyId)
      chain.updates.push({ add, disable: o.disablePublicKeys ?? [] })
      for (const k of o.addPublicKeys ?? []) keys.push({ ...browserKey(k.o.keyId, k.o.data), totalBudget: k.o.totalBudget, expiresAt: k.o.expiresAt })
      for (const id of o.disablePublicKeys ?? []) {
        const k = keys.find((x) => x.keyId === id)
        if (k) k.disabledAt = 1n
      }
    },
  },
} as unknown as EvoSDK

const { IdentityUpdateNotSentError, WrongMasterKeyError, registerLimitedKey, revokeLimitedKey } = await import('./limited-key')
const vault = await import('./vault')
const idb = await import('../idb')

beforeEach(() => {
  resetMemoryStores()
  vault.lockVault()
  chain.updates.length = 0
  chain.failUpdate = null
  chain.failFirst = { times: 0, error: null }
  chain.nonceReads = 0
  chain.budgetsLag = false
  keys = [keyFor(0, decodeWif(wifOf(1)).privateKey, 0), browserKey(5, decodeWif(wifOf(5)).privateKey)]
})

const register = (persist?: (k: { keyId: number; wif: string }) => Promise<void>) =>
  registerLimitedKey(sdk, { network: NET, identityId: ID, masterWif: wifOf(1), group: GROUP, replaceKeyId: 5, groupChecked: true, ...(persist ? { persist } : {}) })

describe('registerLimitedKey stores before it changes the chain (D-016)', () => {
  it('a failed store sends nothing: no fee, the old key still works', async () => {
    await expect(register(async () => Promise.reject(new Error('IndexedDB quota exceeded')))).rejects.toThrow(/quota/)
    expect(chain.updates).toEqual([])
    expect(keys.find((k) => k.keyId === 5)?.disabledAt).toBeUndefined()
  })

  it('stores the exact key it then registers, before the update', async () => {
    const order: string[] = []
    let stored: { keyId: number; wif: string } | null = null
    const key = await register(async (k) => {
      order.push(`store ${k.keyId}`)
      stored = k
      expect(chain.updates).toEqual([])
    })
    order.push(`registered ${chain.updates[0]?.add.join()}`)
    expect(order).toEqual(['store 6', 'registered 6'])
    expect(stored).toEqual({ keyId: key.keyId, wif: key.wif })
    expect(chain.updates).toEqual([{ add: [6], disable: [5] }])
  })

  it("a node that has not seen the new key's budget yet does not leave the session without one (QW4-020)", async () => {
    chain.budgetsLag = true
    const key = await register(async () => undefined)
    const added = keys.find((k) => k.keyId === key.keyId)
    // Nothing was spent with a key registered just now: what is left is its whole budget.
    expect(key.limits.remaining).toBe(added?.totalBudget)
    expect(key.limits.total).toBe(added?.totalBudget)
  })
})

/** wasm-sdk's update() when its nonce read hits a rotated quorum (QW3-007, as seen on bonsia). */
const QUORUM_NONCE = new Error(
  'Failed to get identity nonce: Proof verification error: context provider error: invalid quorum: Quorum not found in cache for hash: 446f75d0',
)

describe('a sign-in during a quorum rotation (QW3-007)', () => {
  it('waits out the rotation like a read and registers on the next try', async () => {
    chain.failFirst = { times: 1, error: QUORUM_NONCE }
    const key = await register(async () => undefined)
    expect(chain.nonceReads).toBe(1)
    expect(chain.updates).toEqual([{ add: [key.keyId], disable: [5] }])
  })

  it('gives up in plain words, sends nothing, and leaves no stored key behind', async () => {
    chain.failFirst = { times: 9, error: QUORUM_NONCE }
    const dropped: number[] = []
    const err = await registerLimitedKey(sdk, {
      network: NET,
      identityId: ID,
      masterWif: wifOf(1),
      group: GROUP,
      replaceKeyId: 5,
      groupChecked: true,
      persist: async () => undefined,
      unpersist: async (k) => {
        dropped.push(k.keyId)
      },
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IdentityUpdateNotSentError)
    expect(String((err as Error).message)).toMatch(/switching to a new quorum.*Nothing was sent and nothing was charged/)
    expect(String((err as Error).message)).not.toMatch(/Proof verification|446f75d0/)
    expect(dropped).toEqual([6])
    expect(chain.updates).toEqual([])
  })

  it('keeps the stored key when the update may have been sent', async () => {
    chain.failUpdate = new Error('Failed to broadcast update: timeout waiting for result')
    const dropped: number[] = []
    await expect(
      registerLimitedKey(sdk, { network: NET, identityId: ID, masterWif: wifOf(1), group: GROUP, groupChecked: true, persist: async () => undefined, unpersist: async (k) => void dropped.push(k.keyId) }),
    ).rejects.toThrow(/broadcast/)
    expect(dropped).toEqual([])
  })
})

describe('a master key of another identity is refused before anything is sent (QW3-028)', () => {
  it('on register and on revoke', async () => {
    await expect(registerLimitedKey(sdk, { network: NET, identityId: ID, masterWif: wifOf(9), group: GROUP, groupChecked: true })).rejects.toBeInstanceOf(WrongMasterKeyError)
    await expect(revokeLimitedKey(sdk, { network: NET, identityId: ID, masterWif: wifOf(9), keyId: 5 })).rejects.toBeInstanceOf(WrongMasterKeyError)
    expect(chain.updates).toEqual([])
    await expect(revokeLimitedKey(sdk, { network: NET, identityId: ID, masterWif: wifOf(1), keyId: 5 })).resolves.toBe(true)
    expect(chain.updates).toEqual([{ add: [], disable: [5] }])
  })
})

const OTHER = { passphrase: 'another passphrase for renew' }

describe('the vault stages and reads back (D-016)', () => {
  it('a staged key does not replace the working one until committed', async () => {
    await vault.storeInVault(NET, { identityId: ID, keyId: 5, wif: wifOf(5) }, PASS)
    await vault.stageInVault(NET, { identityId: ID, keyId: 6, wif: wifOf(22) }, PASS)
    vault.lockVault()
    expect((await vault.unlockWithPassphrase(NET, ID, PASS.passphrase)).keyId).toBe(5)
    expect(await vault.hasStaged(NET, ID)).toBe(true)
    await vault.storeInVault(NET, { identityId: ID, keyId: 6, wif: wifOf(22) }, PASS)
    expect(await vault.hasStaged(NET, ID)).toBe(false)
    vault.lockVault()
    expect((await vault.unlockWithPassphrase(NET, ID, PASS.passphrase)).keyId).toBe(6)
  }, 60_000)

  it('refuses when the browser does not keep what was written', async () => {
    const upd = vi.spyOn(idb, 'idbUpdate').mockImplementation(async () => undefined)
    try {
      await expect(vault.stageInVault(NET, { identityId: ID, keyId: 6, wif: wifOf(22) }, PASS)).rejects.toThrow(/could not keep the new key/)
    } finally {
      upd.mockRestore()
    }
  }, 30_000)

  it('a live staged key is adopted; one never registered is dropped; an unknown one is kept (review 2)', async () => {
    await vault.storeInVault(NET, { identityId: ID, keyId: 5, wif: wifOf(5) }, PASS)
    await vault.stageInVault(NET, { identityId: ID, keyId: 6, wif: wifOf(22) }, PASS)
    vault.lockVault()
    // Not visible yet (a node behind, an update in flight): nothing is deleted.
    expect(await vault.recoverStaged(NET, ID, PASS, async () => 'unknown' as const)).toEqual({ status: 'pending' })
    expect(await vault.hasStaged(NET, ID)).toBe(true)
    // Proven never registered: dropped.
    expect(await vault.recoverStaged(NET, ID, PASS, async () => 'never' as const)).toEqual({ status: 'discarded' })
    expect(await vault.hasStaged(NET, ID)).toBe(false)
    // Live: adopted as the main record.
    await vault.stageInVault(NET, { identityId: ID, keyId: 6, wif: wifOf(22) }, PASS)
    const adopted = await vault.recoverStaged(NET, ID, PASS, async () => 'registered' as const)
    expect(adopted).toMatchObject({ status: 'adopted', secret: { keyId: 6, wif: wifOf(22) } })
    vault.lockVault()
    expect((await vault.unlockWithPassphrase(NET, ID, PASS.passphrase)).keyId).toBe(6)
  }, 120_000)

  it('a first import whose tab closed after staging can still be unlocked (review 1)', async () => {
    await vault.stageInVault(NET, { identityId: ID, keyId: 6, wif: wifOf(22) }, PASS)
    vault.lockVault()
    // Offered for unlock though only the staged record exists.
    expect(await vault.listVaults(NET)).toEqual([expect.objectContaining({ identityId: ID, keyId: 6, staged: true })])
    expect(await vault.onlyStaged(NET, ID)).toBe(true)
    // Unlock opens the staged record; recovery then makes it the main record.
    expect((await vault.unlockWithPassphrase(NET, ID, PASS.passphrase)).keyId).toBe(6)
    expect(await vault.recoverStaged(NET, ID, PASS, async () => 'registered' as const)).toMatchObject({ status: 'adopted', secret: { keyId: 6 } })
    expect(await vault.onlyStaged(NET, ID)).toBe(false)
    expect(await vault.listVaults(NET)).toEqual([expect.not.objectContaining({ staged: true })])
  }, 90_000)

  it('a renewal protected with another passphrase is opened by its own, never falls back (review 3)', async () => {
    await vault.storeInVault(NET, { identityId: ID, keyId: 5, wif: wifOf(5) }, PASS)
    await vault.stageInVault(NET, { identityId: ID, keyId: 6, wif: wifOf(22) }, OTHER)
    vault.lockVault()
    // The old passphrase opens the old record, but not the staged one: say so, change nothing.
    await vault.unlockWithPassphrase(NET, ID, PASS.passphrase)
    expect(await vault.recoverStaged(NET, ID, PASS, async () => 'registered' as const)).toEqual({ status: 'locked' })
    expect(await vault.hasStaged(NET, ID)).toBe(true)
    // The renewal's own passphrase finishes it.
    expect(await vault.recoverStaged(NET, ID, OTHER, async () => 'registered' as const)).toMatchObject({ status: 'adopted', secret: { keyId: 6 } })
  }, 120_000)

  it('a pending stage of another key is never overwritten, and a commit of another key keeps it (review 4)', async () => {
    await vault.stageInVault(NET, { identityId: ID, keyId: 6, wif: wifOf(22) }, PASS)
    await expect(vault.stageInVault(NET, { identityId: ID, keyId: 7, wif: wifOf(23) }, PASS)).rejects.toBeInstanceOf(vault.PendingRenewalError)
    // Another tab commits a different key (a wallet login): the pending stage stays.
    await vault.storeInVault(NET, { identityId: ID, keyId: 9, wif: wifOf(9) }, PASS)
    expect(await vault.hasStaged(NET, ID)).toBe(true)
    // Finishing it would replace key 9, which it was not staged to replace: kept, 9 untouched.
    expect(await vault.recoverStaged(NET, ID, PASS, async () => 'registered' as const)).toEqual({ status: 'conflict' })
    vault.lockVault()
    expect((await vault.unlockWithPassphrase(NET, ID, PASS.passphrase)).keyId).toBe(9)
    // The user chooses to continue without it: it is dropped.
    await vault.abandonStaged(NET, ID)
    expect(await vault.hasStaged(NET, ID)).toBe(false)
  }, 120_000)

  it('a sign-in stored while a renewal is being finished is never overwritten (checked in the transaction)', async () => {
    await vault.storeInVault(NET, { identityId: ID, keyId: 5, wif: wifOf(5) }, PASS)
    await vault.stageInVault(NET, { identityId: ID, keyId: 6, wif: wifOf(22) }, PASS)
    const real = idb.idbUpdate
    const upd = vi.spyOn(idb, 'idbUpdate').mockImplementationOnce(async (...args) => {
      // Another tab stores key 9 after the pre-check, just before the finishing write.
      upd.mockRestore()
      await vault.storeInVault(NET, { identityId: ID, keyId: 9, wif: wifOf(9) }, PASS)
      return real(...args)
    })
    expect(await vault.recoverStaged(NET, ID, PASS, async () => 'registered' as const)).toEqual({ status: 'conflict' })
    vault.lockVault()
    expect((await vault.unlockWithPassphrase(NET, ID, PASS.passphrase)).keyId).toBe(9)
    expect(await vault.hasStaged(NET, ID)).toBe(true)
  }, 120_000)

  it('a finished renewal carries the storage settings over when the old key is unlocked (review 5)', async () => {
    await vault.storeInVault(NET, { identityId: ID, keyId: 5, wif: wifOf(5) }, PASS)
    await vault.writeStorageBlob(NET, ID, { bucket: 'b1' })
    await vault.stageInVault(NET, { identityId: ID, keyId: 6, wif: wifOf(22) }, PASS)
    const r = await vault.recoverStaged(NET, ID, PASS, async () => 'registered' as const)
    expect(r.status === 'adopted' && r.outcome.storageSettingsDropped).toBe(false)
    expect(await vault.readStorageBlob(NET, ID)).toEqual({ bucket: 'b1' })
    vault.lockVault()
    await vault.unlockWithPassphrase(NET, ID, PASS.passphrase)
    expect(await vault.readStorageBlob(NET, ID)).toEqual({ bucket: 'b1' })
  }, 120_000)
})

describe('an import on a browser that cannot keep keys (D-016)', () => {
  it('stops before the chain: the old key stays live and the vault is unchanged', async () => {
    await vault.storeInVault(NET, { identityId: ID, keyId: 5, wif: wifOf(5) }, PASS)
    const upd = vi.spyOn(idb, 'idbUpdate').mockRejectedValue(new DOMException('quota', 'QuotaExceededError'))
    try {
      await expect(
        register((k) => vault.stageInVault(NET, { identityId: ID, keyId: k.keyId, wif: k.wif }, PASS)),
      ).rejects.toThrow(/quota/)
    } finally {
      upd.mockRestore()
    }
    expect(chain.updates).toEqual([])
    vault.lockVault()
    expect((await vault.unlockWithPassphrase(NET, ID, PASS.passphrase)).keyId).toBe(5)
  }, 60_000)
})
