/**
 * The storage layer, offline: profile validation, policies, URI ordering and budgets, chunk
 * splitting (parity with forge-core `pack::split`), the CORS fix blocks, the config sealed in
 * the vault, and the replication engine against in-memory S3 and kubo fakes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetMemoryStores, idbEntries, idbGet, idbPut } from '../idb'
import { lockVault, storeInVault, unlockWithPassphrase } from '../auth/vault'
import { splitChunks, manifestUrisProblem } from '../repo/push'
import { CHUNK_PAYLOAD_MAX, FIELD_MAX } from '../constants'
import { isPrivateHost, isPublicHttpsUrl } from '../net'
import { externalFetchUrls } from '../view/browse-source'
import { corsFix } from './cors'
import { cidV1RawLeaves } from './cid'
import {
  PLATFORM_PROFILE,
  artifactKey,
  choiceOf,
  policyFor,
  profileProblem,
  profileSecretsSchema,
  publishProblem,
  type ProfilePublic,
  type StorageProfile,
} from './profiles'
import {
  EMPTY_STORAGE_CONFIG,
  discardStorageConfig,
  loadStorageConfig,
  policyForRepo,
  policyProblem,
  saveStorageConfig,
  withProfile,
  withRenamedProfile,
  withRepoPolicy,
  withoutProfile,
} from './store'
import { ReplicationError, PlatformDeclinedError, fitManifestUris, orderUris, storeArtifact } from './upload'
import { sha256Hex } from './sigv4'
import type { WriteAuth } from '../sdk'
import type { RepoRef } from '../repo/contract'
import type { EvoSDK } from '@dashevo/evo-sdk'

const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const WIF = 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy'

const S3: StorageProfile = {
  name: 'r2-main',
  settings: {
    kind: 's3',
    provider: 'r2',
    endpoint: 'https://acct.r2.cloudflarestorage.com',
    region: 'auto',
    bucket: 'forge-byo',
    pathStyle: true,
    publicUrl: 'https://pub-9a1.r2.dev',
    prefix: 'web',
  },
  secrets: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'r2-secret-value' },
}

const KUBO: StorageProfile = {
  name: 'kubo',
  settings: { kind: 'ipfs-kubo', provider: 'kubo', api: 'https://kubo.example', gateway: 'https://kubo-gw.example', publicGateway: '', pinningEndpoint: '' },
  secrets: {},
}

const s3Of = (p: StorageProfile): Extract<ProfilePublic, { kind: 's3' }> => p.settings as Extract<ProfilePublic, { kind: 's3' }>

describe('profiles', () => {
  it('accepts a sound S3 profile and names what is wrong otherwise', () => {
    expect(profileProblem(S3)).toBeNull()
    const s3 = s3Of(S3)
    const bad = (patch: Partial<typeof s3>, secrets = S3.secrets): string | null => profileProblem({ ...S3, settings: { ...s3, ...patch }, secrets })
    expect(bad({ endpoint: 'https://x.example/bucket' })).toMatch(/origin/)
    expect(bad({ endpoint: 'https://user:pw@x.example' })).toMatch(/user name/)
    expect(bad({ endpoint: 'http://minio.example.org' })).toMatch(/https/)
    // The API endpoint may be plain http on this machine (the user's own MinIO); what is
    // published may not (the public URL, checked by publishProblem).
    expect(bad({ endpoint: 'http://127.0.0.1:9000' })).toBeNull()
    expect(bad({ endpoint: 'http://192.168.1.4:9000' })).toMatch(/https/)
    expect(bad({ bucket: 'Forge' })).toMatch(/lowercase/)
    expect(bad({ prefix: 'a/../b' })).toMatch(/segment/)
    expect(bad({ publicUrl: '' })).toMatch(/public URL/)
    expect(bad({ publicUrl: 'http://pub.example' })).toMatch(/recorded on chain/)
    expect(bad({ pathStyle: false, endpoint: 'https://1.2.3.4' })).toMatch(/path-style/)
    expect(bad({}, {})).toMatch(/access key/)
    expect(profileProblem({ ...S3, name: 'a,b' })).toMatch(/name/)
  })

  it('reserves the Platform profile name', () => {
    expect(profileProblem({ ...S3, name: PLATFORM_PROFILE })).toMatch(/reserved/)
    expect(profileProblem({ name: PLATFORM_PROFILE, settings: { kind: 'platform', provider: 'platform' }, secrets: {} })).toBeNull()
  })

  it('refuses secrets an HTTP header cannot carry, without echoing them', () => {
    const problem = profileProblem({ ...S3, secrets: { ...S3.secrets, sessionToken: 'tok\nsecret-part' } })
    expect(problem).toMatch(/session token/i)
    expect(problem).not.toContain('secret-part')
    expect(profileSecretsSchema.safeParse({ accessKeyId: 'ключ' }).success).toBe(false)
    expect(profileSecretsSchema.safeParse({ accessKeyId: 'AKID', extra: 'x' }).success).toBe(false)
  })

  it('refuses a published address only its uploader can reach', () => {
    expect(publishProblem(S3)).toBeNull()
    for (const url of ['http://127.0.0.1:9000/forge-byo', 'https://192.168.1.4/b', 'https://10.0.0.8', 'https://minio.local/b', 'https://[::1]/b', 'https://[fd00::1]/b']) {
      expect(publishProblem({ ...S3, settings: { ...s3Of(S3), publicUrl: url } }), url).toMatch(/other people cannot read/)
    }
    expect(publishProblem({ ...KUBO, settings: { ...KUBO.settings, publicGateway: 'http://localhost:8080' } as ProfilePublic })).toMatch(/other people/)
  })

  it('keys artifacts like the CLI', () => {
    const s3 = s3Of(S3)
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

describe('what readers may fetch', () => {
  it('only public https hosts', () => {
    for (const h of ['127.0.0.1', 'localhost', 'x.localhost', '10.1.2.3', '172.20.0.1', '192.168.0.9', '169.254.1.1', '100.64.0.1', '::1', 'fe80::1', 'fc00::5', '::ffff:127.0.0.1', 'nas.local.', 'localhost.']) {
      expect(isPrivateHost(h), h).toBe(true)
    }
    for (const h of ['pub-9a1.r2.dev', '8.8.8.8', '172.32.0.1', 'ipfs.io']) expect(isPrivateHost(h), h).toBe(false)
    expect(isPublicHttpsUrl('http://pub.example/p')).toBe(false)
    expect(isPublicHttpsUrl('https://pub.example/p')).toBe(true)
  })

  it('never makes a reader request a loopback or private URL a manifest records', () => {
    expect(
      externalFetchUrls(['http://127.0.0.1:9000/p', 'https://192.168.1.2/p', 'http://pub.example/p', 'https://pub.example/p', 'ipfs://bafyok', 'ipfs://bafy/../api'], ['https://ipfs.io']),
    ).toEqual(['https://pub.example/p', 'https://ipfs.io/ipfs/bafyok'])
  })
})

describe('the stored configuration', () => {
  it('prunes a removed profile out of every policy', () => {
    let c = withProfile(withProfile(EMPTY_STORAGE_CONFIG, S3), KUBO)
    c = { ...c, defaultPolicy: policyFor(['r2-main', 'kubo'], 'all') }
    c = withRepoPolicy(c, 'R1', policyFor(['kubo'], 'one'))
    const after = withoutProfile(c, 'kubo')
    expect(after.profiles.map((p) => p.name)).toEqual(['r2-main'])
    expect(after.defaultPolicy).toEqual({ targets: ['r2-main'], replicas: 1, platformFallback: false })
    expect(after.repoPolicies).toEqual({})
    expect(policyForRepo(after, 'R1')).toEqual(after.defaultPolicy)
  })

  it('renames a profile inside every policy', () => {
    let c = withProfile(withProfile(EMPTY_STORAGE_CONFIG, S3), KUBO)
    c = { ...c, defaultPolicy: policyFor(['r2-main', 'kubo'], 'all'), lastTests: { kubo: { at: 1, ok: true } } }
    c = withRepoPolicy(c, 'R1', policyFor(['kubo'], 'one'))
    const after = withRenamedProfile(c, 'kubo', { ...KUBO, name: 'my-node' })
    expect(after.profiles.map((p) => p.name)).toEqual(['my-node', 'r2-main'])
    expect(after.defaultPolicy?.targets).toEqual(['r2-main', 'my-node'])
    expect(after.repoPolicies['R1']?.targets).toEqual(['my-node'])
    expect(after.lastTests).toEqual({})
  })

  it('refuses a policy naming unknown profiles or too many copies', () => {
    const c = withProfile(EMPTY_STORAGE_CONFIG, S3)
    expect(policyProblem(c, policyFor(['r2-main'], 'one'))).toBeNull()
    expect(policyProblem(c, policyFor(['nope'], 'one'))).toMatch(/no storage profile/)
    expect(policyProblem(c, { targets: ['r2-main'], replicas: 2, platformFallback: false })).toMatch(/copies/)
    expect(policyProblem(c, { targets: [], replicas: 1, platformFallback: false })).toMatch(/at least one/)
  })
})

describe('the configuration sealed in the vault', () => {
  beforeEach(() => {
    resetMemoryStores()
    lockVault()
  })

  it('stores secrets encrypted, reads them back unlocked, and refuses when locked', async () => {
    await storeInVault('devnet', { identityId: ID, keyId: 5, wif: WIF }, { passphrase: 'correct horse battery' })
    const config = withRepoPolicy(withProfile(EMPTY_STORAGE_CONFIG, S3), 'R1', policyFor(['r2-main'], 'one'))
    await saveStorageConfig('devnet', ID, config)
    const dump = JSON.stringify(await idbEntries('vault'), (_k, v: unknown) => (v instanceof Uint8Array ? Array.from(v) : v))
    expect(dump).not.toContain('r2-secret-value')
    expect(dump).not.toContain('forge-byo')
    expect(await loadStorageConfig('devnet', ID)).toEqual(config)
    lockVault()
    await expect(loadStorageConfig('devnet', ID)).rejects.toThrow(/unlock/)
    await unlockWithPassphrase('devnet', ID, 'correct horse battery')
    expect((await loadStorageConfig('devnet', ID)).profiles[0]?.secrets.secretAccessKey).toBe('r2-secret-value')
  }, 60_000)

  it('carries the storage settings across a key renewal made while unlocked', async () => {
    await storeInVault('devnet', { identityId: ID, keyId: 5, wif: WIF }, { passphrase: 'correct horse battery' })
    await saveStorageConfig('devnet', ID, withProfile(EMPTY_STORAGE_CONFIG, S3))
    const outcome = await storeInVault('devnet', { identityId: ID, keyId: 6, wif: WIF }, { passphrase: 'a different passphrase' })
    expect(outcome.storageSettingsDropped).toBe(false)
    lockVault()
    await unlockWithPassphrase('devnet', ID, 'a different passphrase')
    expect((await loadStorageConfig('devnet', ID)).profiles.map((p) => p.name)).toEqual(['r2-main'])
  }, 90_000)

  it('says so when a renewal made while locked cannot carry them', async () => {
    await storeInVault('devnet', { identityId: ID, keyId: 5, wif: WIF }, { passphrase: 'correct horse battery' })
    await saveStorageConfig('devnet', ID, withProfile(EMPTY_STORAGE_CONFIG, S3))
    lockVault()
    const outcome = await storeInVault('devnet', { identityId: ID, keyId: 6, wif: WIF }, { passphrase: 'a different passphrase' })
    expect(outcome.storageSettingsDropped).toBe(true)
    expect(await loadStorageConfig('devnet', ID)).toEqual(EMPTY_STORAGE_CONFIG)
  }, 90_000)

  it('can discard settings sealed under a key it no longer has', async () => {
    await storeInVault('devnet', { identityId: ID, keyId: 5, wif: WIF }, { passphrase: 'correct horse battery' })
    await saveStorageConfig('devnet', ID, withProfile(EMPTY_STORAGE_CONFIG, S3))
    const stale = await idbGet('vault', `vault-storage:devnet:${ID}`)
    await storeInVault('devnet', { identityId: ID, keyId: 6, wif: WIF }, { passphrase: 'a different passphrase' })
    await idbPut('vault', `vault-storage:devnet:${ID}`, stale)
    await expect(loadStorageConfig('devnet', ID)).rejects.toThrow(/do not open/)
    await discardStorageConfig('devnet', ID)
    expect(await loadStorageConfig('devnet', ID)).toEqual(EMPTY_STORAGE_CONFIG)
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

  it('orders URIs platform, then https, then the rest, and fits the budget', () => {
    expect(orderUris([['https://a/p', 's3://b/p'], ['ipfs://bafy', 'https://gw/ipfs/bafy'], ['platform://C/R/O/h']])).toEqual([
      'platform://C/R/O/h',
      'https://a/p',
      'https://gw/ipfs/bafy',
      's3://b/p',
      'ipfs://bafy',
    ])
    const many = Array.from({ length: 5 }, (_, i) => [`https://h${i}.example/p`, `s3://b${i}/p`])
    expect(fitManifestUris(orderUris(many))).toHaveLength(5)
    expect(() => fitManifestUris([`https://x.example/${'a'.repeat(400)}`])).toThrow(/do not fit/)
    expect(manifestUrisProblem([])).toMatch(/no confirmed copy/)
  })

  it('never records an address others cannot read', () => {
    expect(() => fitManifestUris(['http://127.0.0.1:9000/b/p', 's3://b/p'])).toThrow(/only public https/)
    expect(() => fitManifestUris(['https://192.168.1.2/p'])).toThrow(/only public https/)
    expect(() => fitManifestUris(['http://pub.example/p'])).toThrow(/only public https/)
  })
})

describe('CORS fix blocks', () => {
  it('are valid JSON naming the bucket, lowercase range for reads and PUT for this origin', () => {
    for (const p of ['r2', 'aws', 'b2', 'minio'] as const) {
      const fix = corsFix(p, 'my-bucket', 'https://forge.dashhq.org')
      expect(fix.where + fix.text).toContain('my-bucket')
      const raw = JSON.stringify(JSON.parse(fix.text) as unknown)
      // Garage matches AllowedHeaders case-sensitively and browsers send `range`.
      expect(raw).toMatch(/"(AllowedHeaders|allowedHeaders)":\["range"\]/)
      expect(raw).not.toContain('"Range"')
      const text = raw.toLowerCase()
      expect(text).toMatch(/put/)
      expect(text).toContain('https://forge.dashhq.org')
      expect(text).toContain('x-amz-content-sha256')
    }
  })

  it('points other S3 stores at put-bucket-cors and keeps MinIO reads open to every origin', () => {
    const fix = corsFix('minio', 'b', 'https://forge.dashhq.org')
    expect(fix.where).toMatch(/Garage, RustFS/)
    expect(fix.where).toContain('put-bucket-cors')
    expect(fix.where).toContain('cors_allow_origin="*"')
  })

  it('gives kubo a restricted token and merges the origin into the existing list', () => {
    const { where, text } = corsFix('kubo', '', 'https://forge.dashhq.org')
    expect(where).toMatch(/admin interface/)
    expect(text).toContain('API.Authorizations.dash-forge')
    for (const path of ['/api/v0/add', '/api/v0/pin/ls', '/api/v0/pin/rm', '/api/v0/id', '/api/v0/version']) expect(text).toContain(path)
    expect(text).toMatch(/\(ipfs config API\.HTTPHeaders\.Access-Control-Allow-Origin 2>\/dev\/null \|\| echo null\) \| jq -c '\(\. \/\/ \[\]\) \+ \["https:\/\/forge\.dashhq\.org"\] \| unique'/)
    const commands = text.split('\n').filter((l) => !l.startsWith('#'))
    expect(commands.join('\n')).not.toMatch(/Access-Control-Allow-Origin '\["https:\/\/forge\.dashhq\.org"\]'/)
    // Any Authorizations entry locks the RPC API for everyone else: an owner token comes first.
    expect(text).toMatch(/API\.Authorizations\.owner .*\\"AllowedPaths\\": \[\\"\/api\/v0\\"\]/)
    expect(text.indexOf('API.Authorizations.owner')).toBeLessThan(text.indexOf('API.Authorizations.dash-forge'))
  })
})

// ---------------------------------------------------------------------------
// The replication engine against in-memory S3 and kubo
// ---------------------------------------------------------------------------

const REPO: RepoRef = { forge: { core: 'CORE', collab: 'COLLAB', group: 'G' }, repoId: 'REPO', ownerId: ID, name: 'r', visibility: 'public' }
const AUTH: WriteAuth = { identityId: ID, network: 'devnet', getSigningKeyWif: () => '' }
const SDK = {} as EvoSDK

/** Serve `obj` for a (possibly ranged) GET. */
function serve(obj: Uint8Array, init?: RequestInit): Response {
  const range = new Headers(init?.headers).get('range')
  const m = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null
  if (!m) return new Response(new Uint8Array(obj), { status: 200 })
  const [start, end] = [Number(m[1]), Number(m[2])]
  return new Response(obj.slice(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${obj.length}` } })
}

function fakeNetwork(opts: { s3Down?: boolean; corruptOnce?: boolean; publicDenied?: boolean; headForbidden?: boolean } = {}) {
  const objects = new Map<string, Uint8Array>()
  let corrupt = opts.corruptOnce === true
  const puts: string[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    if (url.host === 'acct.r2.cloudflarestorage.com') {
      if (opts.s3Down) throw new TypeError('Failed to fetch')
      const key = url.pathname.replace(/^\/forge-byo\//, '')
      if (method === 'PUT') {
        const body = new Uint8Array(init?.body as ArrayBuffer | Uint8Array)
        puts.push(key)
        objects.set(key, new Uint8Array(corrupt ? body.map((b) => b ^ 1) : body))
        corrupt = false
        return new Response(null, { status: 200 })
      }
      const obj = objects.get(key)
      // AWS without s3:ListBucket: a missing key's HEAD is 403.
      if (!obj && method === 'HEAD' && opts.headForbidden) return new Response(null, { status: 403 })
      if (!obj) return new Response(null, { status: 404 })
      if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(obj.length) } })
      return serve(obj, init)
    }
    if (url.host === 'pub-9a1.r2.dev') {
      if (opts.publicDenied) return new Response('AccessDenied', { status: 403 })
      const obj = objects.get(url.pathname.slice(1))
      return obj ? serve(obj, init) : new Response(null, { status: 404 })
    }
    if (url.host === 'kubo.example') {
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
    if (url.host === 'kubo-gw.example' || url.host === 'ipfs.example') {
      const obj = objects.get(`ipfs:${url.pathname.split('/').pop() ?? ''}`)
      return obj ? serve(obj, init) : new Response(null, { status: 404 })
    }
    throw new Error(`unexpected ${url}`)
  })
  return { fetchMock, objects, puts }
}

describe('storeArtifact', () => {
  const bytes = new TextEncoder().encode('PACK a small pack')
  afterEach(() => vi.unstubAllGlobals())

  it('stores on S3, verifies through the API and the public URL, and records the public URL first', async () => {
    const net = fakeNetwork()
    vi.stubGlobal('fetch', net.fetchMock)
    const stored = await storeArtifact(SDK, AUTH, REPO, bytes, { policy: policyFor(['r2-main'], 'one'), profiles: [S3], confirmPlatform: async () => false })
    const hash = await sha256Hex(bytes)
    expect(stored).toMatchObject({ packHash: hash, storage: 1, chunkCount: 0, confirmed: ['r2-main'], failures: [] })
    expect(stored.uris).toEqual([`https://pub-9a1.r2.dev/web/packs/${hash}.pack`, `s3://forge-byo/web/packs/${hash}.pack`])
    const put = net.fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(new Headers(put?.[1]?.headers).get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//)
    expect(new Headers(put?.[1]?.headers).get('x-amz-content-sha256')).toBe(hash)
    // The public URL was read anonymously (no Authorization) before the copy counted.
    const pub = net.fetchMock.mock.calls.find(([u]) => String(u).startsWith('https://pub-9a1.r2.dev/'))
    expect(pub).toBeDefined()
    expect(new Headers(pub?.[1]?.headers).get('authorization')).toBeNull()
  })

  it("never uploads a private repo's unsealed bytes; a sealed pack goes through", async () => {
    const net = fakeNetwork()
    vi.stubGlobal('fetch', net.fetchMock)
    const priv = { ...REPO, visibility: 'private' as const }
    const opts = { policy: policyFor(['r2-main'], 'one'), profiles: [S3], confirmPlatform: async () => false }
    await expect(storeArtifact(SDK, AUTH, priv, bytes, opts)).rejects.toThrow(/unencrypted artifact for a private repo/)
    expect(net.puts).toHaveLength(0)
    const { EpochKeys, sealPack } = await import('../private')
    const sealed = await sealPack(await EpochKeys.import(new Uint8Array(32).fill(7), 0, new Uint8Array(32).fill(9)), bytes)
    const stored = await storeArtifact(SDK, AUTH, priv, sealed, opts)
    expect(stored.packHash).toBe(await sha256Hex(sealed))
    expect(net.puts).toHaveLength(1)
  })

  it('uploads when the pre-upload HEAD is refused (AWS without s3:ListBucket)', async () => {
    const net = fakeNetwork({ headForbidden: true })
    vi.stubGlobal('fetch', net.fetchMock)
    const stored = await storeArtifact(SDK, AUTH, REPO, bytes, { policy: policyFor(['r2-main'], 'one'), profiles: [S3], confirmPlatform: async () => false })
    expect(stored.confirmed).toEqual(['r2-main'])
    expect(net.puts).toHaveLength(1)
  })

  it('does not count a copy whose public URL others cannot read', async () => {
    vi.stubGlobal('fetch', fakeNetwork({ publicDenied: true }).fetchMock)
    await expect(storeArtifact(SDK, AUTH, REPO, bytes, { policy: policyFor(['r2-main'], 'one'), profiles: [S3], confirmPlatform: async () => false })).rejects.toThrow(
      /public URL \(pub-9a1\.r2\.dev\) answered HTTP 403/,
    )
  })

  it('refuses to upload to a profile whose public address only this machine can read', async () => {
    const net = fakeNetwork()
    vi.stubGlobal('fetch', net.fetchMock)
    const local = { ...S3, settings: { ...s3Of(S3), publicUrl: 'https://192.168.1.20/forge-byo' } }
    await expect(storeArtifact(SDK, AUTH, REPO, bytes, { policy: policyFor(['r2-main'], 'one'), profiles: [local], confirmPlatform: async () => false })).rejects.toThrow(/other people cannot read/)
    expect(net.puts).toEqual([])
  })

  it('re-uploads once when the stored copy does not verify', async () => {
    const net = fakeNetwork({ corruptOnce: true })
    vi.stubGlobal('fetch', net.fetchMock)
    const stored = await storeArtifact(SDK, AUTH, REPO, bytes, { policy: policyFor(['r2-main'], 'one'), profiles: [S3], confirmPlatform: async () => false })
    expect(stored.confirmed).toEqual(['r2-main'])
    expect(net.puts).toHaveLength(2)
  })

  it('fails the policy (writing nothing to Platform) when too few targets confirm', async () => {
    vi.stubGlobal('fetch', fakeNetwork({ s3Down: true }).fetchMock)
    const confirm = vi.fn(async () => true)
    const run = storeArtifact(SDK, AUTH, REPO, bytes, { policy: policyFor(['r2-main', 'kubo'], 'all'), profiles: [S3, KUBO], confirmPlatform: confirm })
    await expect(run).rejects.toBeInstanceOf(ReplicationError)
    await expect(run).rejects.toThrow(/1 of 2 required .*r2-main: signed PUT.*Nothing was written to Platform/)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('asks, with the price, before a policy that names Platform writes any chunk', async () => {
    vi.stubGlobal('fetch', fakeNetwork().fetchMock)
    const platform: StorageProfile = { name: PLATFORM_PROFILE, settings: { kind: 'platform', provider: 'platform' }, secrets: {} }
    const confirm = vi.fn(async () => false)
    const run = storeArtifact(SDK, AUTH, REPO, bytes, { policy: policyFor([PLATFORM_PROFILE], 'one'), profiles: [platform], confirmPlatform: confirm })
    await expect(run).rejects.toBeInstanceOf(ReplicationError)
    await expect(run).rejects.toThrow(/declined.*Nothing was written to Platform/)
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ bytes: bytes.length, estimateCredits: expect.any(Number), reason: expect.stringMatching(/includes Dash Platform/) }))
  })

  it('verifies the kubo CID, the node gateway and the public gateway', async () => {
    vi.stubGlobal('fetch', fakeNetwork().fetchMock)
    const withPublic = { ...KUBO, settings: { ...KUBO.settings, publicGateway: 'https://ipfs.example' } as ProfilePublic }
    const stored = await storeArtifact(SDK, AUTH, REPO, bytes, { policy: policyFor(['kubo'], 'one'), profiles: [withPublic], confirmPlatform: async () => false })
    const cid = cidV1RawLeaves(bytes)
    expect(stored.uris).toEqual([`https://ipfs.example/ipfs/${cid}`, `ipfs://${cid}`])
  })

  it('asks before storing on Platform when nothing is configured, and stops when declined', async () => {
    const confirm = vi.fn(async () => false)
    await expect(storeArtifact(SDK, AUTH, REPO, bytes, { policy: null, profiles: [], confirmPlatform: confirm })).rejects.toBeInstanceOf(PlatformDeclinedError)
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ bytes: bytes.length, estimateCredits: expect.any(Number) }))
  })
})
