import { bytesToHex } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PackManifest } from '../repo/packs'
import type { RepoRef } from '../repo/contract'
import type { StorageProfile } from './profiles'

const io = vi.hoisted(() => ({
  stored: [] as { bytes: number; targets: readonly string[]; publicGateway?: string }[],
  gateway: null as Uint8Array | null,
  fetched: [] as string[],
  storeUris: ['https://cdn.example/forge/x'] as string[],
  storeFail: null as Error | null,
  recorded: [] as { packHash: string; uris: readonly string[]; intent?: string }[],
  recordFail: null as Error | null,
  bytes: new Map<string, Uint8Array>(),
  parent: [] as PackManifest[],
  browse: [] as PackManifest[],
  last: null as Uint8Array | null,
  servePublic: true,
  signals: [] as boolean[],
  onStore: null as null | (() => void),
  mirrorsRead: 0,
}))
vi.mock('../view/browse-source', () => ({
  loadArtifactBytesProgress: async (_sdk: unknown, _repo: unknown, m: PackManifest) => {
    const bytes = io.bytes.get(m.packHash)
    if (bytes === undefined) throw new Error('no copy served the pack')
    return bytes
  },
}))
vi.mock('./upload', async (orig) => ({
  ...(await orig<typeof import('./upload')>()),
  storeFile: async (bytes: Uint8Array, opts: { policy: { targets: readonly string[] }; profiles: readonly StorageProfile[]; signal?: AbortSignal }) => {
    io.signals.push(opts.signal !== undefined)
    io.onStore?.()
    if (io.storeFail) throw io.storeFail
    io.last = bytes
    const s = opts.profiles[0]?.settings
    io.stored.push({ bytes: bytes.length, targets: opts.policy.targets, ...(s && 'publicGateway' in s ? { publicGateway: s.publicGateway } : {}) })
    return { uris: io.storeUris }
  },
}))
vi.mock('./util', async (orig) => ({
  ...(await orig<typeof import('./util')>()),
  timedFetch: async (url: string) => {
    io.fetched.push(url)
    const body = io.gateway ?? (io.servePublic ? io.last : null)
    return {
      resp: { ok: body !== null },
      bytes: async (max = Infinity) => {
        if (body !== null && body.length > max) throw new Error('the answer is too long')
        return body ?? new Uint8Array()
      },
      discard: () => undefined,
    }
  },
}))
vi.mock('../repo/pack-mirrors', async (orig) => ({
  ...(await orig<typeof import('../repo/pack-mirrors')>()),
  recordMirror: async (_sdk: unknown, _auth: unknown, _repo: unknown, packHash: string, uris: readonly string[], intent?: string) => {
    if (io.recordFail) throw io.recordFail
    io.recorded.push({ packHash, uris, ...(intent ? { intent } : {}) })
  },
  mirrorsBy: async () => {
    io.mirrorsRead++
    return []
  },
  forgetMirrorsBy: vi.fn(),
}))
vi.mock('../repo/packs', async (orig) => ({
  ...(await orig<typeof import('../repo/packs')>()),
  readRepoPackManifests: async () => io.parent,
  readBrowseManifests: async () => io.browse,
}))
vi.mock('../repo/members', async (orig) => ({ ...(await orig<typeof import('../repo/members')>()), invalidateMembers: vi.fn() }))

const { COPY_MAX_BYTES, CopyFailed, copyableProfiles, forkCopier, forkCopyProfile, mirrorAddress, pinCost, pinLabel, pinPacks, pinStatus, pricedManifests, readPinStatus, readableByOthers, repoPacks, shareable, storageHolding } = await import('./pin-copies')
const mirrors = await import('../repo/pack-mirrors')
const members = await import('../repo/members')

