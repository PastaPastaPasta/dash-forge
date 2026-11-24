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
  storeFile: async (bytes: Uint8Array, opts: { policy: { targets: readonly string[] }; profiles: readonly StorageProfile[] }) => {
    if (io.storeFail) throw io.storeFail
    const s = opts.profiles[0]?.settings
    io.stored.push({ bytes: bytes.length, targets: opts.policy.targets, ...(s && 'publicGateway' in s ? { publicGateway: s.publicGateway } : {}) })
    return { uris: io.storeUris }
  },
}))
vi.mock('./util', async (orig) => ({
  ...(await orig<typeof import('./util')>()),
  timedFetch: async (url: string) => {
    io.fetched.push(url)
    return { resp: { ok: io.gateway !== null }, bytes: async () => io.gateway ?? new Uint8Array(), discard: () => undefined }
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

const { COPY_MAX_BYTES, CopyFailed, copyableProfiles, forkCopier, forkCopyProfile, mirrorAddress, pinCost, pinLabel, pinPacks, pinStatus, readableByOthers, repoPacks, shareable } = await import('./pin-copies')

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

  it("records an IPFS public gateway URL only once it serves the pack, else the CID", async () => {
    io.storeUris = ['ipfs://bafyq']
    io.gateway = new Uint8Array([1, 2, 3])
    await pinPacks({} as never, {} as never, REPO, kubo('node', 'https://gw.example'), repoPacks([a, b]))
    expect(io.stored.map((x) => x.publicGateway)).toEqual(['', ''])
    expect(io.fetched).toEqual(['https://gw.example/ipfs/bafyq', 'https://gw.example/ipfs/bafyq'])
    expect(io.recorded.map((r) => r.uris)).toEqual([['https://gw.example/ipfs/bafyq'], ['ipfs://bafyq']])
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
