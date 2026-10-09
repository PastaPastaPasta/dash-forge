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
import { cachedDpnsName, clearDpnsCache } from '../view/dpns'

const ID = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const NET = 'devnet' as const
const wifOf = (n: number): string => encodeWif(new Uint8Array(32).fill(n), NET)
const PASS = { passphrase: 'correct horse battery' }

// What each fake update costs, and the chain's balance (credits).
const chain = vi.hoisted(() => ({ balance: 0n, cost: { register: 0n, topup: 0n, revoke: 0n }, fail: false, revoked: false, nextKeyId: 5, registered: [] as Record<string, unknown>[] }))
/** #452: the DPNS names this fake chain holds (normalized label -> identity), and what a registration does. */
const dpns = vi.hoisted(() => ({ holders: new Map<string, string>(), cost: 72_600_000n, lostAnswer: false, winner: null as string | null, sent: [] as { label: string; wifs: readonly string[] }[] }))

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
    registerLimitedKey: async (_sdk: unknown, params: Record<string, unknown>) => {
      if (chain.fail) throw new Error('refused')
      chain.registered.push(params)
      chain.balance -= chain.cost.register
      return { keyId: chain.nextKeyId, wif: wifOf(chain.nextKeyId), limits }
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
vi.mock('./username-register', async (orig) => {
  const real = await orig<typeof import('./username-register')>()
  return {
    ...real,
    registerUsername: async (_sdk: unknown, p: { identityId: string; label: string; wifs: readonly string[] }) => {
      dpns.sent.push({ label: p.label, wifs: p.wifs })
      chain.balance -= dpns.cost
      dpns.holders.set(p.label.toLowerCase(), dpns.winner ?? p.identityId)
      if (dpns.lostAnswer) throw new Error('timed out waiting for the domain document result')
    },
  }
})
vi.mock('../view/dpns', async (orig) => {
  const real = await orig<typeof import('../view/dpns')>()
  return { ...real, dpnsLabelHolder: async (_sdk: unknown, label: string) => dpns.holders.get(label.toLowerCase()) ?? null }
})
vi.mock('./key-registration', async (orig) => {
  const real = await orig<typeof import('./key-registration')>()
  return { ...real, keyScope: () => ({ core: true, collab: true, unbounded: false }), hasNoLimits: () => false }
})

describe('key spends reach the ledger (D-044)', () => {
  let controller: AuthController
  let events: SpendEvent[]
  // A fresh connection per test: the write engine remembers, per connection, the balances earlier
  // writes replaced (a read of one is stale), and each test starts the chain over at one balance.
  const connect = (): EvoSDK =>
    ({
      identities: {
        fetch: async () => ({
          balance: chain.balance,
          publicKeys: [{ keyId: 5, wif: wifOf(5), purposeNumber: 0, securityLevelNumber: 2, contractBounds: { toJSON: () => ({ $type: 'contractGroup', id: 'G' }) } }],
        }),
        keysRemainingBudgets: async () => new Map(),
      },
    }) as unknown as EvoSDK
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
    chain.nextKeyId = 5
    chain.registered = []
    events = []
    const sdk = connect()
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

  it('records a CI runner key, which is not stored and leaves this browser signing with its own key', async () => {
    await controller.importIdentity({ fileText: '{}' }, PASS)
    await next()
    chain.nextKeyId = 6
    chain.cost.register = 27_300_000n
    const request = { budgetCredits: 50_000_000_000n, expiresAt: Date.now() + 365 * 86_400_000 }
    const runner = await controller.createRunnerKey({ fileText: '{}' }, request)
    expect(runner.keyId).toBe(6)
    expect(await next()).toMatchObject({ kind: 'key:runner', documentId: 'key-6', actualCredits: 27_300_000, estimateCredits: KEY_SPEND_ESTIMATES['key:runner'] })
    // Registered with the requested limits, disabling nothing and storing nothing here.
    const params = chain.registered.at(-1)!
    expect(params['request']).toEqual(request)
    for (const k of ['replaceKeyId', 'disableHeld', 'persist']) expect(params[k], k).toBeUndefined()
    expect(controller.getState().session?.keyId).toBe(5)
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
    expect(reconcile(s.allTime, baseline!.credits, chain.balance)).toEqual({ balanceChange: -(47_111_680 + 2_267_600), unexplained: 0 })
  }, 30_000)
})

describe('registering a username (#452)', () => {
  const file = JSON.stringify({
    network: 'devnet-moutai',
    identityId: ID,
    identityKeys: [
      { purpose: 'AUTHENTICATION', securityLevel: 'MASTER', keyType: 'ECDSA_SECP256K1', privateKeyWif: wifOf(1) },
      { purpose: 'AUTHENTICATION', securityLevel: 'CRITICAL', keyType: 'ECDSA_SECP256K1', privateKeyWif: wifOf(3) },
    ],
  })
  let controller: AuthController
  let events: SpendEvent[]
  beforeEach(async () => {
    resetMemoryStores()
    lockVault()
    clearDpnsCache()
    chain.balance = 100_000_000_000n
    chain.cost = { register: 47_111_680n, topup: 2_267_600n, revoke: 12_000_000n }
    chain.fail = false
    chain.nextKeyId = 5
    dpns.holders = new Map()
    dpns.lostAnswer = false
    dpns.winner = null
    dpns.sent = []
    events = []
    const sdk = {
      identities: {
        fetch: async () => ({ balance: chain.balance, publicKeys: [{ keyId: 5, wif: wifOf(5), purposeNumber: 0, securityLevelNumber: 2 }] }),
        keysRemainingBudgets: async () => new Map(),
      },
    } as unknown as EvoSDK
    controller = new AuthController(async () => sdk, NET)
    await controller.importIdentity({ fileText: '{}' }, PASS)
    controller.setSpendListener((e) => events.push(e))
  })

  it('signs with the file’s CRITICAL key (never MASTER), records the charge and knows the name', async () => {
    expect(await controller.registerUsername({ fileText: file }, 'Alice-7')).toBe('Alice-7.dash')
    expect(dpns.sent).toEqual([{ label: 'Alice-7', wifs: [wifOf(3)] }])
    const e = events[0] ?? (await vi.waitFor(() => events[0]!))
    expect(e).toMatchObject({ kind: 'identity:name', documentId: 'identity', actualCredits: 72_600_000, estimateCredits: KEY_SPEND_ESTIMATES['identity:name'] })
    expect(cachedDpnsName(NET, ID)).toBe('Alice-7.dash')
  }, 30_000)

  it('refuses a contested or invalid name before anything is sent', async () => {
    await expect(controller.registerUsername({ fileText: file }, 'alice')).rejects.toThrow(/contested/)
    await expect(controller.registerUsername({ fileText: file }, 'a_b')).rejects.toThrow(/only letters/i)
    expect(dpns.sent).toEqual([])
  }, 30_000)

  it('refuses another identity’s file', async () => {
    const other = file.replace(ID, '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD')
    await expect(controller.registerUsername({ fileText: other }, 'alice-7')).rejects.toThrow(/9r27eDs/)
    expect(dpns.sent).toEqual([])
  }, 30_000)

  it('a lost answer is a success when the name is now this identity’s', async () => {
    dpns.lostAnswer = true
    expect(await controller.registerUsername({ fileText: file }, 'alice-7')).toBe('alice-7.dash')
    // Someone else's after all: the error stands, and the tab does not believe the name is ours.
    dpns.winner = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
    await expect(controller.registerUsername({ fileText: file }, 'bob-7')).rejects.toThrow(/timed out/)
    expect(cachedDpnsName(NET, ID)).toBe('alice-7.dash')
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
