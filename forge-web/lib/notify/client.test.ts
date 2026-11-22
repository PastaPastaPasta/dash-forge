import { describe, expect, it } from 'vitest'
import * as secp from '@noble/secp256k1'
import { bytesToHex } from '@noble/hashes/utils.js'

import { encodeWif } from '../auth/wif'
import { base64ToBytes, bytesToBase64 } from '../sdk/query'
import { KEY_TYPE_ECDSA_HASH160, buildRequest, normalizeUrl, requestDigest, signEnvelope, signRequest, vapidKeyBytes } from './client'

// The shared vector (`docs/design/service-auth.md`; the service's `auth::tests::the_shared_test_vector`):
// RFC 6979 makes the signature deterministic, so both sides must produce these exact bytes.
const REQUEST =
  '{"v":1,"service":"notify.example.org","action":"account.get","identity":"FrNpRnZQPP5gLFAjD7Foz4tZaML5DJ88CqaCvAkYNYjU","key":2,"nonce":"AAAAAAAAAAAAAAAAAAAAAA","time":1791130000,"payload":{}}'
const DIGEST = 'cd567e6ae5db8dd515af7665c245c9c93af9239ae54698f55ff539d20768a8c6'
const SIGNATURE = 'i906pPEDYL304mGyHNxTsDavUvq0N+W0mVDHZ6lqigdj3AonKOZ9qCYIyvQ9xkvowx8LYouvBs69t/2iiX0HKw=='

describe('notify signed requests', () => {
  it('builds the request text in the documented field order', () => {
    expect(
      buildRequest({
        service: 'notify.example.org',
        action: 'account.get',
        identity: 'FrNpRnZQPP5gLFAjD7Foz4tZaML5DJ88CqaCvAkYNYjU',
        key: 2,
        nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
        time: 1791130000,
        payload: {},
      }),
    ).toBe(REQUEST)
  })

  it('matches the service on the shared vector', () => {
    expect(bytesToHex(requestDigest(REQUEST))).toBe(DIGEST)
    expect(signRequest(REQUEST, new Uint8Array(32).fill(0x11))).toBe(SIGNATURE)
  })
})

describe('notify envelopes', () => {
  const secret = new Uint8Array(32).fill(0x11)
  const wif = encodeWif(secret, 'testnet')

  it('sends only request and signature for a key whose data is its public key', () => {
    for (const keyType of [undefined, 0]) {
      const env = signEnvelope(REQUEST, { wif, keyType })
      expect(env).toEqual({ request: REQUEST, signature: SIGNATURE })
      expect(Object.keys(JSON.parse(JSON.stringify(env)))).toEqual(['request', 'signature'])
    }
  })

  it('adds the compressed public key for an ECDSA_HASH160 key, and it verifies the signature', () => {
    const env = signEnvelope(REQUEST, { wif, keyType: KEY_TYPE_ECDSA_HASH160 })
    const pub = secp.getPublicKey(secret, true)
    expect(env).toEqual({ request: REQUEST, signature: SIGNATURE, public_key: bytesToBase64(pub) })
    expect(secp.verify(base64ToBytes(env.signature), requestDigest(REQUEST), base64ToBytes(env.public_key!), { prehash: false, format: 'compact' })).toBe(true)
  })
})

describe('notify config', () => {
  it('takes https, or http on loopback only, and drops a trailing slash', () => {
    expect(normalizeUrl(undefined)).toBeNull()
    expect(normalizeUrl('  ')).toBeNull()
    expect(normalizeUrl('https://notify.example.org/')).toBe('https://notify.example.org')
    expect(normalizeUrl('https://example.org/notify//')).toBe('https://example.org/notify')
    expect(normalizeUrl('http://127.0.0.1:18200')).toBe('http://127.0.0.1:18200')
    expect(normalizeUrl('http://notify.example.org')).toBeNull()
    expect(normalizeUrl('javascript:alert(1)')).toBeNull()
  })

  it('decodes a base64url VAPID key', () => {
    expect(Array.from(vapidKeyBytes('BAEC_-8'))).toEqual([4, 1, 2, 255, 239])
  })
})
