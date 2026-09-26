/**
 * The storage layer, offline: profile validation, policies, URI ordering and budgets, chunk
 * splitting (parity with forge-core `pack::split`), the CORS fix blocks, the config sealed in
 * the vault, and the replication engine against in-memory S3 and kubo fakes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetMemoryStores, idbEntries } from '../idb'
import { lockVault, storeInVault, unlockWithPassphrase } from '../auth/vault'
import { splitChunks, manifestUrisProblem } from '../repo/push'
import { CHUNK_PAYLOAD_MAX, FIELD_MAX } from '../constants'
import { corsFix } from './cors'
import { cidV1RawLeaves } from './cid'
import {
  artifactKey,
  choiceOf,
  policyFor,
  profileProblem,
  type ProfilePublic,
  type StorageProfile,
} from './profiles'
import {
  EMPTY_STORAGE_CONFIG,
  loadStorageConfig,
  policyForRepo,
  policyProblem,
  saveStorageConfig,
  withProfile,
  withRepoPolicy,
  withoutProfile,
} from './store'
import { ReplicationError, PlatformDeclinedError, fitManifestUris, orderUris, storeArtifact } from './upload'
import { sha256Hex } from './sigv4'
import type { WriteAuth } from '../sdk'
import type { V2RepoRef } from '../repo/contract'
import type { EvoSDK } from '@dashevo/evo-sdk'

const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'

const S3: StorageProfile = {
  name: 'minio',
  settings: {
    kind: 's3',
    provider: 'minio',
    endpoint: 'http://127.0.0.1:9000',
    region: 'us-east-1',
    bucket: 'forge-byo',
    pathStyle: true,
    publicUrl: 'http://127.0.0.1:9000/forge-byo',
    prefix: 'web',
  },
  secrets: { accessKeyId: 'minioadmin', secretAccessKey: 'minio-secret-value' },
}

const KUBO: StorageProfile = {
  name: 'kubo',
  settings: { kind: 'ipfs-kubo', provider: 'kubo', api: 'http://127.0.0.1:5001', gateway: 'http://127.0.0.1:8081', publicGateway: '', pinningEndpoint: '' },
  secrets: {},
}

describe('profiles', () => {
  it('accepts a sound S3 profile and names what is wrong otherwise', () => {
    expect(profileProblem(S3)).toBeNull()
    const s3 = S3.settings as Extract<ProfilePublic, { kind: 's3' }>
    const bad = (patch: Partial<typeof s3>, secrets = S3.secrets): string | null => profileProblem({ ...S3, settings: { ...s3, ...patch }, secrets })
    expect(bad({ endpoint: 'https://x.example/bucket' })).toMatch(/origin/)
    expect(bad({ endpoint: 'https://user:pw@x.example' })).toMatch(/user name/)
    expect(bad({ endpoint: 'http://minio.example.org' })).toMatch(/https/)
    expect(bad({ bucket: 'Forge' })).toMatch(/lowercase/)
    expect(bad({ prefix: 'a/../b' })).toMatch(/segment/)
    expect(bad({ publicUrl: '' })).toMatch(/public URL/)
    expect(bad({ pathStyle: false, endpoint: 'https://1.2.3.4' })).toMatch(/path-style/)
    expect(bad({}, {})).toMatch(/access key/)
    expect(profileProblem({ ...S3, name: 'a,b' })).toMatch(/name/)
  })

  it('keys artifacts like the CLI', () => {
    const s3 = S3.settings as Extract<ProfilePublic, { kind: 's3' }>
    expect(artifactKey(s3, 'ab'.repeat(32))).toBe(`web/packs/${'ab'.repeat(32)}.pack`)
    expect(artifactKey({ ...s3, prefix: '' }, 'cd')).toBe('packs/cd.pack')
    expect(artifactKey({ ...s3, prefix: '/a/b//' }, 'cd')).toBe('a/b/packs/cd.pack')
  })

  it('maps replication choices to policies and back', () => {
    expect(policyFor(['a', 'b'], 'one')).toEqual({ targets: ['a', 'b'], replicas: 1, platformFallback: false })
    expect(policyFor(['a', 'b'], 'all')).toEqual({ targets: ['a', 'b'], replicas: 2, platformFallback: false })
    expect(policyFor(['a'], 'fallback')).toEqual({ targets: ['a'], replicas: 1, platformFallback: true })
    for (const c of ['one', 'all', 'fallback'] as const) expect(choiceOf(policyFor(['a', 'b'], c))).toBe(c)
  })
})

describe('the stored configuration', () => {
  it('prunes a removed profile out of every policy', () => {
    let c = withProfile(withProfile(EMPTY_STORAGE_CONFIG, S3), KUBO)
    c = { ...c, defaultPolicy: policyFor(['minio', 'kubo'], 'all') }
    c = withRepoPolicy(c, 'R1', policyFor(['kubo'], 'one'))
    const after = withoutProfile(c, 'kubo')
    expect(after.profiles.map((p) => p.name)).toEqual(['minio'])
    expect(after.defaultPolicy).toEqual({ targets: ['minio'], replicas: 1, platformFallback: false })
    expect(after.repoPolicies).toEqual({})
    expect(policyForRepo(after, 'R1')).toEqual(after.defaultPolicy)
  })

  it('refuses a policy naming unknown profiles or too many copies', () => {
    const c = withProfile(EMPTY_STORAGE_CONFIG, S3)
    expect(policyProblem(c, policyFor(['minio'], 'one'))).toBeNull()
    expect(policyProblem(c, policyFor(['nope'], 'one'))).toMatch(/no storage profile/)
    expect(policyProblem(c, { targets: ['minio'], replicas: 2, platformFallback: false })).toMatch(/copies/)
    expect(policyProblem(c, { targets: [], replicas: 1, platformFallback: false })).toMatch(/at least one/)
  })
})

describe('the configuration sealed in the vault', () => {
  beforeEach(() => {
    resetMemoryStores()
    lockVault()
  })

  it('stores secrets encrypted, reads them back unlocked, and refuses when locked', async () => {
    await storeInVault('devnet', { identityId: ID, keyId: 5, wif: 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy' }, { passphrase: 'correct horse battery' })
    const config = withRepoPolicy(withProfile(EMPTY_STORAGE_CONFIG, S3), 'R1', policyFor(['minio'], 'one'))
    await saveStorageConfig('devnet', ID, config)
    const dump = JSON.stringify(await idbEntries('vault'), (_k, v: unknown) => (v instanceof Uint8Array ? Array.from(v) : v))
    expect(dump).not.toContain('minio-secret-value')
    expect(dump).not.toContain('forge-byo')
    expect(await loadStorageConfig('devnet', ID)).toEqual(config)
    lockVault()
    await expect(loadStorageConfig('devnet', ID)).rejects.toThrow(/unlock/)
    await unlockWithPassphrase('devnet', ID, 'correct horse battery')
    expect((await loadStorageConfig('devnet', ID)).profiles[0]?.secrets.secretAccessKey).toBe('minio-secret-value')
  }, 60_000)

  it('carries the storage settings across a key renewal', async () => {
    const wif = 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy'
    await storeInVault('devnet', { identityId: ID, keyId: 5, wif }, { passphrase: 'correct horse battery' })
    await saveStorageConfig('devnet', ID, withProfile(EMPTY_STORAGE_CONFIG, S3))
    await storeInVault('devnet', { identityId: ID, keyId: 6, wif }, { passphrase: 'a different passphrase' })
    lockVault()
    await unlockWithPassphrase('devnet', ID, 'a different passphrase')
    expect((await loadStorageConfig('devnet', ID)).profiles.map((p) => p.name)).toEqual(['minio'])
  }, 90_000)
})

describe('chunks and manifests', () => {
  it('splits exactly as forge-core pack::split', () => {
    expect(splitChunks(new Uint8Array(0))).toEqual([])
    const bytes = new Uint8Array(CHUNK_PAYLOAD_MAX * 2 + FIELD_MAX + 7).map((_, i) => i % 251)
    const chunks = splitChunks(bytes)
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2])
    expect(chunks.map((c) => c.fields.map((f) => f.length))).toEqual([[FIELD_MAX, FIELD_MAX, FIELD_MAX], [FIELD_MAX, FIELD_MAX, FIELD_MAX], [FIELD_MAX, 7]])
    const joined = new Uint8Array(chunks.flatMap((c) => c.fields.flatMap((f) => Array.from(f))))
    expect(joined).toEqual(bytes)
  })

  it('orders URIs platform, then http(s), then the rest, and fits the budget', () => {
    expect(orderUris([['https://a/p', 's3://b/p'], ['ipfs://bafy', 'https://gw/ipfs/bafy'], ['platform://C/R/O/h']])).toEqual([
      'platform://C/R/O/h',
      'https://a/p',
      'https://gw/ipfs/bafy',
      's3://b/p',
      'ipfs://bafy',
    ])
    const many = Array.from({ length: 5 }, (_, i) => [`https://h${i}/p`, `s3://b${i}/p`])
    expect(fitManifestUris(orderUris(many))).toHaveLength(5)
    expect(() => fitManifestUris([`https://x/${'a'.repeat(400)}`])).toThrow(/do not fit/)
    expect(manifestUrisProblem([])).toMatch(/no confirmed copy/)
  })
})

describe('CORS fix blocks', () => {
  it('are valid JSON naming the bucket, Range for reads and PUT for this origin', () => {
    for (const p of ['r2', 'aws', 'b2'] as const) {
      const fix = corsFix(p, 'my-bucket', 'https://forge.dashhq.org')
      expect(fix.where + fix.text).toContain('my-bucket'.slice(0, p === 'r2' || p === 'aws' || p === 'b2' ? 9 : 0))
      const json: unknown = JSON.parse(fix.text)
      const text = JSON.stringify(json).toLowerCase()
      expect(text).toContain('range')
      expect(text).toMatch(/put/)
      expect(text).toContain('https://forge.dashhq.org')
      expect(text).toContain('x-amz-content-sha256')
    }
    expect(corsFix('kubo', '', 'https://forge.dashhq.org').text).toContain('API.HTTPHeaders.Access-Control-Allow-Origin')
  })
})

// ---------------------------------------------------------------------------
// The replication engine against in-memory S3 and kubo
// ---------------------------------------------------------------------------

const REPO: V2RepoRef = { kind: 'v2', forge: { core: 'CORE', collab: 'COLLAB', group: 'G' }, repoId: 'REPO', ownerId: ID, name: 'r', visibility: 'public' }
const AUTH: WriteAuth = { identityId: ID, network: 'devnet', getSigningKeyWif: () => '' }
const SDK = {} as EvoSDK

function fakeNetwork(opts: { s3Down?: boolean; corruptOnce?: boolean } = {}) {
  const objects = new Map<string, Uint8Array>()
  let corrupt = opts.corruptOnce === true
  const puts: string[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    if (url.port === '9000') {
      if (opts.s3Down) throw new TypeError('Failed to fetch')
      const key = url.pathname
      if (method === 'PUT') {
        const body = new Uint8Array(init?.body as ArrayBuffer | Uint8Array)
        puts.push(key)
        objects.set(key, new Uint8Array(corrupt ? body.map((b) => b ^ 1) : body))
        corrupt = false
        return new Response(null, { status: 200 })
      }
      const obj = objects.get(key)
      if (!obj) return new Response(null, { status: 404 })
      if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(obj.length) } })
      return new Response(new Uint8Array(obj), { status: 200 })
    }
    if (url.port === '5001') {
      if (url.pathname.endsWith('/add')) {
        const file = (init?.body as FormData).get('file') as Blob
        const bytes = new Uint8Array(await file.arrayBuffer())
        const cid = cidV1RawLeaves(bytes)
        objects.set(`ipfs:${cid}`, bytes)
        return new Response(JSON.stringify({ Hash: cid }))
      }
      if (url.pathname.endsWith('/pin/ls')) {
        const cid = url.searchParams.get('arg') ?? ''
        return objects.has(`ipfs:${cid}`) ? new Response(JSON.stringify({ Keys: { [cid]: { Type: 'recursive' } } })) : new Response('{"Message":"not pinned"}', { status: 500 })
      }
      return new Response('{}')
    }
    if (url.port === '8081') {
      const obj = objects.get(`ipfs:${url.pathname.split('/').pop() ?? ''}`)
      return obj ? new Response(new Uint8Array(obj)) : new Response(null, { status: 404 })
    }
    throw new Error(`unexpected ${url}`)
  })
  return { fetchMock, objects, puts }
}

describe('storeArtifact', () => {
  const bytes = new TextEncoder().encode('PACK a small pack')
  afterEach(() => vi.unstubAllGlobals())

  it('stores on S3, verifies by re-read, and records the public URL before the s3:// locator', async () => {
    const net = fakeNetwork()
    vi.stubGlobal('fetch', net.fetchMock)
    const stored = await storeArtifact(SDK, AUTH, REPO, bytes, {
      policy: policyFor(['minio'], 'one'),
      profiles: [S3],
      confirmPlatform: async () => false,
    })
    const hash = await sha256Hex(bytes)
    expect(stored).toMatchObject({ packHash: hash, storage: 1, chunkCount: 0, confirmed: ['minio'], failures: [] })
    expect(stored.uris).toEqual([`http://127.0.0.1:9000/forge-byo/web/packs/${hash}.pack`, `s3://forge-byo/web/packs/${hash}.pack`])
    // The request that wrote it was signed.
    const put = net.fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(new Headers(put?.[1]?.headers).get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=minioadmin\//)
    expect(new Headers(put?.[1]?.headers).get('x-amz-content-sha256')).toBe(hash)
  })

  it('re-uploads once when the stored copy does not verify', async () => {
    const net = fakeNetwork({ corruptOnce: true })
    vi.stubGlobal('fetch', net.fetchMock)
    const stored = await storeArtifact(SDK, AUTH, REPO, bytes, { policy: policyFor(['minio'], 'one'), profiles: [S3], confirmPlatform: async () => false })
    expect(stored.confirmed).toEqual(['minio'])
    expect(net.puts).toHaveLength(2)
  })

  it('fails the policy (writing nothing to Platform) when too few targets confirm', async () => {
    vi.stubGlobal('fetch', fakeNetwork({ s3Down: true }).fetchMock)
    const confirm = vi.fn(async () => true)
    const run = storeArtifact(SDK, AUTH, REPO, bytes, { policy: policyFor(['minio', 'kubo'], 'all'), profiles: [S3, KUBO], confirmPlatform: confirm })
    await expect(run).rejects.toBeInstanceOf(ReplicationError)
    await expect(run).rejects.toThrow(/1 of 2 required .*minio: signed PUT.*Nothing was written to Platform/)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('verifies the kubo CID against the local derivation', async () => {
    vi.stubGlobal('fetch', fakeNetwork().fetchMock)
    const stored = await storeArtifact(SDK, AUTH, REPO, bytes, { policy: policyFor(['kubo'], 'one'), profiles: [{ ...KUBO, settings: { ...KUBO.settings, gateway: '' } as ProfilePublic }], confirmPlatform: async () => false })
    expect(stored.uris).toEqual([`ipfs://${cidV1RawLeaves(bytes)}`])
  })

  it('asks before storing on Platform when nothing is configured, and stops when declined', async () => {
    const confirm = vi.fn(async () => false)
    await expect(storeArtifact(SDK, AUTH, REPO, bytes, { policy: null, profiles: [], confirmPlatform: confirm })).rejects.toBeInstanceOf(PlatformDeclinedError)
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ bytes: bytes.length, estimateCredits: expect.any(Number) }))
  })
})