const REPO = { forge: { core: 'CORE', collab: 'C', community: 'M' }, repoId: 'R', ownerId: 'O', name: 'proj', visibility: 'public' } as unknown as RepoRef
const s3 = (name: string, publicUrl = 'https://cdn.example'): StorageProfile => ({
  name,
  settings: { kind: 's3', provider: 'r2', endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'forge', pathStyle: true, publicUrl, prefix: 'forge/' },
  secrets: { accessKeyId: 'k', secretAccessKey: 's' },
})
const kubo = (name: string, publicGateway = ''): StorageProfile => ({
  name,
  settings: { kind: 'ipfs-kubo', provider: 'kubo', api: 'http://127.0.0.1:5001', gateway: '', publicGateway, pinningEndpoint: '' },
  secrets: {},
})
const platform: StorageProfile = { name: 'platform', settings: { kind: 'platform', provider: 'platform' }, secrets: {} }

const served = new Map<string, Uint8Array>()
function packOf(bytes: Uint8Array, at: number, extra: Partial<PackManifest> = {}): PackManifest {
  const packHash = bytesToHex(sha256(bytes))
  served.set(packHash, bytes)
  return { packHash, kind: 0, sizeBytes: bytes.length, objectCount: 1, chunkCount: 1, storage: 0, uris: [], tips: [], supersedes: [], createdAt: at, documentId: `d${at}`, uploader: 'O', ownerRole: 'maintainer', ...extra }
}

beforeEach(() => {
  io.stored = []
  io.gateway = null
  io.fetched = []
  io.recorded = []
  io.storeUris = ['https://cdn.example/forge/x']
  io.storeFail = null
  io.recordFail = null
  io.bytes = new Map(served)
  io.parent = []
  io.browse = []
  io.last = null
  io.servePublic = true
  io.signals = []
  io.onStore = null
  io.mirrorsRead = 0
})

describe('which storage a copy can use', () => {
  it('offers S3 with a public URL and IPFS nodes, never Platform or an address only you can reach', () => {
    const usable = copyableProfiles([s3('r2'), s3('lan', 'http://192.168.1.4:9000'), kubo('node'), kubo('lan-gw', 'http://192.168.1.4:8080'), platform])
    expect(usable.map((p) => p.name)).toEqual(['r2', 'node'])
  })

  it('refuses a public address on a temporary tunnel, and takes an r2.dev URL as the CLI does', () => {
    const usable = copyableProfiles([s3('tunnel', 'https://abc.trycloudflare.com'), kubo('funnel', 'https://box.tail1.ts.net'), s3('dev', 'https://pub-1.r2.dev')])
    expect(usable.map((p) => p.name)).toEqual(['dev'])
  })

  it("forks to the default policy's first external target others can read", () => {
    const profiles = [platform, s3('lan', 'http://192.168.1.4:9000'), kubo('node')]
    expect(forkCopyProfile({ profiles, defaultPolicy: { targets: ['platform', 'lan', 'node'], replicas: 1, platformFallback: false } })?.name).toBe('node')
    expect(forkCopyProfile({ profiles, defaultPolicy: { targets: ['platform'], replicas: 1, platformFallback: false } })).toBeNull()
    expect(forkCopyProfile({ profiles, defaultPolicy: null })).toBeNull()
    expect(forkCopyProfile(null)).toBeNull()
  })
})

describe('the address a pin records', () => {
  it('names the public https URL (kind 1), else the bare CID (kind 2)', () => {
    expect(mirrorAddress(['https://cdn.example/forge/ab', 's3://forge/forge/ab'])).toEqual(['https://cdn.example/forge/ab'])
    expect(mirrorAddress(['https://gw.example/ipfs/bafyq', 'ipfs://bafyq'])).toEqual(['https://gw.example/ipfs/bafyq'])
    expect(mirrorAddress(['ipfs://bafyq'])).toEqual(['ipfs://bafyq'])
  })

  it('refuses a copy with no address others can read', () => {
    expect(() => mirrorAddress(['s3://forge/ab'])).toThrow(/give at least one address/)
  })

  it('records only addresses other readers can use', () => {
    expect(mirrorAddress(['https://127.0.0.1:8080/ipfs/bafyq', 'ipfs://bafyq'])).toEqual(['ipfs://bafyq'])
    expect(mirrorAddress(['https://x.trycloudflare.com/ipfs/bafyq', 'ipfs://bafyq'])).toEqual(['ipfs://bafyq'])
    expect(shareable(['https://cdn.example/a', 's3://forge/a', 'https://10.0.0.2/a', 'https://pub-1.r2.dev/a', 'ipfs://bafyq'])).toEqual(['https://cdn.example/a', 'https://pub-1.r2.dev/a', 'ipfs://bafyq'])
    expect(readableByOthers('http://cdn.example/a')).toBe(false)
  })
})

