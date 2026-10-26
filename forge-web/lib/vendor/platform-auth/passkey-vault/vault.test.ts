import { describe, expect, it } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { bytesEqual } from './bytes'
import type { SlotBundle, SlotKey } from './codecs'
import { recipientFromPrf, sealEntry } from './entry'
import { PasskeyError, VaultError } from './errors'
import type { OnChainKey } from './port'
import { userHandleFor } from './user-handle'
import { checkSlots, matchKey, type DropReason } from './verify'
import { PasskeyVault, type ConfirmedPasskey } from './vault'
import { fakePasskeyAdapter, type FakePasskeyOptions } from './__fixtures__/fake-passkey'
import { MemoryVaultPort } from './__fixtures__/memory-port'
import { forgeProfile, forgeSlots } from './__fixtures__/profiles'

const H = (label: string) => sha256(new TextEncoder().encode(label))
const hex = bytesToHex
const NOW = 1_800_000_000_000
const DAY = 86_400_000
const contractId = H('forge-meta contract')
const ownerId = H('owner identity')
const group = H('dash-forge group')

const MAIN: SlotKey = { purpose: 0, securityLevel: 2, keyType: 0, keyId: 3, privateKey: H('main key') }
const GRANT: SlotKey = { purpose: 0, securityLevel: 2, keyType: 2, keyId: 4, privateKey: H('grant key') }
const ENC: SlotKey = { purpose: 1, securityLevel: 3, keyType: 0, keyId: 5, privateKey: H('encryption key') }

function onChain(k: SlotKey, over: Partial<OnChainKey> = {}): OnChainKey {
  const point = secp256k1.getPublicKey(k.privateKey, true)
  return {
    id: k.keyId,
    purpose: k.purpose,
    securityLevel: k.securityLevel,
    type: k.keyType,
    data: k.keyType === 2 ? ripemd160(sha256(point)) : point,
    disabled: false,
    ...(k.purpose === 0 ? { contractBounds: { kind: 'contractGroup' as const, groupId: group }, expiresAt: NOW + 90 * DAY, totalBudget: 5_000_000_000n, remainingBudget: 4_000_000_000n } : {}),
    ...over,
  }
}

interface Session {
  ownerId: Uint8Array
  keys: SlotKey[]
}
interface Verified {
  keys: SlotKey[]
  dropped: Array<[number, DropReason]>
}

const copyKeys = (keys: readonly SlotKey[]) => keys.map((k) => ({ ...k, privateKey: k.privateKey.slice() }))

function setup(o: { adapter?: FakePasskeyOptions; maxPasskeys?: number } = {}) {
  const port = new MemoryVaultPort()
  port.setKeys(ownerId, [onChain(MAIN), onChain(GRANT), onChain(ENC)])
  const adapter = fakePasskeyAdapter(o.adapter)
  const seen: SlotBundle[] = []
  const vault = new PasskeyVault<Session, SlotBundle, Verified>({
    profile: forgeProfile,
    codec: forgeSlots,
    port,
    adapter,
    rpId: 'forge.dashhq.org',
    rpName: 'Dash Forge',
    contractId,
    maxPasskeys: o.maxPasskeys,
    ownerOf: (s) => s.ownerId,
    bundleFor: (s) => ({ format: 1, keys: copyKeys(s.keys) }),
    now: () => NOW,
    sleep: async () => {},
    verify(bundle, keys, ctx) {
      seen.push(bundle)
      const { accepted, dropped } = checkSlots(bundle.keys, keys, {
        now: ctx.now,
        expiryMarginMs: 60_000,
        // slot 0 must be budgeted and bound to the app's group
        accept: (_slot, key, index) =>
          index > 0 || (key.totalBudget !== undefined && key.contractBounds?.kind === 'contractGroup' && bytesEqual(key.contractBounds.groupId, group)),
      })
      if (accepted[0]?.index !== 0) throw new VaultError("The key in this passkey isn't an active key of the identity.", 'refused')
      return { keys: copyKeys(accepted.map((a) => a.slot)), dropped: dropped.map((d) => [d.index, d.reason]) }
    },
  })
  const session: Session = { ownerId, keys: [MAIN, GRANT, ENC] }
  return { port, adapter, vault, session, seen }
}

