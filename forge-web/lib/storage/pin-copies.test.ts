import { bytesToHex } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PackManifest } from '../repo/packs'
import type { RepoRef } from '../repo/contract'
import type { StorageProfile } from './profiles'

const io = vi.hoisted(() => ({
  stored: [] as { bytes: number; targets: readonly string[] }[],
  storeUris: ['https://cdn.example/forge/x'] as string[],
  storeFail: null as Error | null,
  recorded: [] as { packHash: string; uris: readonly string[]; intent?: string }[],
  recordFail: null as Error | null,
  bytes: new Map<string, Uint8Array>(),
  parent: [] as PackManifest[],
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
  storeFile: async (bytes: Uint8Array, opts: { policy: { targets: readonly string[] } }) => {
    if (io.storeFail) throw io.storeFail
    io.stored.push({ bytes: bytes.length, targets: opts.policy.targets })
    return { uris: io.storeUris }
  },
}))
vi.mock('../repo/pack-mirrors', async (orig) => ({
  ...(await orig<typeof import('../repo/pack-mirrors')>()),
  recordMirror: async (_sdk: unknown, _auth: unknown, _repo: unknown, packHash: string, uris: readonly string[], intent?: string) => {
    if (io.recordFail) throw io.recordFail
    io.recorded.push({ packHash, uris, ...(intent ? { intent } : {}) })
  },
}))
vi.mock('../repo/packs', async (orig) => ({
  ...(await orig<typeof import('../repo/packs')>()),
  readRepoPackManifests: async () => io.parent,
}))

const { COPY_MAX_BYTES, copyableProfiles, forkCopier, forkCopyProfile, mirrorAddress, pinCost, pinLabel, pinPacks, pinStatus, repoPacks } = await import('./pin-copies')

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
  io.recorded = []
  io.storeUris = ['https://cdn.example/forge/x']
  io.storeFail = null
  io.recordFail = null
  io.bytes = new Map(served)
  io.parent = []
})

describe('which storage a copy can use', () => {
  it('offers S3 with a public URL and IPFS nodes, never Platform or an address only you can reach', () => {
    const usable = copyableProfiles([s3('r2'), s3('lan', 'http://192.168.1.4:9000'), kubo('node'), kubo('lan-gw', 'http://192.168.1.4:8080'), platform])
    expect(usable.map((p) => p.name)).toEqual(['r2', 'node'])
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

  it('labels the button Pin, Pinned, or Update pin (N new)', () => {
    const packs = repoPacks([a, b])
    const mine = (h: string) => ({ id: h, repoId: 'R', packHash: h, kind: 1, uris: ['https://x.example/p'] })
    expect(pinLabel(null)).toBe('Pin')
    expect(pinLabel(pinStatus(packs, []))).toBe('Pin')
    expect(pinLabel(pinStatus(packs, [mine(a.packHash)]))).toBe('Update pin (1 new)')
    expect(pinLabel(pinStatus(packs, [mine(a.packHash), mine(b.packHash.toUpperCase())]))).toBe('Pinned')
  })

  it('leaves packs too large for a browser out of the count', () => {
    const status = pinStatus(repoPacks([a, big]), [])
    expect(status.missing.map((p) => p.packHash)).toEqual([a.packHash])
    expect(status.tooLarge.map((p) => p.packHash)).toEqual([big.packHash])
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

  it('never pins a private repository to storage', async () => {
    await expect(pinPacks({} as never, {} as never, { ...REPO, visibility: 'private' } as RepoRef, s3('r2'), [])).rejects.toThrow(/public repository/)
  })
})

describe("a fork's copies", () => {
  const a = packOf(new Uint8Array([1, 2, 3]), 1)

  it("copies a pack from the parent's copies, reading the parent once when none are given", async () => {
    io.parent = [a]
    const seen: string[] = []
    const copy = forkCopier({} as never, REPO, s3('r2'), (h, state) => seen.push(state))
    expect(await copy(a.packHash.toUpperCase())).toEqual(['https://cdn.example/forge/x'])
    expect(await copy(a.packHash, a)).toEqual(['https://cdn.example/forge/x'])
    expect(seen).toEqual(['copying', 'done', 'copying', 'done'])
  })

  it('keeps a pack by reference when it cannot be copied', async () => {
    io.storeFail = new Error('bucket unreachable')
    const seen: string[] = []
    const copy = forkCopier({} as never, REPO, s3('r2'), (h, state, why) => seen.push(`${state}${why ? `: ${why}` : ''}`))
    expect(await copy('ff'.repeat(32))).toBeNull()
    expect(await copy(a.packHash, { ...a, sizeBytes: COPY_MAX_BYTES + 1 })).toBeNull()
    expect(await copy(a.packHash, a)).toBeNull()
    expect(await copy(a.packHash, a)).toBeNull()
    expect(seen).toEqual(['skipped: not found', 'skipped: over 512 MiB', 'copying', 'failed: r2: bucket unreachable', 'skipped: r2: bucket unreachable'])
  })
})
