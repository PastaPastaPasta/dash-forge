import { describe, expect, it } from 'vitest'
import * as secp from '@noble/secp256k1'

import vectors from '../../../forge-contracts/fixtures/user-sync/vectors.json'
import { decodeIdentifier } from '../auth/base58'
import {
  PIECE_BYTES,
  SyncDecryptError,
  SyncTooLargeError,
  canonicalJson,
  decodePlain,
  ecdhX,
  encodePlain,
  grantWrapKey,
  inflateRaw,
  openShare,
  openShareBytes,
  openState,
  openStateBytes,
  repoStorageKey,
  sealShare,
  sealShareBytes,
  sealState,
  sealStateBytes,
  shareAad,
  stateAad,
  stateKey,
  unwrapGrant,
  wrapGrant,
  type StateFields,
} from './crypto'

const hex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'hex'))
const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

const network = vectors.network
const ownerId = decodeIdentifier(vectors.ownerId)
const memberId = decodeIdentifier(vectors.memberId)
const repoId = decodeIdentifier(vectors.repoId)
const ownerE = hex(vectors.ownerEncPrivHex)
const memberE = hex(vectors.memberEncPrivHex)
const ctx = { E: ownerE, keyId: vectors.ownerKeyId, identityId: ownerId, network }
const grantParams = {
  network,
  ownerId,
  repoId,
  memberId,
  epoch: vectors.grant.epoch,
  senderKeyId: vectors.grant.senderKeyId,
  recipientKeyId: vectors.grant.recipientKeyId,
}

