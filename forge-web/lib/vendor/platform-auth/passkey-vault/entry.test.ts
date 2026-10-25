import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import type { SlotBundle } from './codecs'
import { entryAad, hpkeInfo, openEntry, prfInput, recipientFromPrf, sealEntry, type SealedVaultEntry } from './entry'
import { VaultCryptoError } from './errors'
import { sealBase } from './hpke'
import type { VaultProfile } from './profile'
import { forgeProfile, forgeSlots, govhubKey, govhubProfile, govhubSeed, yapprProfile, yapprRaw, yapprRing } from './__fixtures__/profiles'
import { loadVectors, req, slotBundle, type GovhubFile, type Vector, type VectorFile } from './__fixtures__/vectors'

const H = (label: string) => sha256(new TextEncoder().encode(label))
const hex = bytesToHex
const flip = (bytes: Uint8Array, index: number) => {
  const copy = bytes.slice()
  copy[index] = (copy[index] ?? 0) ^ 1
  return copy
}
const code = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    if (e instanceof VaultCryptoError) return e.code
    throw e
  }
  throw new Error('did not throw')
}

/** Every derived field of a slot-keys vector, and the seal/open round trip, against `profile`. */
function checkVector(profile: VaultProfile<SlotBundle>, file: { contractId: string; ownerId: string }, v: Vector, codec = profile.formats[0]!) {
  const contractId = hexToBytes(file.contractId)
  const ownerId = hexToBytes(file.ownerId)
  const credentialId = hexToBytes(v.credentialId)
  const prf = hexToBytes(v.prfOutput)
  const recipient = recipientFromPrf(prf)
  if (v.prfInput) expect(hex(prfInput(profile, contractId))).toBe(v.prfInput)
  if (v.recipientSk) expect(hex(recipient.privateKey)).toBe(v.recipientSk)
  expect(hex(recipient.publicKey)).toBe(req(v.recipientKey, 'recipientKey'))
  if (v.info) expect(hex(hpkeInfo(profile, contractId, ownerId))).toBe(v.info)
  const authKeyId = req(v.authKeyId, 'authKeyId')
  expect(hex(entryAad(profile, { version: 1, credentialId, recipientKey: recipient.publicKey, authKeyId }))).toBe(req(v.aad, 'aad'))
  expect(hex(codec.encode(slotBundle(codec.id, v.keys)))).toBe(req(v.bundle, 'bundle'))

  const bundle = slotBundle(codec.id, v.keys)
  const entry = sealEntry(profile, { contractId, ownerId, credentialId, recipientKey: recipient.publicKey, bundle, codec, ephemeralIkm: hexToBytes(v.ephemeralIkm) })
  expect(entry.authKeyId).toBe(authKeyId)
  expect(hex(entry.enc)).toBe(req(v.enc, 'enc'))
  expect(hex(entry.sealed)).toBe(req(v.sealed, 'sealed'))
  // the caller's bundle is untouched by sealing
  expect(bundle).toEqual(slotBundle(codec.id, v.keys))

  const opened = openEntry(profile, { contractId, ownerId, entry, prfOutput: prf })
  expect(opened.codec).toBe(codec)
  expect(opened.bundle).toEqual(slotBundle(codec.id, v.keys))
  // the PRF output belongs to the caller
  expect(hex(prf)).toBe(v.prfOutput)
  return entry
}

describe('Yappr vectors (yappr lib/crypto/passkey-vault.test.ts), byte for byte', () => {
  const file = loadVectors<VectorFile>('yappr')
  const raw = file.vectors.find((v) => v.name === 'RAW')!
  const ring = file.vectors.find((v) => v.name === 'RING')!

  it('the ids are sha256 of the labels', () => {
    expect(file.contractId).toBe(hex(H('test vector: vault contract id')))
    expect(file.ownerId).toBe(hex(H('test vector: owner identity id')))
  })

  it('RAW: PRF input, recipient, info, aad, bundle, enc and sealed', () => {
    const entry = checkVector(yapprProfile, file, raw, yapprRaw)
    expect(entry.sealed.length).toBe(96)
  })

  it('RING: aad, bundle, enc and sealed (176 bytes)', () => {
    const entry = checkVector(yapprProfile, file, ring, yapprRing)
    expect(entry.sealed.length).toBe(176)
  })

  it('opens the stored RING entry back to the group, profile and encryption keys', () => {
    const entry: SealedVaultEntry = {
      version: 1,
      credentialId: hexToBytes(ring.credentialId),
      recipientKey: hexToBytes(req(ring.recipientKey, 'recipientKey')),
      authKeyId: 7,
      enc: hexToBytes(req(ring.enc, 'enc')),
      sealed: hexToBytes(req(ring.sealed, 'sealed')),
    }
    const { bundle } = openEntry(yapprProfile, { contractId: hexToBytes(file.contractId), ownerId: hexToBytes(file.ownerId), entry, prfOutput: hexToBytes(ring.prfOutput) })
    expect(bundle.format).toBe(2)
    expect(bundle.keys.map((k) => [k.keyId, k.securityLevel, k.keyType])).toEqual([[7, 1, 0], [8, 2, 2], [9, 3, 0]])
  })

  it('pads a one-key raw bundle to the same 96-byte ciphertext, freshly each time', () => {
    const seal = () =>
      sealEntry(yapprProfile, {
        contractId: hexToBytes(file.contractId),
        ownerId: hexToBytes(file.ownerId),
        credentialId: hexToBytes(raw.credentialId),
        recipientKey: hexToBytes(req(raw.recipientKey, 'recipientKey')),
        bundle: slotBundle(1, raw.keys.slice(0, 1)),
        codec: yapprRaw,
      })
    const a = seal()
    const b = seal()
    expect(a.sealed.length).toBe(96)
    expect(hex(a.enc)).not.toBe(hex(b.enc))
    expect(hex(a.sealed)).not.toBe(hex(b.sealed))
  })
})