async function addPasskey(t: ReturnType<typeof setup>, session = t.session) {
  const pending = await t.vault.enroll(session, { userName: 'alice' })
  const confirmed = await t.vault.confirm(pending)
  const entry = await t.vault.store(session, confirmed)
  return { pending, confirmed, entry }
}

const errCode = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    if (e instanceof VaultError || e instanceof PasskeyError) return e.code
    throw e
  }
  return 'ok'
}

describe('matchKey and checkSlots', () => {
  it('matches a compressed point or its hash160, nothing else', () => {
    expect(matchKey(MAIN.privateKey, onChain(MAIN))).toBe(true)
    expect(matchKey(GRANT.privateKey, onChain(GRANT))).toBe(true)
    expect(matchKey(MAIN.privateKey, onChain(GRANT))).toBe(false)
    expect(matchKey(MAIN.privateKey, { ...onChain(MAIN), type: 1 })).toBe(false)
    expect(matchKey(new Uint8Array(32), onChain(MAIN))).toBe(false)
  })

  it('drops each kind of unusable key with its reason, and keeps the rest in order', () => {
    const slots = [MAIN, GRANT, ENC, { ...ENC, keyId: 9 }, { ...GRANT, keyId: 10 }, { ...GRANT, keyId: 11 }, { ...GRANT, keyId: 12 }, { ...GRANT, keyId: 13 }]
    const chain = [
      onChain(MAIN),
      onChain(GRANT, { disabled: true }),
      onChain(ENC),
      onChain({ ...GRANT, keyId: 10 }, { expiresAt: NOW + 30_000 }),
      onChain({ ...GRANT, keyId: 11 }, { remainingBudget: 0n }),
      onChain({ ...GRANT, keyId: 12, privateKey: H('other') }),
      onChain({ ...GRANT, keyId: 13 }, { securityLevel: 1 }),
    ]
    const { accepted, dropped } = checkSlots(slots, chain, { now: NOW, expiryMarginMs: 60_000, accept: (_s, k) => k.id !== 5 })
    expect(accepted.map((a) => a.index)).toEqual([0])
    expect(dropped.map((d) => [d.index, d.reason])).toEqual([
      [1, 'disabled'],
      [2, 'rule'],
      [3, 'missing'],
      [4, 'expired'],
      [5, 'spent'],
      [6, 'mismatch'],
      [7, 'shape'],
    ])
    // an unknown budget is not a spent one
    expect(checkSlots([MAIN], [onChain(MAIN, { remainingBudget: undefined })], { now: NOW }).accepted).toHaveLength(1)
  })
})