describe('forge-user sync vectors', () => {
  it('public keys match the private keys', () => {
    expect(toHex(secp.getPublicKey(ownerE, true))).toBe(vectors.ownerEncPubHex)
    expect(toHex(secp.getPublicKey(memberE, true))).toBe(vectors.memberEncPubHex)
  })

  for (const s of vectors.state) {
    describe(`state ${s.slot}`, () => {
      const pieces = (['d0Hex', 'd1Hex', 'd2Hex'] as const).map((k) => (s as Record<string, unknown>)[k]).filter((x): x is string => typeof x === 'string')

      it('derives the key and AAD', async () => {
        expect(toHex(await stateKey(ownerE, ownerId, network, s.slot))).toBe(s.keyHex)
        expect(toHex(stateAad(network, ownerId, s.slot, s.v, vectors.ownerKeyId))).toBe(s.aadHex)
      })

      it('decrypts and inflates to the plaintext', async () => {
        const doc: StateFields = { slot: s.slot, v: s.v, keyId: vectors.ownerKeyId, n: hex(s.nonceHex), d0: hex(pieces[0]!), ...(pieces[1] ? { d1: hex(pieces[1]) } : {}), ...(pieces[2] ? { d2: hex(pieces[2]) } : {}) }
        expect(pieces.join('')).toBe(s.ciphertextHex)
        const compressed = await openStateBytes(ctx, doc)
        if ('compressedHex' in s) expect(toHex(compressed)).toBe(s.compressedHex)
        expect(new TextDecoder().decode(inflateRaw(compressed))).toBe(canonicalJson(s.plaintextJson))
        expect(await openState(ctx, doc)).toEqual(s.plaintextJson)
      })

      if ('compressedHex' in s) {
        it('encrypts the compressed plaintext to the ciphertext with the fixed nonce', async () => {
          const doc = await sealStateBytes(ctx, s.slot, hex(s.compressedHex as string), hex(s.nonceHex))
          expect(toHex(doc.d0)).toBe(s.d0Hex)
          expect(doc.d1).toBeUndefined()
        })
      }

      it('round-trips through this app\'s compressor', async () => {
        const doc = await sealState(ctx, s.slot, s.plaintextJson, hex(s.nonceHex))
        expect(await openState(ctx, doc)).toEqual(s.plaintextJson)
      })
    })
  }

  it('splits the big entry past one piece, re-encrypting to the same bytes', async () => {
    const big = vectors.state.find((s) => s.slot === 'big')!
    const d2Hex = big.d2Hex as string | null
    const ct = hex(big.ciphertextHex)
    expect(ct.length).toBeGreaterThan(PIECE_BYTES)
    const doc: StateFields = { slot: 'big', v: 1, keyId: vectors.ownerKeyId, n: hex(big.nonceHex), d0: hex(big.d0Hex), d1: hex(big.d1Hex!), ...(d2Hex ? { d2: hex(d2Hex) } : {}) }
    const compressed = await openStateBytes(ctx, doc)
    const again = await sealStateBytes(ctx, 'big', compressed, hex(big.nonceHex))
    expect(toHex(again.d0)).toBe(big.d0Hex)
    expect(toHex(again.d1!)).toBe(big.d1Hex)
    expect(again.d2 === undefined ? null : toHex(again.d2)).toBe(d2Hex)
    expect(decodePlain(compressed)).toEqual(big.plaintextJson)
  })

  it('refuses a state under another key id, slot or identity', async () => {
    const s = vectors.state[0]!
    const doc: StateFields = { slot: s.slot, v: 1, keyId: vectors.ownerKeyId, n: hex(s.nonceHex), d0: hex(s.d0Hex) }
    await expect(openStateBytes({ ...ctx, keyId: 8 }, { ...doc, keyId: 8 })).rejects.toBeInstanceOf(SyncDecryptError)
    await expect(openStateBytes(ctx, { ...doc, slot: 'prefs' })).rejects.toBeInstanceOf(SyncDecryptError)
    await expect(openStateBytes({ ...ctx, identityId: memberId }, doc)).rejects.toBeInstanceOf(SyncDecryptError)
  })

  it('derives the repo storage key and share AAD, and opens the share', async () => {
    const share = vectors.share
    const rsk = await repoStorageKey(ownerE, repoId, network, share.epoch)
    expect(toHex(rsk)).toBe(share.rskHex)
    expect(toHex(shareAad(network, repoId, share.epoch, vectors.ownerKeyId))).toBe(share.aadHex)
    const ct = hex(share.ciphertextHex)
    const doc = { epoch: share.epoch, keyId: vectors.ownerKeyId, n: hex(share.nonceHex), d0: ct.slice(0, PIECE_BYTES), ...(ct.length > PIECE_BYTES ? { d1: ct.slice(PIECE_BYTES) } : {}) }
    const compressed = await openShareBytes(rsk, { network, repoId }, doc)
    expect(await openShare(rsk, { network, repoId }, doc)).toEqual(share.plaintextJson)
    const again = await sealShareBytes(rsk, { network, repoId, epoch: share.epoch, keyId: vectors.ownerKeyId }, compressed, hex(share.nonceHex))
    expect(toHex(again.d0) + (again.d1 ? toHex(again.d1) : '')).toBe(share.ciphertextHex)
    const fresh = await sealShare(rsk, { network, repoId, epoch: share.epoch, keyId: vectors.ownerKeyId }, share.plaintextJson)
    expect(await openShare(rsk, { network, repoId }, fresh)).toEqual(share.plaintextJson)
    await expect(openShare(rsk, { network, repoId }, { ...doc, epoch: share.epoch + 1 })).rejects.toBeInstanceOf(SyncDecryptError)
  })

  it('computes the ECDH secret and the grant wrap key from both sides', async () => {
    const g = vectors.grant
    expect(toHex(ecdhX(ownerE, hex(vectors.memberEncPubHex)))).toBe(g.sharedXHex)
    expect(toHex(ecdhX(memberE, hex(vectors.ownerEncPubHex)))).toBe(g.sharedXHex)
    expect(toHex(await grantWrapKey(hex(g.sharedXHex), grantParams))).toBe(g.wrapKeyHex)
    expect(toHex(ownerId)).toBe(g.aadHex)
  })

  it('wraps the repo storage key to the vector bytes and unwraps it as the member', async () => {
    const g = vectors.grant
    const rsk = hex(vectors.share.rskHex)
    const wrapped = await wrapGrant(ownerE, hex(vectors.memberEncPubHex), grantParams, rsk, hex(g.wrappedHex).slice(0, 12))
    expect(toHex(wrapped)).toBe(g.wrappedHex)
    expect(wrapped.length).toBe(60)
    expect(toHex(await unwrapGrant(memberE, hex(vectors.ownerEncPubHex), grantParams, hex(g.wrappedHex)))).toBe(vectors.share.rskHex)
    await expect(unwrapGrant(memberE, hex(vectors.ownerEncPubHex), { ...grantParams, epoch: g.epoch + 1 }, hex(g.wrappedHex))).rejects.toBeInstanceOf(SyncDecryptError)
    await expect(unwrapGrant(memberE, hex(vectors.ownerEncPubHex), { ...grantParams, ownerId: memberId }, hex(g.wrappedHex))).rejects.toBeInstanceOf(SyncDecryptError)
  })

  it('refuses a deflate bomb past the size limit', () => {
    const bomb = encodePlain({ x: 'a'.repeat(4096) })
    expect(() => inflateRaw(bomb, 1024)).toThrow(/size limit/)
  })

  it('never writes what a reader would refuse to inflate', () => {
    expect(() => encodePlain({ x: 'a'.repeat(1 << 20) })).toThrow(SyncTooLargeError)
  })

  it('splits ciphertext past 10,000 bytes into three pieces and opens them again', async () => {
    const noise = Buffer.from(crypto.getRandomValues(new Uint8Array(11_000))).toString('base64')
    const doc = await sealState(ctx, 'big3', { noise })
    expect(doc.d2).toBeDefined()
    expect(doc.d0.length + doc.d1!.length + doc.d2!.length).toBeGreaterThan(10_000)
    expect(await openState(ctx, doc)).toEqual({ noise })
  })

  it('wraps only a 32-byte repo storage key', async () => {
    await expect(wrapGrant(ownerE, hex(vectors.memberEncPubHex), grantParams, new Uint8Array(33))).rejects.toThrow(/32 bytes/)
  })

  it('writes every array index, a hole as null, and refuses a value with no JSON form', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(canonicalJson([1, , 3])).toBe('[1,null,3]')
    expect(() => canonicalJson(undefined)).toThrow()
    expect(canonicalJson(null)).toBe('null')
  })
})