describe("govhub's fixed vector (govhub test/__snapshots__/vault.test.ts.snap)", () => {
  const file = loadVectors<GovhubFile>('govhub')
  const v = file.vector
  const contractId = hexToBytes(file.contractId)
  const ownerId = hexToBytes(file.ownerId)

  it('uses the inputs the snapshot was taken with', () => {
    expect(file.contractId).toBe('01'.repeat(32))
    expect(file.ownerId).toBe('02'.repeat(32))
    expect(v.credentialId).toBe('03'.repeat(16))
    expect(v.prfOutput).toBe('04'.repeat(32))
    expect(v.ephemeralIkm).toBe('05'.repeat(32))
    expect(v.keys).toEqual([{ purpose: 0, securityLevel: 2, keyType: 0, keyId: 2, privateKey: hex(Uint8Array.from({ length: 32 }, (_, i) => i + 1)) }])
  })

  it('seals a KEY bundle to the snapshot (enc, first 16 bytes, tag) and to the generator\'s full bytes; strict 256 B', () => {
    const entry = sealEntry(govhubProfile, {
      contractId,
      ownerId,
      credentialId: hexToBytes(v.credentialId),
      recipientKey: recipientFromPrf(hexToBytes(v.prfOutput)).publicKey,
      authKeyId: 2,
      bundle: slotBundle(2, v.keys),
      codec: govhubKey,
      ephemeralIkm: hexToBytes(v.ephemeralIkm),
    })
    expect(entry.sealed.length).toBe(256)
    expect({ enc: hex(entry.enc), sealedHead: hex(entry.sealed.subarray(0, 16)), tag: hex(entry.sealed.subarray(-16)) }).toEqual(v.snapshot)
    expect(hex(entry.sealed)).toBe(v.derived.sealed)
    expect(hex(entryAad(govhubProfile, entry))).toBe(v.derived.aad)
    expect(hex(hpkeInfo(govhubProfile, contractId, ownerId))).toBe(v.derived.info)
    expect(hex(prfInput(govhubProfile, contractId))).toBe(v.derived.prfInput)
    expect(new TextDecoder().decode(prfInput(govhubProfile, contractId).subarray(0, 19))).toBe('govhub/vault/v1/prf')
    const { codec, bundle } = openEntry(govhubProfile, { contractId, ownerId, entry, prfOutput: hexToBytes(v.prfOutput) })
    expect(codec).toBe(govhubKey)
    expect(bundle).toEqual(slotBundle(2, v.keys))
  })

  it('pads every govhub format to 256 sealed bytes and picks the codec by the format byte', () => {
    const prf = H('govhub other prf')
    const recipientKey = recipientFromPrf(prf).publicKey
    const credentialId = H('govhub cred').slice(0, 20)
    const seed = { format: 1, identityIndex: 3, entropy: H('entropy').slice(0, 16) }
    const entry = sealEntry(govhubProfile, { contractId, ownerId, credentialId, recipientKey, authKeyId: 2, bundle: seed, codec: govhubSeed })
    expect(entry.sealed.length).toBe(256)
    const opened = openEntry(govhubProfile, { contractId, ownerId, entry, prfOutput: prf })
    expect(opened.codec).toBe(govhubSeed)
    expect(opened.bundle).toEqual(seed)
  })
})