describe('PasskeyVault: add a passkey and sign in with it', () => {
  it('enrols, confirms, seals and writes one 256-byte entry, then opens it on another device', async () => {
    const t = setup()
    const { pending, confirmed, entry } = await addPasskey(t)
    const create = t.adapter.calls.create[0]!
    expect(hex(create.userHandle)).toBe(hex(userHandleFor(ownerId, contractId)))
    expect(hex(create.prfInput)).toBe(hex(t.vault.prfInput))
    expect(create.exclude).toEqual([])
    expect(t.adapter.calls.get[0]!.allow.map(hex)).toEqual([hex(pending.credentialId)])
    expect(entry.sealed.length).toBe(256)
    expect(entry.authKeyId).toBe(3)
    expect(hex(confirmed.recipientKey)).toBe(hex(recipientFromPrf(t.adapter.prfOf(pending.credentialId, t.vault.prfInput)).publicKey))
    expect(t.port.entries).toHaveLength(1)
    await t.vault.waitForEntry(ownerId, pending.credentialId, confirmed.recipientKey)

    const opened = await t.vault.open({ keepPrfOutput: true })
    expect(hex(opened.ownerId)).toBe(hex(ownerId))
    expect(opened.result.keys.map((k) => k.keyId)).toEqual([3, 4, 5])
    expect(hex(opened.result.keys[0]!.privateKey)).toBe(hex(MAIN.privateKey))
    expect(opened.result.dropped).toEqual([])
    // the PRF output is handed over for the local vault, and is the credential's output for the vault's PRF input
    expect(hex(opened.prfOutput!)).toBe(hex(t.adapter.prfOf(pending.credentialId, t.vault.prfInput)))
    expect(t.adapter.calls.get.at(-1)!.allow).toEqual([])
    // the bundle the check saw is wiped; what it returned survives
    expect(t.seen[0]!.keys.every((k) => k.privateKey.every((b) => b === 0))).toBe(true)
    // the session's own keys are untouched by sealing
    expect(hex(MAIN.privateKey)).toBe(hex(H('main key')))
  })

  it('wipes the PRF output unless asked to keep it', async () => {
    const t = setup()
    await addPasskey(t)
    let prf: Uint8Array | undefined
    const get = t.adapter.get.bind(t.adapter)
    t.adapter.get = async (o) => {
      const a = await get(o)
      prf = a.prfOutput
      return a
    }
    const opened = await t.vault.open()
    expect(opened.prfOutput).toBeNull()
    expect(prf!.every((b) => b === 0)).toBe(true)
  })

  it('checks the create-time PRF against the get-time one and wipes both', async () => {
    const t = setup({ adapter: { prfAtCreate: true } })
    const pending = await t.vault.enroll(t.session, { userName: 'alice' })
    expect(pending.createPrf).not.toBeNull()
    const createPrf = pending.createPrf!
    await t.vault.confirm(pending)
    expect(createPrf.every((b) => b === 0)).toBe(true)

    const other = await t.vault.enroll({ ownerId: H('another owner'), keys: [MAIN] }, { userName: 'bob' })
    other.createPrf![0]! ^= 1
    expect(await errCode(t.vault.confirm(other))).toBe('mismatch')
  })

  it('excludes the existing passkeys and stops at the cap', async () => {
    const t = setup({ maxPasskeys: 2, adapter: { multiDevice: true } })
    const first = await addPasskey(t)
    await addPasskey(t, { ownerId, keys: [MAIN] })
    expect(t.adapter.calls.create[1]!.exclude.map(hex)).toEqual([hex(first.pending.credentialId)])
    expect(await errCode(t.vault.enroll(t.session, { userName: 'alice' }))).toBe('too-many')
    expect(t.adapter.calls.create).toHaveLength(2)
  })

  it('refuses a passkey with no PRF, and abandon tells the provider', async () => {
    const t = setup({ adapter: { prf: false } })
    const pending = await t.vault.enroll(t.session, { userName: 'alice' })
    expect(pending.prfEnabled).toBe(false)
    expect(await errCode(t.vault.confirm(pending))).toBe('no-prf')
    await t.vault.abandon(pending)
    expect(t.adapter.signalled.map(hex)).toEqual([hex(pending.credentialId)])
    expect(t.port.entries).toHaveLength(0)
  })

  it("refuses a credential id outside 16 to 255 bytes and drops it from the provider", async () => {
    const t = setup({ adapter: { credentialIdLength: 15 } })
    expect(await errCode(t.vault.enroll(t.session, { userName: 'alice' }))).toBe('unsupported')
    expect(t.adapter.signalled).toHaveLength(1)
  })

  it("confirm refuses a handle for another identity, another vault, or none", async () => {
    const t = setup()
    const pending = await t.vault.enroll(t.session, { userName: 'alice' })
    t.adapter.overrideNextHandle(userHandleFor(H('someone else'), contractId))
    expect(await errCode(t.vault.confirm(pending))).toBe('other-identity')
    t.adapter.overrideNextHandle(userHandleFor(ownerId, H('testnet contract')))
    expect(await errCode(t.vault.confirm(pending))).toBe('other-vault')
    t.adapter.overrideNextHandle(null)
    expect(await errCode(t.vault.confirm(pending))).toBe('not-vault')
    expect(t.port.entries).toHaveLength(0)
  })

  it('a cancelled confirm can be retried (the pending record is kept)', async () => {
    const t = setup({ adapter: { prfAtCreate: true } })
    const pending = await t.vault.enroll(t.session, { userName: 'alice' })
    t.adapter.failNext(new PasskeyError('closed', 'cancelled'))
    expect(await errCode(t.vault.confirm(pending))).toBe('cancelled')
    expect(pending.createPrf!.some((b) => b !== 0)).toBe(true)
    const confirmed = await t.vault.confirm(pending)
    expect(pending.createPrf).toBeNull()
    // after a failed store (say, the node refused the write) the same pending enrolment confirms again
    await t.vault.confirm(pending)
    await t.vault.store(t.session, confirmed)
    expect(t.port.entries).toHaveLength(1)
  })

  it('waits for a lagging node, and says when the entry is not visible', async () => {
    const t = setup()
    t.port.lag = 3
    const { pending, confirmed } = await addPasskey(t)
    await expect(t.vault.waitForEntry(ownerId, pending.credentialId, confirmed.recipientKey, { reads: 5 })).resolves.toBeTruthy()
    expect(await errCode(t.vault.waitForEntry(ownerId, H('nothing').slice(0, 16), confirmed.recipientKey, { reads: 2 }))).toBe('not-visible')
    // the last read's error propagates
    t.port.byCredential = async () => {
      throw new Error('node down')
    }
    await expect(t.vault.waitForEntry(ownerId, pending.credentialId, confirmed.recipientKey, { reads: 2 })).rejects.toThrow('node down')
  })
})

