import { describe, expect, it } from 'vitest'
import { bytesToHex } from '@noble/hashes/utils.js'

import { buildRequest, normalizeUrl, requestDigest, signRequest, vapidKeyBytes } from './client'

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
