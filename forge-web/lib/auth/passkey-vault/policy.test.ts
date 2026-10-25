/** Where a passkey that holds a key on Platform may be made: exactly two hosts, never a parent domain. */

import { describe, expect, it } from 'vitest'

import { passkeyVaultProblem, passkeyVaultRpId } from './policy'

const at = (hostname: string, pathname = '/') => ({ hostname, pathname })
const META = { meta: 'meta' }
const yes = () => true

describe('the passkey vault’s relying party', () => {
  it('is the page’s host, for forge.dashhq.org and localhost only', () => {
    expect(passkeyVaultRpId(at('forge.dashhq.org'))).toBe('forge.dashhq.org')
    expect(passkeyVaultRpId(at('FORGE.dashhq.org'))).toBe('forge.dashhq.org')
    expect(passkeyVaultRpId(at('localhost'))).toBe('localhost')
  })

  it.each([
    ['the parent domain', at('dashhq.org')],
    ['another subdomain', at('evil.dashhq.org')],
    ['a deeper subdomain', at('x.forge.dashhq.org')],
    ['an IPFS subdomain gateway', at('bafybeigdyrzt.ipfs.dweb.link')],
    ['an IPNS subdomain gateway', at('forge-dashhq-org.ipns.localhost')],
    ['a path gateway', at('localhost', '/ipfs/bafy/')],
    ['a shared host', at('someone.github.io')],
    ['an IP address', at('127.0.0.1')],
  ])('is refused on %s', (_what, location) => {
    expect(passkeyVaultRpId(location)).toBeNull()
    expect(passkeyVaultProblem(META, location, yes)).not.toBeNull()
  })

  it('is offered only where forge-meta exists and the browser has passkeys', () => {
    expect(passkeyVaultProblem(META, at('forge.dashhq.org'), yes)).toBeNull()
    expect(passkeyVaultProblem({}, at('forge.dashhq.org'), yes)).toMatch(/aren't available on this network/)
    expect(passkeyVaultProblem(null, at('forge.dashhq.org'), yes)).toMatch(/aren't available on this network/)
    expect(passkeyVaultProblem(META, at('forge.dashhq.org'), () => false)).toMatch(/can't use passkeys/)
    expect(passkeyVaultProblem(META, null, yes)).toMatch(/can't use passkeys/)
    expect(passkeyVaultProblem(META, at('someone.github.io'), yes)).toMatch(/dedicated origin/)
  })
})
