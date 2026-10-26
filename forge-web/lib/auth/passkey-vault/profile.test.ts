/**
 * Forge's real passkey-vault profile reproduces the bytes `__vectors__/forge.json` pins (written by
 * the core's independent Python generator): any drift here would orphan every Forge passkey.
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'

import { entryAad, hpkeInfo, openEntry, prfInput, recipientFromPrf, sealEntry, type SlotKey } from '../../vendor/platform-auth/passkey-vault'
import { forgeProfile } from '../../vendor/platform-auth/passkey-vault/__fixtures__/profiles'
import { loadVectors, req, slotBundle, type VectorFile } from '../../vendor/platform-auth/passkey-vault/__fixtures__/vectors'
import { FORGE_BUNDLE_CODEC, FORGE_BUNDLE_FORMAT, FORGE_VAULT_PROFILE } from './profile'

const file = loadVectors<VectorFile & { profile: Record<string, unknown> }>('forge')
const contractId = hexToBytes(file.contractId)
const ownerId = hexToBytes(file.ownerId)
const hex = bytesToHex
const shape = (keys: readonly SlotKey[]) => keys.map((k) => ({ ...k, privateKey: hex(k.privateKey) }))

describe("Forge's passkey-vault profile", () => {
  it('is the profile the vectors were generated for', () => {
    const { formats, ...labels } = file.profile as { formats: { id: number; length: number; maxKeys: number }[] }
    expect(labels).toEqual({
      prfLabel: FORGE_VAULT_PROFILE.prfLabel,
      infoLabel: FORGE_VAULT_PROFILE.infoLabel,
      aadDocType: FORGE_VAULT_PROFILE.aadDocType,
      entryVersion: FORGE_VAULT_PROFILE.entryVersion,
      strictSealedLength: FORGE_VAULT_PROFILE.strictSealedLength,
    })
    expect(formats.map((f) => ({ id: f.id, length: f.length, maxKeys: f.maxKeys }))).toEqual([{ id: FORGE_BUNDLE_FORMAT, length: FORGE_BUNDLE_CODEC.length, maxKeys: 6 }])
    expect(FORGE_VAULT_PROFILE.formats).toEqual([FORGE_BUNDLE_CODEC])
  })

  for (const v of file.vectors) {
    it(`${v.name}: seals and opens to the generator's bytes`, () => {
      const prf = hexToBytes(v.prfOutput)
      expect(hex(prfInput(FORGE_VAULT_PROFILE, contractId))).toBe(req(v.prfInput, 'prfInput'))
      const recipient = recipientFromPrf(prf)
      expect(hex(recipient.privateKey)).toBe(req(v.recipientSk, 'recipientSk'))
      expect(hex(recipient.publicKey)).toBe(req(v.recipientKey, 'recipientKey'))
      const entry = sealEntry(FORGE_VAULT_PROFILE, {
        contractId,
        ownerId,
        credentialId: hexToBytes(v.credentialId),
        recipientKey: recipient.publicKey,
        bundle: slotBundle(FORGE_BUNDLE_FORMAT, v.keys),
        codec: FORGE_BUNDLE_CODEC,
        ephemeralIkm: hexToBytes(v.ephemeralIkm),
      })
      expect(entry.authKeyId).toBe(req(v.authKeyId, 'authKeyId'))
      expect(hex(hpkeInfo(FORGE_VAULT_PROFILE, contractId, ownerId))).toBe(req(v.info, 'info'))
      expect(hex(entryAad(FORGE_VAULT_PROFILE, entry))).toBe(req(v.aad, 'aad'))
      expect(hex(FORGE_BUNDLE_CODEC.encode(slotBundle(FORGE_BUNDLE_FORMAT, v.keys)))).toBe(req(v.bundle, 'bundle'))
      expect(hex(entry.enc)).toBe(req(v.enc, 'enc'))
      expect(hex(entry.sealed)).toBe(req(v.sealed, 'sealed'))
      expect(entry.sealed).toHaveLength(256)

      const opened = openEntry(FORGE_VAULT_PROFILE, { contractId, ownerId, entry, prfOutput: prf })
      expect(opened.codec).toBe(FORGE_BUNDLE_CODEC)
      expect(shape(opened.bundle.keys)).toEqual(shape(slotBundle(FORGE_BUNDLE_FORMAT, v.keys).keys))
      // The core's fixture profile opens Forge's entries too: the same bytes, whatever the rules.
      expect(shape(openEntry(forgeProfile, { contractId, ownerId, entry, prfOutput: prf }).bundle.keys)).toEqual(shape(opened.bundle.keys))
    })
  }

  it('refuses MASTER, CRITICAL, TRANSFER and a second encryption key in a bundle', () => {
    const sk = (n: number) => new Uint8Array(32).fill(n)
    const main: SlotKey = { purpose: 0, securityLevel: 2, keyType: 0, keyId: 1, privateKey: sk(1) }
    const enc = (keyId: number): SlotKey => ({ purpose: 1, securityLevel: 3, keyType: 0, keyId, privateKey: sk(keyId) })
    const encode = (keys: SlotKey[]) => FORGE_BUNDLE_CODEC.encode({ format: FORGE_BUNDLE_FORMAT, keys })
    expect(() => encode([main, enc(2)])).not.toThrow()
    expect(() => encode([{ ...main, securityLevel: 0 }])).toThrow(/slot 0/)
    expect(() => encode([{ ...main, securityLevel: 1 }])).toThrow(/slot 0/)
    expect(() => encode([main, { ...main, keyId: 2, purpose: 3 }])).toThrow(/slot 1/)
    expect(() => encode([enc(2)])).toThrow(/slot 0/)
    expect(() => encode([main, enc(2), enc(3)])).toThrow(/one encryption key/)
  })
})
