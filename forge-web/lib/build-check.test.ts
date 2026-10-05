/** Whether this copy of the app is a published build: its manifest, attested by this repository's CI. */

import { describe, expect, it } from 'vitest'

import { checkBuild, siteRoot } from './build-check'

const ok = (body: unknown): Response => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 })

function fetcher(manifest: Response | Error, github: Response | Error): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    const r = url.includes('api.github.com') ? github : manifest
    if (r instanceof Error) throw r
    return r
  }) as typeof fetch
  return { fetch: impl, urls }
}

describe('checkBuild', () => {
  it('is published when GitHub holds an attestation of the served manifest', async () => {
    const f = fetcher(ok('{"format":1}'), ok({ attestations: [{}] }))
    expect(await checkBuild('https://forge.example/', f.fetch)).toBe('published')
    expect(f.urls[0]).toBe('https://forge.example/forge-manifest.json')
    // sha256('{"format":1}')
    expect(f.urls[1]).toMatch(/\/repos\/PastaPastaPasta\/dash-forge\/attestations\/sha256:[0-9a-f]{64}$/)
  })

  it('is unpublished without a manifest or an attestation', async () => {
    expect(await checkBuild('https://x/', fetcher(new Response('', { status: 404 }), ok({ attestations: [] })).fetch)).toBe('unpublished')
    expect(await checkBuild('https://x/', fetcher(ok('{}'), ok({ attestations: [] })).fetch)).toBe('unpublished')
  })

  it('is unknown when the manifest or GitHub cannot be read', async () => {
    expect(await checkBuild('https://x/', fetcher(new Error('offline'), ok({})).fetch)).toBe('unknown')
    expect(await checkBuild('https://x/', fetcher(ok('{}'), new Response('', { status: 403 })).fetch)).toBe('unknown')
    expect(await checkBuild('https://x/', fetcher(ok('{}'), new Error('offline')).fetch)).toBe('unknown')
  })
})

describe('siteRoot', () => {
  it('uses the IPFS variant <base>, else the origin and base path', () => {
    const withBase = { baseURI: 'https://gw.example/ipfs/bafy/', querySelector: () => ({}) as Element }
    expect(siteRoot(withBase, { origin: 'https://gw.example' })).toBe('https://gw.example/ipfs/bafy/')
    const host = { baseURI: 'https://forge.example/a/b/', querySelector: () => null }
    expect(siteRoot(host, { origin: 'https://forge.example' })).toBe('https://forge.example/')
  })
})
