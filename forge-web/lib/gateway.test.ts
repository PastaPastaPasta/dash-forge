/**
 * The optional gateway's config, the smart-HTTP ref advertisement parser, and the browser's
 * mirror check (parity with forge-core `mirror::compare` for the refs a page proves).
 */

import { describe, expect, it } from 'vitest'

import { compareMirror, gatewayCloneUrl, gatewayConfig, parseAdvertisement, verifyGateway, type ProvedRef } from './gateway'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)

/** A pkt-line of `s`. */
const pkt = (s: string): string => {
  const n = new TextEncoder().encode(s).length + 4
  return n.toString(16).padStart(4, '0') + s
}

/** What `git http-backend` answers to `info/refs?service=git-upload-pack` (protocol v0). */
function advertisement(refs: [string, string][]): Uint8Array<ArrayBuffer> {
  let out = pkt('# service=git-upload-pack\n') + '0000'
  refs.forEach(([oid, name], i) => {
    out += pkt(i === 0 ? `${oid} ${name}\0multi_ack side-band-64k symref=HEAD:refs/heads/main\n` : `${oid} ${name}\n`)
  })
  return new TextEncoder().encode(out + '0000')
}

describe('gatewayConfig', () => {
  it('is off without a URL and labels the operator', () => {
    expect(gatewayConfig({})).toBeNull()
    expect(gatewayConfig({ url: '  ' })).toBeNull()
    expect(gatewayConfig({ url: 'https://git.forge.dashhq.org/' })).toEqual({ url: 'https://git.forge.dashhq.org', label: 'dashhq gateway' })
    expect(gatewayConfig({ url: 'http://localhost:8080', label: 'my gateway' })).toEqual({ url: 'http://localhost:8080', label: 'my gateway' })
  })

  it('refuses what is not a plain http(s) base URL', () => {
    for (const url of ['javascript:alert(1)', 'ftp://x', 'not a url', 'https://g/?a=1', 'https://user:pw@g/']) {
      expect(gatewayConfig({ url })).toBeNull()
    }
  })

  it('builds the clone URL with encoded segments', () => {
    const g = { url: 'https://g', label: 'x' }
    expect(gatewayCloneUrl(g, 'alice', 'proj')).toBe('https://g/alice/proj.git')
    expect(gatewayCloneUrl(g, 'a b', 'p/q')).toBe('https://g/a%20b/p%2Fq.git')
  })
})

describe('parseAdvertisement', () => {
  it('reads the refs and leaves HEAD and peeled tags out', () => {
    const refs = parseAdvertisement(
      advertisement([
        [A, 'HEAD'],
        [A, 'refs/heads/main'],
        [B, 'refs/tags/v1'],
        [C, 'refs/tags/v1^{}'],
      ]),
    )
    expect([...refs]).toEqual([
      ['refs/heads/main', A],
      ['refs/tags/v1', B],
    ])
  })

  it('counts bytes, not characters', () => {
    const refs = parseAdvertisement(advertisement([[A, 'refs/heads/café'], [B, 'refs/heads/main']]))
    expect(refs.get('refs/heads/café')).toBe(A)
    expect(refs.get('refs/heads/main')).toBe(B)
  })

  it('refuses what is not an advertisement', () => {
    expect(() => parseAdvertisement(new TextEncoder().encode('<html>oops</html>'))).toThrow(/not a git ref advertisement/)
  })
})