describe('Forge vectors (forge.json, from the independent Python generator)', () => {
  const file = loadVectors<VectorFile>('forge')

  it('pins the Forge profile', () => {
    const contractId = hexToBytes(file.contractId)
    expect(new TextDecoder().decode(prfInput(forgeProfile, contractId).subarray(0, 31))).toBe('dash-forge/passkey-vault/v1/prf')
    expect(forgeProfile.formats).toEqual([forgeSlots])
    expect([forgeSlots.id, forgeSlots.length]).toEqual([1, 240])
    expect(file.vectors).toHaveLength(3)
  })

  for (const v of file.vectors) {
    it(`${v.name}: every field, and 256 sealed bytes`, () => {
      const entry = checkVector(forgeProfile, file, v)
      expect(entry.sealed.length).toBe(256)
    })
  }
})

describe('refusals', () => {
  const file = loadVectors<VectorFile>('forge')
  const v = file.vectors[1]!
  const contractId = hexToBytes(file.contractId)
  const ownerId = hexToBytes(file.ownerId)
  const prf = hexToBytes(v.prfOutput)
  const recipientKey = recipientFromPrf(prf).publicKey
  const credentialId = hexToBytes(v.credentialId)
  const entry = sealEntry(forgeProfile, { contractId, ownerId, credentialId, recipientKey, bundle: slotBundle(1, v.keys), codec: forgeSlots })
  const open = (e: SealedVaultEntry, over: { prf?: Uint8Array; contract?: Uint8Array; owner?: Uint8Array } = {}) =>
    openEntry(forgeProfile, { contractId: over.contract ?? contractId, ownerId: over.owner ?? ownerId, entry: e, prfOutput: over.prf ?? prf })

  /** Seals arbitrary plaintext with the right info and aad: what a malicious writer could do. */
  const sealRaw = (plaintext: Uint8Array, authKeyId = entry.authKeyId): SealedVaultEntry => {
    const fields = { version: 1, credentialId, recipientKey, authKeyId }
    const { enc, ciphertext } = sealBase(recipientKey, hpkeInfo(forgeProfile, contractId, ownerId), entryAad(forgeProfile, fields), plaintext)
    return { ...fields, enc, sealed: ciphertext }
  }

  it('refuses another passkey before decrypting (even a ciphertext that would not decrypt)', () => {
    expect(code(() => open(entry, { prf: H('another PRF output') }))).toBe('wrong-passkey')
    expect(code(() => open({ ...entry, sealed: new Uint8Array(256) }, { prf: H('another PRF output') }))).toBe('wrong-passkey')
    expect(() => open(entry, { prf: H('x') })).toThrow(/does not open this entry/)
  })

  it('fails the tag for another identity, contract, credential or key id', () => {
    expect(code(() => open(entry, { owner: H('another owner') }))).toBe('decrypt')
    expect(code(() => open(entry, { contract: H('another contract') }))).toBe('decrypt')
    expect(code(() => open({ ...entry, credentialId: H('another credential').slice(0, 20) }))).toBe('decrypt')
    expect(code(() => open({ ...entry, authKeyId: entry.authKeyId + 1 }))).toBe('decrypt')
  })

  it('fails on any flipped ciphertext byte or a changed encapsulated key', () => {
    for (const i of [0, 1, 40, 127, 239, 240, 255]) expect(code(() => open({ ...entry, sealed: flip(entry.sealed, i) }))).toBe('decrypt')
    expect(code(() => open({ ...entry, enc: flip(entry.enc, 5) }))).toBe('decrypt')
    expect(code(() => open({ ...entry, enc: new Uint8Array(32) }))).toBe('decrypt')
  })

  it('refuses an unknown version, a short enc, and a length no format has, before the passkey check', () => {
    expect(code(() => open({ ...entry, version: 2 }))).toBe('version')
    expect(code(() => open({ ...entry, enc: entry.enc.slice(0, 31) }))).toBe('format')
    expect(code(() => open({ ...entry, sealed: entry.sealed.slice(0, 255) }, { prf: H('wrong') }))).toBe('format')
    expect(code(() => open({ ...entry, sealed: new Uint8Array(96) }, { prf: H('wrong') }))).toBe('format')
    // malformed fields read from the chain are the entry's fault
    expect(code(() => open({ ...entry, credentialId: new Uint8Array(8) }))).toBe('format')
    expect(code(() => open({ ...entry, recipientKey: new Uint8Array(31) }))).toBe('format')
    // Yappr (not strict) still accepts only its two lengths
    const y = loadVectors<VectorFile>('yappr').vectors[0]!
    const yEntry = { version: 1, credentialId: hexToBytes(y.credentialId), recipientKey: hexToBytes(req(y.recipientKey, 'rk')), authKeyId: 2, enc: hexToBytes(req(y.enc, 'enc')), sealed: new Uint8Array(100) }
    expect(code(() => openEntry(yapprProfile, { contractId, ownerId, entry: yEntry, prfOutput: H('wrong') }))).toBe('format')
  })

  it('refuses an unknown format byte, non-zero padding and a slot 0 that is not the entry key, inside a valid ciphertext', () => {
    const good = forgeSlots.encode(slotBundle(1, v.keys))
    const unknown = good.slice()
    unknown[0] = 9
    expect(code(() => open(sealRaw(unknown)))).toBe('format')
    expect(code(() => open(sealRaw(flip(good, 239))))).toBe('bundle')
    expect(() => open(sealRaw(good, 99))).toThrow(/slot 0/)
    const empty = good.slice()
    empty[1] = 0
    expect(code(() => open(sealRaw(empty)))).toBe('bundle')
  })

  it('opens a forged bundle sealed to the right recipient: only the chain check can refuse it', () => {
    const forged = sealEntry(forgeProfile, {
      contractId,
      ownerId,
      credentialId,
      recipientKey,
      bundle: { format: 1, keys: [{ purpose: 0, securityLevel: 2, keyType: 0, keyId: 5, privateKey: H('attacker key') }] },
      codec: forgeSlots,
    })
    expect(hex(open(forged).bundle.keys[0]!.privateKey)).toBe(hex(H('attacker key')))
  })

  it('seals only with a codec of the profile, with an entry key id that agrees with slot 0', () => {
    const base = { contractId, ownerId, credentialId, recipientKey, bundle: slotBundle(1, v.keys) }
    expect(() => sealEntry(forgeProfile, { ...base, codec: yapprRaw })).toThrow(/not one of the profile/)
    expect(() => sealEntry(forgeProfile, { ...base, codec: forgeSlots, authKeyId: 6 })).toThrow(/slot 0/)
    expect(sealEntry(forgeProfile, { ...base, codec: forgeSlots, authKeyId: 5 }).authKeyId).toBe(5)
    expect(() => sealEntry(govhubProfile, { ...base, bundle: { format: 1, identityIndex: 0, entropy: new Uint8Array(16) }, codec: govhubSeed })).toThrow(/key id/)
  })

  it('refuses malformed ids, recipient keys, PRF outputs and credential ids', () => {
    expect(() => prfInput(forgeProfile, new Uint8Array(31))).toThrow(/32 bytes/)
    expect(() => hpkeInfo(forgeProfile, contractId, new Uint8Array(33))).toThrow(/32 bytes/)
    expect(() => recipientFromPrf(new Uint8Array(16))).toThrow(/32 bytes/)
    expect(() => entryAad(forgeProfile, { version: 1, credentialId: new Uint8Array(15), recipientKey, authKeyId: 1 })).toThrow(/16 to 255/)
    expect(() => entryAad(forgeProfile, { version: 1, credentialId: new Uint8Array(256), recipientKey, authKeyId: 1 })).toThrow(/16 to 255/)
    expect(() => entryAad(forgeProfile, { version: 0, credentialId, recipientKey, authKeyId: 1 })).toThrow(/version/)
    expect(() => entryAad(forgeProfile, { version: 1, credentialId, recipientKey, authKeyId: 2 ** 32 })).toThrow(/key id/)
    expect(() => entryAad(forgeProfile, { version: 1, credentialId, recipientKey: new Uint8Array(31), authKeyId: 1 })).toThrow(/recipient/)
  })

  it('profiles give different bytes for the same inputs (labels are domain separation)', () => {
    const forgeInfo = hex(hpkeInfo(forgeProfile, contractId, ownerId))
    expect(forgeInfo).not.toBe(hex(hpkeInfo(yapprProfile, contractId, ownerId)))
    expect(hex(prfInput(forgeProfile, contractId))).not.toBe(hex(prfInput(yapprProfile, contractId)))
    const fields = { version: 1, credentialId, recipientKey, authKeyId: 1 }
    expect(hex(entryAad(govhubProfile, fields))).not.toBe(hex(entryAad(forgeProfile, fields)))
    // Yappr and Forge share the doc type, so only info and the PRF input separate them
    expect(hex(entryAad(yapprProfile, fields))).toBe(hex(entryAad(forgeProfile, fields)))
    expect(code(() => openEntry(yapprProfile, { contractId, ownerId, entry, prfOutput: prf }))).toBe('format')
  })
})

describe('the independent generator', () => {
  const python = (() => {
    try {
      execFileSync('python3', ['-c', 'import cryptography'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()

  // CI sets PASSKEY_VAULT_REQUIRE_PYTHON=1 so the cross-check cannot be skipped silently there
  const required = process.env.PASSKEY_VAULT_REQUIRE_PYTHON === '1'

  it.skipIf(!python && !required)('reproduces RFC 9180 A.2, Yappr and govhub, and forge.json/govhub.json are what it writes', () => {
    const script = fileURLToPath(new URL('./__vectors__/generate.py', import.meta.url))
    expect(execFileSync('python3', ['-I', script, '--check'], { encoding: 'utf8' })).toMatch(/up to date/)
  })
})