describe('PasskeyVault: never seal to an untrusted recipient', () => {
  it('store refuses a ConfirmedPasskey it did not mint, and one for another identity', async () => {
    const t = setup()
    const forged: ConfirmedPasskey = { ownerId, credentialId: H('cred').slice(0, 16), recipientKey: recipientFromPrf(H('attacker prf')).publicKey, source: 'passkey' }
    expect(await errCode(t.vault.store(t.session, forged))).toBe('untrusted-recipient')
    // a local marker vouches for re-sealing only, never for a new entry
    const marker = t.vault.trustMarker({ ownerId, credentialId: H('cred').slice(0, 16), recipientKey: forged.recipientKey })
    expect(await errCode(t.vault.store(t.session, marker as ConfirmedPasskey))).toBe('untrusted-recipient')
    const { confirmed } = await addPasskey(t)
    expect(await errCode(t.vault.store({ ownerId: H('another owner'), keys: [MAIN] }, confirmed))).toBe('other-identity')
    // another vault instance's confirmation is not this one's
    const t2 = setup()
    expect(await errCode(t2.vault.store(t2.session, confirmed))).toBe('untrusted-recipient')
    expect(t.port.writes.map((w) => w.op)).toEqual(['create'])
  })

  it('mutating a confirmation changes nothing: the private copy is sealed to', async () => {
    const t = setup()
    const pending = await t.vault.enroll(t.session, { userName: 'alice' })
    const confirmed = await t.vault.confirm(pending)
    const real = hex(confirmed.recipientKey)
    confirmed.recipientKey.set(recipientFromPrf(H('attacker prf')).publicKey)
    const entry = await t.vault.store(t.session, confirmed)
    expect(hex(entry.recipientKey)).toBe(real)
  })

  it('reseal: only to a trusted recipient key that the entry, re-read, still has', async () => {
    const t = setup()
    const { confirmed } = await addPasskey(t)
    const [entry] = await t.vault.list(ownerId)
    // a key change in this tab: the session now holds only the main key
    const next: Session = { ownerId, keys: [MAIN] }
    // the app's local marker for a passkey this device made
    const marker = t.vault.trustMarker({ ownerId, credentialId: confirmed.credentialId, recipientKey: confirmed.recipientKey })
    await t.vault.reseal(entry!, next, { trustedRecipient: marker })
    expect(t.port.entries[0]!.revision).toBe(2)
    expect((await t.vault.open()).result.keys.map((k) => k.keyId)).toEqual([3])

    const [latest] = await t.vault.list(ownerId)
    // raw bytes are not a TrustedRecipient: the types refuse them, and so does the vault at run time
    const raw = { ownerId, credentialId: confirmed.credentialId, recipientKey: latest!.recipientKey, source: 'marker' as const }
    expect(await errCode(t.vault.reseal(latest!, next, { trustedRecipient: raw }))).toBe('untrusted-recipient')
    const wrongKey = t.vault.trustMarker({ ownerId, credentialId: confirmed.credentialId, recipientKey: recipientFromPrf(H('x')).publicKey })
    expect(await errCode(t.vault.reseal(latest!, next, { trustedRecipient: wrongKey }))).toBe('untrusted-recipient')
    const otherCred = t.vault.trustMarker({ ownerId, credentialId: H('other cred').slice(0, 16), recipientKey: confirmed.recipientKey })
    expect(await errCode(t.vault.reseal(latest!, next, { trustedRecipient: otherCred }))).toBe('untrusted-recipient')
    expect(await errCode(t.vault.reseal(latest!, { ownerId: H('another owner'), keys: [MAIN] }, { trustedRecipient: marker }))).toBe('other-identity')
    // a marker whose key the chain no longer has is refused after the re-read
    const stale = t.vault.trustMarker({ ownerId, credentialId: confirmed.credentialId, recipientKey: H('stale') })
    expect(await errCode(t.vault.reseal({ ...latest!, recipientKey: H('stale') }, next, { trustedRecipient: stale }))).toBe('untrusted-recipient')
    expect(t.port.entries[0]!.revision).toBe(2)
  })

  it('a planted entry naming the user\'s credential but an attacker\'s recipient key is never re-sealed to', async () => {
    const t = setup()
    const { pending } = await addPasskey(t)
    // an attacker who held a live key replaces the entry with one sealed to their own recipient key
    t.port.entries = []
    const attackerRecipient = recipientFromPrf(H('attacker prf')).publicKey
    t.port.plant(ownerId, sealEntry(forgeProfile, { contractId, ownerId, credentialId: pending.credentialId, recipientKey: attackerRecipient, bundle: { format: 1, keys: [MAIN] }, codec: forgeSlots }))
    const [planted] = await t.vault.list(ownerId)
    // "Needs update" re-seal asks the passkey: its PRF does not give the planted recipient key
    expect(await errCode(t.vault.confirm({ ownerId, credentialId: planted!.credentialId, recipientKey: planted!.recipientKey }))).toBe('mismatch')
    // nor can a confirmation for the real passkey be used to seal to the planted key
    const real = await t.vault.confirm({ ownerId, credentialId: planted!.credentialId })
    expect(await errCode(t.vault.reseal(planted!, t.session, { trustedRecipient: real }))).toBe('untrusted-recipient')
    // storing to the confirmed passkey replaces the unopenable entry (recipient keys are immutable: delete, then create)
    await t.vault.store(t.session, real)
    expect(t.port.writes.map((w) => w.op).slice(-2)).toEqual(['delete', 'create'])
    expect(hex(t.port.entries[0]!.recipientKey)).toBe(hex(real.recipientKey))
  })

  it('replacing an unopenable entry writes nothing when sealing fails', async () => {
    const t = setup()
    const { pending } = await addPasskey(t)
    t.port.entries = []
    t.port.plant(ownerId, sealEntry(forgeProfile, { contractId, ownerId, credentialId: pending.credentialId, recipientKey: recipientFromPrf(H('attacker prf')).publicKey, bundle: { format: 1, keys: [MAIN] }, codec: forgeSlots }))
    const real = await t.vault.confirm({ ownerId, credentialId: pending.credentialId })
    const writes = t.port.writes.length
    // a session holding a key the codec refuses (CRITICAL) cannot be sealed
    await expect(t.vault.store({ ownerId, keys: [{ ...MAIN, securityLevel: 1 }] }, real)).rejects.toThrow(/slot 0/)
    expect(t.port.writes.length).toBe(writes)
    expect(t.port.entries).toHaveLength(1)
  })

  it('reseal with a confirmation for that entry works; one for another entry does not', async () => {
    const t = setup({ adapter: { multiDevice: true } })
    const a = await addPasskey(t)
    const b = await addPasskey(t)
    const entries = await t.vault.list(ownerId)
    const entryA = entries.find((e) => bytesEqual(e.credentialId, a.pending.credentialId))!
    const confirmA = await t.vault.confirm(entryA)
    await t.vault.reseal(entryA, t.session, { trustedRecipient: confirmA })
    expect(await errCode(t.vault.reseal(entryA, t.session, { trustedRecipient: b.confirmed }))).toBe('untrusted-recipient')
  })
})

