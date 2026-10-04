import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { HandoffError, base64urlDecode, base64urlEncode, handoffCommand, handoffRequest, networkFlag, openHandoffReply, parseHandoffPayload } from './key-handoff'

const vector = (name: string): { input: Record<string, string>; expected: Record<string, string> } =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../forge-contracts/vectors', `${name}.json`), 'utf8'))

const hex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16))
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('base64url', () => {
  it('round-trips every length', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff)
      expect(base64urlDecode(base64urlEncode(bytes))).toEqual(bytes)
    }
  })
  it('decodes strictly, as Rust URL_SAFE_NO_PAD does', () => {
    expect(base64urlDecode('AA==')).toBeNull()
    expect(base64urlDecode('A')).toBeNull()
    expect(base64urlDecode('AB')).toBeNull() // stray bits in the last character
    expect(base64urlDecode('a+b/')).toBeNull()
    expect(base64urlDecode('AA')).toEqual(new Uint8Array([0]))
  })
})

describe('key handoff', () => {
  const v = vector('key_handoff__limited_key')

  it('opens the reply dg sealed, and only for its network', async () => {
    const plain = await openHandoffReply(v.expected.reply as string, 'sakura', hex(v.input.browserSecret as string))
    const p = parseHandoffPayload(plain, 'sakura')
    expect(p).toMatchObject({ identityId: '8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB', keyId: 7, replacedKeyId: 5 })
    expect(plain.every((b) => b === 0)).toBe(true)
    await expect(openHandoffReply(v.expected.reply as string, 'testnet', hex(v.input.browserSecret as string))).rejects.toMatchObject({ kind: 'network' })
  })

  it('refuses a payload it does not know, or for another network', () => {
    const ok = { v: 1, network: 'sakura', identityId: 'x', keyId: 3, wif: 'w' }
    expect(parseHandoffPayload(enc(JSON.stringify(ok)), 'sakura').keyId).toBe(3)
    for (const bad of [
      { ...ok, v: 2 },
      { ...ok, network: 'testnet' },
      { ...ok, keyId: -1 },
      { ...ok, extra: true },
      { ...ok, encryptionKey: { keyId: 4, privateKeyHex: 'zz' } },
      { ...ok, encryptionKey: { keyId: 4, privateKeyHex: '0'.repeat(64), more: 1 } },
    ]) {
      expect(() => parseHandoffPayload(enc(JSON.stringify(bad)), 'sakura')).toThrow(HandoffError)
    }
    expect(() => parseHandoffPayload(enc('not json'), 'sakura')).toThrow(HandoffError)
  })

  it('builds the dg command the tab shows', () => {
    const r = handoffRequest('sakura', hex(v.input.browserSecret as string))
    expect(handoffCommand(r, { days: 365, budgetDash: 0.05, withEncryptionKey: true, replaceKeyId: 5 })).toBe(
      `dg auth keys add --network sakura --for-browser ${v.expected.request} --budget 0.05 --expires 365d --replace 5 --with-encryption-key`,
    )
    r.wipe()
    expect(r.secret.every((b) => b === 0)).toBe(true)
  })

  it('names the network the way dg takes it', () => {
    expect(networkFlag('devnet-sakura')).toBe('--devnet-name sakura')
    expect(networkFlag('testnet')).toBe('--network testnet')
  })

  it('makes a fresh one-time key for every request', () => {
    expect(handoffRequest('sakura').text).not.toBe(handoffRequest('sakura').text)
    expect(() => handoffRequest('sa kura')).toThrow()
  })
})
