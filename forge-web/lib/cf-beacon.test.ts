import { describe, expect, it } from 'vitest'
import { CF_BEACON_INTEGRITY, CF_BEACON_SRC, cfBeacon } from './cf-beacon'

const TOKEN = '87b4d7fbbb4f476895825bf0e361acb6'

describe('cfBeacon', () => {
  it('is off without a token', () => {
    expect(cfBeacon(undefined, false)).toBeNull()
    expect(cfBeacon('', false)).toBeNull()
    expect(cfBeacon(undefined, true)).toBeNull()
  })

  it('pins the script and carries the token', () => {
    const beacon = cfBeacon(TOKEN, false)
    expect(beacon).toEqual({ src: CF_BEACON_SRC, integrity: CF_BEACON_INTEGRITY, config: `{"token":"${TOKEN}"}` })
    expect(CF_BEACON_SRC).toMatch(/^https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/v[0-9a-f]+$/)
  })

  it('refuses a token that is not one, since it lands in the page markup', () => {
    expect(() => cfBeacon(`${TOKEN}"`, false)).toThrow(/not a Cloudflare Web Analytics site token/)
    expect(() => cfBeacon(TOKEN.toUpperCase(), false)).toThrow(/not a Cloudflare/)
  })

  it('refuses the IPFS build', () => {
    expect(() => cfBeacon(TOKEN, true)).toThrow(/IPFS build carries no analytics/)
  })
})