describe('PasskeyVault: the chain check on open', () => {
  async function plantFor(t: ReturnType<typeof setup>, keys: SlotKey[]) {
    const { pending, confirmed } = await addPasskey(t)
    t.port.entries = []
    t.port.plant(ownerId, sealEntry(forgeProfile, { contractId, ownerId, credentialId: pending.credentialId, recipientKey: confirmed.recipientKey, bundle: { format: 1, keys }, codec: forgeSlots }))
  }

  it('refuses a planted bundle whose keys the identity does not have', async () => {
    const t = setup()
    await plantFor(t, [{ ...MAIN, privateKey: H('attacker key') }])
    expect(await errCode(t.vault.open())).toBe('refused')
    expect(t.seen[0]!.keys[0]!.privateKey.every((b) => b === 0)).toBe(true)
  })

  it('refuses a disabled, expired, spent, unbounded or foreign-group main key', async () => {
    for (const over of [
      { disabled: true },
      { expiresAt: NOW - 1 },
      { remainingBudget: 0n },
      { contractBounds: undefined, totalBudget: undefined },
      { contractBounds: { kind: 'contractGroup' as const, groupId: H('another group') } },
    ]) {
      const t = setup()
      await addPasskey(t)
      t.port.setKeys(ownerId, [onChain(MAIN, over), onChain(GRANT), onChain(ENC)])
      expect(await errCode(t.vault.open())).toBe('refused')
    }
  })

  it('drops failing extras and signs in with the rest', async () => {
    const t = setup()
    await addPasskey(t)
    t.port.setKeys(ownerId, [onChain(MAIN), onChain(GRANT, { disabled: true }), onChain({ ...ENC, privateKey: H('rotated encryption key') })])
    const opened = await t.vault.open()
    expect(opened.result.keys.map((k) => k.keyId)).toEqual([3])
    expect(opened.result.dropped).toEqual([
      [1, 'disabled'],
      [2, 'mismatch'],
    ])
  })

  it('no entry, an unknown identity, a local-only passkey and another vault are each refused', async () => {
    const t = setup()
    const { pending } = await addPasskey(t)
    t.port.entries = []
    expect(await errCode(t.vault.open())).toBe('no-entry')
    await t.vault.store(t.session, await t.vault.confirm(pending))
    t.port.identities.clear()
    expect(await errCode(t.vault.open())).toBe('unknown-identity')
    t.adapter.overrideNextHandle(H('local-only random user.id'))
    expect(await errCode(t.vault.open())).toBe('not-vault')
    t.adapter.overrideNextHandle(userHandleFor(ownerId, H('testnet contract')))
    expect(await errCode(t.vault.open())).toBe('other-vault')
  })

  it('a failed key read propagates as itself', async () => {
    const t = setup()
    await addPasskey(t)
    t.port.identityKeys = async () => {
      throw new Error('node timeout')
    }
    await expect(t.vault.open()).rejects.toThrow('node timeout')
  })
})

describe('PasskeyVault: remove', () => {
  it('signals the provider only for this device\'s passkeys', async () => {
    const t = setup({ adapter: { multiDevice: true } })
    await addPasskey(t)
    await addPasskey(t)
    const [a, b] = await t.vault.list(ownerId)
    await t.vault.remove(a!)
    expect(t.adapter.signalled).toHaveLength(0)
    await t.vault.remove(b!, { thisDevice: true })
    expect(t.adapter.signalled.map(hex)).toEqual([hex(b!.credentialId)])
    expect(await t.vault.list(ownerId)).toHaveLength(0)
  })

  it('refuses a codec that is not in the profile', () => {
    const t = setup()
    expect(
      () =>
        new PasskeyVault<Session, SlotBundle, Verified>({
          profile: forgeProfile,
          codec: { ...forgeSlots },
          port: t.port,
          adapter: t.adapter,
          rpId: 'x',
          rpName: 'x',
          contractId,
          ownerOf: (s) => s.ownerId,
          bundleFor: () => ({ format: 1, keys: [] }),
          verify: () => ({ keys: [], dropped: [] }),
        }),
    ).toThrow(/not one of the profile/)
  })
})
