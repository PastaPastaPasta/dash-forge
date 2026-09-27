/**
 * D-044: Forge's own identity updates reach the spend ledger. Registering, renewing, topping up
 * and revoking this browser's key are paid from the identity balance (Platform meters them:
 * storage + processing, no flat fee), so each is reported with the balance change it caused,
 * measured as document writes are (`write.ts` `measureActual`). Without these rows the
 * reconciliation line counts Forge's own key updates as "unexplained (other apps or keys)".
 *
 * The chain is a fake whose balance drops when an update is "sent"; the vault is the real one
 * (in-memory IndexedDB).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvoSDK } from '@dashevo/evo-sdk'

import { resetMemoryStores } from '../idb'
import { readBaseline, readLedger, reconcile, recordSpend, spendKindLabel, summarize, NO_REPO } from '../spend'
import type { SpendEvent } from '../sdk/write'
import { AuthController, KEY_SPEND_ESTIMATES } from './controller'
import { encodeWif } from './wif'
import { lockVault } from './vault'

const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const NET = 'devnet' as const
const wifOf = (n: number): string => encodeWif(new Uint8Array(32).fill(n), NET)
const PASS = { passphrase: 'correct horse battery' }

// What each fake update costs, and the chain's balance (credits).
const chain = vi.hoisted(() => ({ balance: 0n, cost: { register: 0n, topup: 0n, revoke: 0n }, fail: false, revoked: false }))

vi.mock('../sdk/write', async (orig) => {
  const real = await orig<typeof import('../sdk/write')>()
  return {
    ...real,
    findSigningKey: async (identity: { publicKeys: { keyId: number; wif: string }[] }, wif: string) => {
      const k = identity.publicKeys.find((x) => x.wif === wif)
      return k ? { publicKey: {}, keyId: k.keyId, securityLevel: 2 } : null
    },
  }
})
vi.mock('../constants', async (orig) => {
  const real = await orig<typeof import('../constants')>()
  const { DEPLOYMENTS, forgeV2Ids } = await import('../deployments')
  const devnet = { ...real.NETWORKS.devnet, key: 'devnet-moutai', v2: forgeV2Ids(DEPLOYMENTS['devnet-moutai']) }
  return { ...real, NETWORKS: { ...real.NETWORKS, devnet } }
})
vi.mock('./group-trust', () => ({ assertGroupHolds: async () => ({ unknown: [] }) }))
vi.mock('./limited-key', async (orig) => {
  const real = await orig<typeof import('./limited-key')>()
  const limits = { remaining: 5_000_000_000n, total: 5_000_000_000n, expiresAt: Date.now() + 90 * 86_400_000 }
  return {
    ...real,
    registerLimitedKey: async () => {
      if (chain.fail) throw new Error('refused')
      chain.balance -= chain.cost.register
      return { keyId: 5, wif: wifOf(5), limits }
    },
    topUpLimitedKey: async () => {
      chain.balance -= chain.cost.topup
      return { ...limits, total: 10_000_000_000n }
    },
    revokeLimitedKey: async () => {
      // An already disabled key: nothing is sent.
      if (chain.revoked) return false
      chain.balance -= chain.cost.revoke
      chain.revoked = true
      return true
    },
    readKeyLimits: async () => limits,
  }
})
vi.mock('./identity-file', async (orig) => {
  const real = await orig<typeof import('./identity-file')>()
  return { ...real, masterMaterialFromFile: () => ({ identityId: ID, networkKey: 'devnet-moutai', masterWif: 'MASTER', mnemonic: null }) }
})
vi.mock('./key-registration', async (orig) => {
  const real = await orig<typeof import('./key-registration')>()
  return { ...real, keyScope: () => ({ core: true, collab: true, unbounded: false }), hasNoLimits: () => false }
})

describe('key spends reach the ledger (D-044)', () => {
  let controller: AuthController
  let events: SpendEvent[]
  const sdk = {
    identities: {
      fetch: async () => ({
        balance: chain.balance,
        publicKeys: [{ keyId: 5, wif: wifOf(5), purposeNumber: 0, securityLevelNumber: 2, contractBounds: { toJSON: () => ({ $type: 'contractGroup', id: 'G' }) } }],
      }),
      keysRemainingBudgets: async () => new Map(),
    },
  } as unknown as EvoSDK
  const next = (): Promise<SpendEvent> =>
    vi.waitFor(
      () => {
        const e = events.shift()
        if (!e) throw new Error('no spend reported yet')
        return e
      },
      { timeout: 10_000, interval: 20 },
    )

  beforeEach(() => {
    resetMemoryStores()
    lockVault()
    chain.balance = 100_000_000_000n
    chain.cost = { register: 47_111_680n, topup: 2_267_600n, revoke: 12_000_000n }
    chain.fail = false
    chain.revoked = false
    events = []
    controller = new AuthController(async () => sdk, NET)
    controller.setSpendListener((e) => events.push(e))
  })

  it('records a key registration, then a renewal, with the measured balance change', async () => {
    await controller.importIdentity({ fileText: '{}' }, PASS)
    const first = await next()
    expect(first).toMatchObject({
      identityId: ID,
      network: NET,
      kind: 'key:register',
      repo: null,
      documentId: 'key-5',
      estimateCredits: KEY_SPEND_ESTIMATES['key:register'],
      actualCredits: 47_111_680,
      balanceBefore: 100_000_000_000n,
    })
    // A second import for the same identity replaces the stored key: a renewal.
    chain.cost.register = 27_000_000n
    await controller.importIdentity({ fileText: '{}' }, PASS)
    expect(await next()).toMatchObject({ kind: 'key:renew', actualCredits: 27_000_000 })
  }, 30_000)

  it('records a key top-up and a revoke', async () => {
    await controller.importIdentity({ fileText: '{}' }, PASS)
    await next()
    await controller.topUpKey({ fileText: '{}' }, { addCredits: 5_000_000_000n, expiresAt: null })
    expect(await next()).toMatchObject({ kind: 'key:topup', documentId: 'key-5', actualCredits: 2_267_600, estimateCredits: KEY_SPEND_ESTIMATES['key:topup'] })
    await controller.revokeStored(ID, { fileText: '{}' })
    expect(await next()).toMatchObject({ kind: 'key:revoke', documentId: 'key-5', actualCredits: 12_000_000 })
  }, 30_000)

  it('reports nothing for a refused update that took nothing, or a revoke that sent nothing', async () => {
    chain.fail = true
    await expect(controller.importIdentity({ fileText: '{}' }, PASS)).rejects.toThrow('refused')
    expect(events).toEqual([])
    chain.fail = false
    await controller.importIdentity({ fileText: '{}' }, PASS)
    await next()
    chain.revoked = true
    await controller.revokeStored(ID, { fileText: '{}' })
    expect(events).toEqual([])
  }, 30_000)

  it('measures while it still holds the writer lock (a queued write cannot fold into the row)', async () => {
    const { serialized } = await import('../sdk/write')
    const done = controller.importIdentity({ fileText: '{}' }, PASS)
    // A document write queued behind the key update: it runs only after the row is reported.
    await new Promise((r) => setTimeout(r, 0))
    let sawRow = -1
    await serialized(ID, async () => {
      sawRow = events.length
      chain.balance -= 1_000n
    })
    await done
    expect(sawRow).toBe(1)
    expect(events[0]).toMatchObject({ kind: 'key:register', actualCredits: 47_111_680 })
  }, 30_000)

  it('records a paid update made elsewhere (an encryption key) through chargedUpdate', async () => {
    await controller.chargedUpdate(ID, 'key:encryption', async () => {
      chain.balance -= 30_000_000n
      return true
    })
    expect(await next()).toMatchObject({ kind: 'key:encryption', actualCredits: 30_000_000, documentId: 'identity' })
    await controller.chargedUpdate(ID, 'key:encryption', async () => false)
    expect(events).toEqual([])
  }, 30_000)

  it('the recorded key spends reconcile with the balance change (none left unexplained)', async () => {
    controller.setSpendListener((e) => void recordSpend(e).then(() => events.push(e)))
    const start = chain.balance
    await controller.importIdentity({ fileText: '{}' }, PASS)
    await next()
    await controller.topUpKey({ fileText: '{}' }, { addCredits: 5_000_000_000n, expiresAt: null })
    await next()
    const rows = await readLedger(NET, ID)
    const baseline = await readBaseline(NET, ID)
    expect(baseline?.credits).toBe(start)
    const s = summarize(rows)
    expect(s.byRepo).toEqual([{ repo: NO_REPO, credits: 47_111_680 + 2_267_600, writes: 2 }])
    expect(reconcile(s.allTime, baseline!.credits, chain.balance)).toEqual({ balanceChange: 47_111_680 + 2_267_600, unexplained: 0 })
  }, 30_000)
})

describe('spendKindLabel', () => {
  it('reads key actions and document writes in words', () => {
    expect(spendKindLabel('key:topup')).toBe('Top up key budget')
    expect(spendKindLabel('key:register')).toMatch(/Register/)
    expect(spendKindLabel('identity:create')).toBe('Create identity')
    expect(spendKindLabel('key:encryption')).toBe('Register encryption key')
    expect(spendKindLabel('create:issue')).toBe('issue')
    expect(spendKindLabel('create:authorEvent')).toBe('author event')
    expect(spendKindLabel('delete:star')).toBe('delete star')
    expect(spendKindLabel('refused:issue')).toBe('refused issue')
    expect(spendKindLabel('odd')).toBe('odd')
  })
})