describe('pinned state', () => {
  const a = packOf(new Uint8Array([1, 2, 3]), 1)
  const b = packOf(new Uint8Array([4, 5]), 2, { kind: 1 })
  const big = packOf(new Uint8Array([6]), 3, { sizeBytes: COPY_MAX_BYTES + 1 })

  it("lists each member's pack once, across kinds, superseded ones included", () => {
    const writerCopy = { ...a, documentId: 'w', uploader: 'W', ownerRole: 'writer' as const, createdAt: 4 }
    const superseding = packOf(new Uint8Array([7]), 5, { supersedes: [a.packHash] })
    const packs = repoPacks([a, writerCopy, b, superseding])
    expect(packs.map((p) => p.packHash).sort()).toEqual([a.packHash, b.packHash, superseding.packHash].sort())
    expect(packs.find((p) => p.packHash === a.packHash)?.source.copies).toHaveLength(2)
  })

  it('leaves out a pack no current maintainer or writer lists', () => {
    const stranger = packOf(new Uint8Array([8]), 6, { uploader: 'S', ownerRole: null })
    const former = packOf(new Uint8Array([9]), 7, { uploader: 'F', ownerRole: null })
    const bot = packOf(new Uint8Array([10]), 8, { uploader: 'B', ownerRole: 'bot' })
    expect(repoPacks([a, stranger, former, bot]).map((p) => p.packHash)).toEqual([a.packHash])
  })

  it('labels the button Pin, Pinned, or Update pin (N new)', () => {
    const packs = repoPacks([a, b])
    const mine = (h: string) => ({ id: h, repoId: 'R', packHash: h, kind: 1, uris: ['https://x.example/p'] })
    expect(pinLabel(null)).toBe('Pin')
    expect(pinLabel(pinStatus(packs, []))).toBe('Pin')
    expect(pinLabel(pinStatus(packs, [mine(a.packHash)]))).toBe('Update pin (1 new)')
    expect(pinLabel(pinStatus(packs, [mine(a.packHash), mine(b.packHash.toUpperCase())]))).toBe('Pinned')
  })

  it('copies only what a browser can, and still counts a pack too large for it as new', () => {
    const status = pinStatus(repoPacks([a, big]), [])
    expect(status.missing.map((p) => p.packHash)).toEqual([a.packHash])
    expect(status.tooLarge.map((p) => p.packHash)).toEqual([big.packHash])
    const mine = { id: 'm', repoId: 'R', packHash: a.packHash, kind: 1, uris: ['https://x.example/p'] }
    expect(pinLabel(pinStatus(repoPacks([a, big]), [mine]))).toBe('Update pin (1 new)')
  })

  it('takes only pinnable kinds before grouping: an asset copy neither adds nor hides a pack', () => {
    const asset = packOf(new Uint8Array([11]), 9, { kind: 4 })
    const strangerPack: PackManifest = { ...asset, kind: 0, documentId: 's', uploader: 'S', ownerRole: null, createdAt: 10 }
    expect(repoPacks([asset, strangerPack])).toEqual([])
    const index = packOf(new Uint8Array([12]), 11, { kind: 2, uploader: 'S', ownerRole: null })
    const memberIndex: PackManifest = { ...index, documentId: 'mi', uploader: 'O', ownerRole: 'maintainer', createdAt: 12 }
    const assetOfIt: PackManifest = { ...index, kind: 4, documentId: 'ai', uploader: 'O', ownerRole: 'maintainer', createdAt: 1 }
    const [only] = repoPacks([index, memberIndex, assetOfIt])
    expect(only?.source.copies?.map((c) => c.documentId)).toEqual(['mi', index.documentId])
    expect(only?.source.kind).toBe(2)
  })

  it('lists packs oldest first', () => {
    const late = packOf(new Uint8Array([13]), 20)
    const early = packOf(new Uint8Array([14]), 0, { kind: 5 })
    expect(repoPacks([late, early]).map((p) => p.packHash)).toEqual([early.packHash, late.packHash])
  })

  it("reads manifests, roles and the signer's records afresh when asked", async () => {
    io.parent = [a]
    io.browse = []
    expect((await readPinStatus({} as never, REPO, 'me')).packs).toEqual([])
    const fresh = await readPinStatus({} as never, REPO, 'me', { fresh: true })
    expect(fresh.packs.map((p) => p.packHash)).toEqual([a.packHash])
    expect(mirrors.forgetMirrorsBy).toHaveBeenCalledWith('me')
    expect(members.invalidateMembers).toHaveBeenCalledWith(REPO)
  })

  it('prices one record per pack', () => {
    expect(pinCost(0, s3('r2'), true).credits).toBe(0)
    const one = pinCost(1, s3('r2'), false).credits
    expect(pinCost(3, s3('r2'), false).credits).toBe(3 * one)
    expect(pinCost(1, s3('r2'), true).credits).toBeGreaterThan(one)
  })
})