describe('compareMirror', () => {
  const all = (): boolean => true
  const proved: ProvedRef[] = [
    { name: 'refs/heads/main', oid: B, changedAt: 30 },
    { name: 'refs/heads/dev', oid: A, changedAt: 10 },
  ]

  it('matches the proved tips', () => {
    const c = compareMirror(new Map([['refs/heads/main', B], ['refs/heads/dev', A]]), proved, 40, all)
    expect(c.verdict).toBe('match')
  })

  it('is stale when the ref moved after the snapshot, a mismatch when it did not', () => {
    const served = new Map([['refs/heads/main', A], ['refs/heads/dev', A]])
    expect(compareMirror(served, proved, 20, all).verdict).toBe('stale')
    expect(compareMirror(served, proved, null, all).verdict).toBe('stale')
    expect(compareMirror(served, proved, 40, all).verdict).toBe('mismatch')
  })

  it('flags refs Platform does not have, and omissions the snapshot should show', () => {
    const extra = compareMirror(new Map([['refs/heads/main', B], ['refs/heads/dev', A], ['refs/heads/evil', C]]), proved, 40, all)
    expect(extra.verdict).toBe('mismatch')
    expect(extra.refs.find((r) => r.name === 'refs/heads/evil')?.why).toMatch(/not a ref/)
    expect(compareMirror(new Map([['refs/heads/main', B]]), proved, 5, all).verdict).toBe('stale')
    expect(compareMirror(new Map([['refs/heads/main', B]]), proved, 40, all).verdict).toBe('mismatch')
  })

  it('judges only refs in scope', () => {
    const c = compareMirror(new Map([['refs/heads/main', B], ['refs/heads/dev', A], ['refs/notes/x', C]]), proved, 40, (n) => n.startsWith('refs/heads/'))
    expect(c.verdict).toBe('match')
  })
})

describe('verifyGateway', () => {
  const proved: ProvedRef[] = [{ name: 'refs/heads/main', oid: A, changedAt: 10 }]
  const manifest = { schema: 'forge-gateway-manifest/v1', repoId: 'R', network: 'devnet-sakura', platformHeight: 7, platformTimeMs: 20, fetchedAtMs: 30 }
  const fetchFrom =
    (routes: Record<string, () => Response>): typeof fetch =>
    async (input) => {
      const url = String(input)
      const hit = Object.entries(routes).find(([suffix]) => url.endsWith(suffix))
      if (hit === undefined) return new Response('not found', { status: 404 })
      return hit[1]()
    }

  it('reads the served refs and the manifest', async () => {
    const f = fetchFrom({
      '/info/refs?service=git-upload-pack': () => new Response(advertisement([[A, 'refs/heads/main']])),
      '/forge-manifest.json': () => Response.json(manifest),
    })
    const c = await verifyGateway('https://g/alice/proj.git', proved, { repoId: 'R', network: 'devnet-sakura' }, { fetchImpl: f })
    expect(c.verdict).toBe('match')
    expect(c.manifest?.platformHeight).toBe(7)
  })

  it('a manifest for another repository is a mismatch', async () => {
    const f = fetchFrom({
      '/info/refs?service=git-upload-pack': () => new Response(advertisement([[A, 'refs/heads/main']])),
      '/forge-manifest.json': () => Response.json({ ...manifest, repoId: 'OTHER' }),
    })
    const c = await verifyGateway('https://g/alice/proj.git', proved, { repoId: 'R', network: 'devnet-sakura' }, { fetchImpl: f })
    expect(c.verdict).toBe('mismatch')
    expect(c.problems[0]).toMatch(/OTHER/)
  })

  it('works without a manifest, and throws when the gateway is down', async () => {
    const f = fetchFrom({ '/info/refs?service=git-upload-pack': () => new Response(advertisement([[A, 'refs/heads/main']])) })
    const c = await verifyGateway('https://g/alice/proj.git', proved, { repoId: 'R', network: 'devnet-sakura' }, { fetchImpl: f })
    expect(c.manifest).toBeNull()
    expect(c.verdict).toBe('match')
    const down: typeof fetch = async () => {
      throw new TypeError('Failed to fetch')
    }
    await expect(verifyGateway('https://g/alice/proj.git', proved, { repoId: 'R', network: 'devnet-sakura' }, { fetchImpl: down })).rejects.toThrow(/Failed to fetch/)
    const refusing = fetchFrom({ '/info/refs?service=git-upload-pack': () => new Response('busy', { status: 503 }) })
    await expect(verifyGateway('https://g/alice/proj.git', proved, { repoId: 'R', network: 'devnet-sakura' }, { fetchImpl: refusing })).rejects.toThrow(/HTTP 503/)
  })
})
