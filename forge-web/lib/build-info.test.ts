import { describe, expect, it } from 'vitest'

import { commitUrl, servedCid, shortCid, verifyGuideUrl } from './build-info'

const V1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'

const at = (url: string): Pick<Location, 'protocol' | 'hostname' | 'pathname'> => {
  const u = new URL(url)
  return { protocol: u.protocol, hostname: u.hostname, pathname: u.pathname }
}

describe('the CID the app was loaded as', () => {
  it('is read from a subdomain gateway, a path gateway and ipfs://', () => {
    expect(servedCid(at(`https://${V1}.ipfs.dweb.link/explore/`))).toBe(V1)
    expect(servedCid(at(`http://${V1}.ipfs.localhost:8080/`))).toBe(V1)
    expect(servedCid(at(`https://ipfs.io/ipfs/${V1}/repo/?owner=a`))).toBe(V1)
    expect(servedCid(at(`https://ipfs.io/ipfs/${V0}/`))).toBe(V0)
    expect(servedCid(at(`ipfs://${V1}/explore/`))).toBe(V1)
  })

  it('is none on an ordinary host, an IPNS name or anything that is not a CID', () => {
    expect(servedCid(at('https://forge.dashhq.org/explore/'))).toBeNull()
    expect(servedCid(at('https://ipfs.io/ipns/forge.example/'))).toBeNull()
    expect(servedCid(at('https://example.com/ipfs/not-a-cid/'))).toBeNull()
    expect(servedCid(at('https://www.ipfs.tech/'))).toBeNull()
  })
})

describe('links and labels', () => {
  it('pin the verify guide and the commit to the build', () => {
    const c = 'a'.repeat(40)
    expect(verifyGuideUrl(c)).toBe(`https://github.com/PastaPastaPasta/dash-forge/blob/${c}/docs/guides/verify-the-app.md`)
    expect(verifyGuideUrl('')).toContain('/blob/master/')
    expect(commitUrl(c)).toBe(`https://github.com/PastaPastaPasta/dash-forge/commit/${c}`)
    expect(commitUrl('')).toBeNull()
  })

  it('shorten a CID', () => {
    expect(shortCid(V1)).toBe('bafybeigdy…5fbzdi')
    expect(shortCid('bafyshort')).toBe('bafyshort')
  })
})