describe('pinning', () => {
  const a = packOf(new Uint8Array([1, 2, 3]), 1)
  const b = packOf(new Uint8Array([4, 5]), 2)

  it('copies each pack to the chosen profile, then records its address', async () => {
    const rows: string[] = []
    const done = await pinPacks({} as never, {} as never, REPO, s3('r2'), repoPacks([a, b]), { intent: 'pin:x', onProgress: (r) => rows.push(`${r.index}/${r.total} ${r.state}`) })
    expect(done).toEqual({ recorded: 2, failed: 0, sizeBytes: 5 })
    expect(io.stored).toEqual([{ bytes: 3, targets: ['r2'] }, { bytes: 2, targets: ['r2'] }])
    expect(io.recorded).toEqual([
      { packHash: a.packHash, uris: ['https://cdn.example/forge/x'], intent: `pin:x:${a.packHash}` },
      { packHash: b.packHash, uris: ['https://cdn.example/forge/x'], intent: `pin:x:${b.packHash}` },
    ])
    expect(rows).toEqual(['1/2 copying', '1/2 done', '2/2 copying', '2/2 done'])
  })

  it('records nothing for a pack no copy serves, and goes on', async () => {
    io.bytes.delete(a.packHash)
    const rows: string[] = []
    const done = await pinPacks({} as never, {} as never, REPO, kubo('node'), repoPacks([a, b]), { onProgress: (r) => rows.push(`${r.state}${r.why ? `: ${r.why}` : ''}`) })
    expect(done.recorded).toBe(1)
    expect(done.failed).toBe(1)
    expect(rows).toContain('failed: no copy served the pack')
  })

  it('stops at the first storage failure rather than downloading every pack', async () => {
    io.storeFail = new Error('403 Forbidden')
    await expect(pinPacks({} as never, {} as never, REPO, s3('r2'), repoPacks([a, b]))).rejects.toThrow('r2: 403 Forbidden')
    expect(io.recorded).toEqual([])
  })

  it('stops when Platform refuses a record', async () => {
    io.recordFail = new Error('balance too low')
    await expect(pinPacks({} as never, {} as never, REPO, s3('r2'), repoPacks([a, b]))).rejects.toThrow('balance too low')
    expect(io.stored).toHaveLength(1)
  })

  it("records an IPFS public gateway URL only once it serves the pack, else the CID", async () => {
    io.storeUris = ['ipfs://bafyq']
    io.gateway = new Uint8Array([1, 2, 3])
    await pinPacks({} as never, {} as never, REPO, kubo('node', 'https://gw.example'), repoPacks([a, b]))
    expect(io.stored.map((x) => x.publicGateway)).toEqual(['', ''])
    expect(io.fetched).toEqual(['https://gw.example/ipfs/bafyq', 'https://gw.example/ipfs/bafyq'])
    expect(io.recorded.map((r) => r.uris)).toEqual([['https://gw.example/ipfs/bafyq'], ['ipfs://bafyq']])
  })

  it('cancelled during the upload, records nothing', async () => {
    const run = new AbortController()
    io.onStore = () => run.abort()
    const rows: string[] = []
    const done = await pinPacks({} as never, {} as never, REPO, s3('r2'), repoPacks([a, b]), { signal: run.signal, onProgress: (r) => rows.push(`${r.state}${r.why ? `: ${r.why}` : ''}`) })
    expect(io.signals).toEqual([true])
    expect(io.recorded).toEqual([])
    expect(done.recorded).toBe(0)
    expect(rows).toEqual(['copying', 'failed: Cancelled; press Pin to resume.'])
  })

  it('cancelled after the copy is made, signs nothing', async () => {
    const run = new AbortController()
    io.storeUris = ['ipfs://bafyq']
    io.onStore = () => queueMicrotask(() => run.abort())
    await pinPacks({} as never, {} as never, REPO, kubo('node'), repoPacks([a]), { signal: run.signal })
    expect(io.stored).toHaveLength(1)
    expect(io.recorded).toEqual([])
  })

  it('records an S3 public URL only after reading it back whole', async () => {
    await pinPacks({} as never, {} as never, REPO, s3('r2'), repoPacks([a]))
    expect(io.fetched).toEqual(['https://cdn.example/forge/x'])
    expect(io.recorded).toHaveLength(1)
  })

  it('fails the pack, recording nothing, when the S3 public URL does not serve it', async () => {
    const rows: string[] = []
    io.servePublic = false
    const done = await pinPacks({} as never, {} as never, REPO, s3('r2'), repoPacks([a, b]), { onProgress: (r) => rows.push(`${r.state}${r.why ? `: ${r.why}` : ''}`) })
    expect(done).toEqual({ recorded: 0, failed: 2, sizeBytes: 0 })
    expect(io.recorded).toEqual([])
    expect(rows).toContain('failed: cdn.example did not serve the copy whole to an anonymous read, so it was not recorded')
    io.servePublic = true
    io.gateway = new Uint8Array([9, 9, 9])
    expect((await pinPacks({} as never, {} as never, REPO, s3('r2'), repoPacks([a]))).recorded).toBe(0)
    io.gateway = new Uint8Array([1, 2, 3, 4])
    expect((await pinPacks({} as never, {} as never, REPO, s3('r2'), repoPacks([a]))).recorded).toBe(0)
  })

  it("scrubs the profile's own secrets from what it reports", async () => {
    const profile = { ...s3('r2'), secrets: { accessKeyId: 'AKIAEXAMPLEKEY', secretAccessKey: 'wJalrXUtnFEMIsecret' } }
    io.storeFail = new Error('refused: key AKIAEXAMPLEKEY secret wJalrXUtnFEMIsecret')
    const rows: string[] = []
    const err = await pinPacks({} as never, {} as never, REPO, profile, repoPacks([a]), { onProgress: (r) => rows.push(r.why ?? '') }).catch((e: Error) => e)
    expect(`${String(err)} ${rows.join(' ')}`).not.toMatch(/AKIAEXAMPLEKEY|wJalrXUtnFEMIsecret/)
    expect(String(err)).toContain('[redacted]')
  })

  it('keeps credentials out of what it reports', async () => {
    io.storeFail = new Error('PUT https://key:hunter2@s3.example/x?X-Amz-Signature=abcdef failed')
    const rows: string[] = []
    const err = await pinPacks({} as never, {} as never, REPO, s3('r2'), repoPacks([a]), { onProgress: (r) => rows.push(r.why ?? '') }).catch((e: Error) => e)
    expect(String(err)).not.toMatch(/hunter2|abcdef/)
    expect(rows.join(' ')).not.toMatch(/hunter2|abcdef/)
  })

  it('never pins a private repository to storage', async () => {
    await expect(pinPacks({} as never, {} as never, { ...REPO, visibility: 'private' } as RepoRef, s3('r2'), [])).rejects.toThrow(/public repository/)
  })
})

describe("where a fork's copies go and what they cost", () => {
  const plan = {
    manifests: [
      { packHash: 'aa'.repeat(32), kind: 0, sizeBytes: 1, objectCount: 1, chunkCount: 0, storage: 1, uris: ['https://parent.example/a'], supersedes: [] },
      { packHash: 'bb'.repeat(32), kind: 0, sizeBytes: 1, objectCount: 1, chunkCount: 0, storage: 1, uris: ['platform://CORE/R/O/bb'], supersedes: [] },
    ],
    onPlatform: new Set(['bb'.repeat(32)]),
  } as unknown as Parameters<typeof pricedManifests>[0]

  it("prices the forker's own addresses into each copied manifest, not into Platform-held ones", () => {
    expect(pricedManifests(plan, null)).toEqual(plan.manifests)
    const priced = pricedManifests(plan, kubo('node', 'https://gw.example'))
    expect(priced[0]?.uris).toEqual([expect.stringMatching(/^https:\/\/gw\.example\/ipfs\/bafkrei/), expect.stringMatching(/^ipfs:\/\/bafkrei/), 'https://parent.example/a'])
    expect(priced[1]?.uris).toEqual(['platform://CORE/R/O/bb'])
    expect(pricedManifests(plan, s3('r2'))[0]?.uris[0]).toMatch(/^https:\/\/cdn\.example\/forge\//)
  })

  it("syncs to the profile that holds the fork's earlier copies", () => {
    const config = { profiles: [s3('first', 'https://first.example'), s3('held', 'https://held.example/'), kubo('node')] }
    const mine = [{ uploader: 'me', uris: ['https://held.example/forge/aa', 'https://parent.example/a'] }]
    expect(storageHolding(mine, 'me', config)?.name).toBe('held')
    expect(storageHolding([{ uploader: 'other', uris: ['https://held.example/forge/aa'] }], 'me', config)).toBeNull()
    expect(storageHolding([{ uploader: 'me', uris: ['https://parent.example/a', 'https://held.example/x'] }], 'me', config)).toBeNull()
    expect(storageHolding([{ uploader: 'me', uris: ['https://held.example.evil/x'] }], 'me', config)).toBeNull()
    expect(storageHolding(mine, 'me', null)).toBeNull()
  })
})

describe("a fork's copies", () => {
  const a = packOf(new Uint8Array([1, 2, 3]), 1)

  it("copies a pack from the parent's copies, reading the parent once when none are given", async () => {
    io.parent = [a]
    const seen: string[] = []
    const copy = forkCopier({} as never, REPO, s3('r2'), { again: 'Sign & fork', cli: 'dg repo fork', onCopy: (h, state) => seen.push(state) })
    expect(await copy(a.packHash.toUpperCase())).toEqual(['https://cdn.example/forge/x'])
    expect(await copy(a.packHash, a)).toEqual(['https://cdn.example/forge/x'])
    expect(seen).toEqual(['copying', 'done', 'copying', 'done'])
  })

  it('stops at a pack it cannot copy, with one plain message, never falling back to by-reference', async () => {
    io.parent = [a]
    const words = { again: 'Sign & fork', cli: 'dg repo fork' }
    const resume = /could not be copied to r2\. Press Sign & fork again to finish, or tick "Don't copy" under Storage\./
    await expect(forkCopier({} as never, REPO, s3('r2'), words)('ff'.repeat(32))).rejects.toThrow(resume)
    await expect(forkCopier({} as never, REPO, s3('r2'), words)(a.packHash, { ...a, sizeBytes: COPY_MAX_BYTES + 1 })).rejects.toThrow(/too large to copy in a browser: use dg repo fork/)
    io.storeFail = new Error('bucket unreachable token=s3cr3t')
    const seen: string[] = []
    const copy = forkCopier({} as never, REPO, s3('r2'), { ...words, onCopy: (h, state, why) => seen.push(`${state}${why ? `: ${why}` : ''}`) })
    const err = await copy(a.packHash, a).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CopyFailed)
    expect((err as Error).message).toMatch(resume)
    expect(seen).toEqual(['copying', 'failed: r2: bucket unreachable token=[redacted]'])
  })

  it('stops when the copy has no address other readers can use', async () => {
    io.storeUris = ['https://192.168.1.4/forge/x', 's3://forge/x']
    await expect(forkCopier({} as never, REPO, s3('r2'), { again: 'Update branch', cli: 'dg repo sync' })(a.packHash, a)).rejects.toThrow(/Press Update branch again/)
  })
})
