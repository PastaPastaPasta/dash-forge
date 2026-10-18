import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { PackManifest } from '../repo/packs'
import type { RepoRef } from '../repo/contract'
import { cidV1RawLeaves } from './cid'
import { cidOfUri, enumeratePinTargets, pinRepo, readPinPlan, PIN_IN_FLIGHT_BYTES, WEB_PIN_MAX_BYTES, type PinPlan, type PinProgress, type PinTarget } from './pin'
import { validatePairResponse } from './kubo-connect'

const reads = vi.hoisted(() => ({ packs: vi.fn(), releases: vi.fn(), role: vi.fn(), access: vi.fn(), mirrors: vi.fn(), bytes: vi.fn(), list: vi.fn() }))
vi.mock('../repo/packs', async (load) => ({ ...await load<object>(), readRepoPackManifests: reads.packs }))
vi.mock('../repo/releases', async (load) => ({ ...await load<object>(), readReleases: reads.releases }))
vi.mock('../repo/members', () => ({ readRoleOracle: async () => ({ currentRole: reads.role }) }))
vi.mock('../repo/pack-mirrors', () => ({ mirrorUrisOf: reads.mirrors }))
vi.mock('../view/browse-source', () => ({ loadArtifactBytesProgress: reads.bytes, pinArtifactAccess: reads.access }))
vi.mock('../view/release-download', () => ({ downloadVerifiedAsset: reads.bytes, loadReleaseManifest: reads.list }))

const sdk = {} as EvoSDK
const repo = { forge: { core: 'core' }, repoId: 'r', ownerId: 'owner', name: 'repo', visibility: 'public' } as RepoRef
const profile = validatePairResponse({ name: 'kubo', api: 'http://127.0.0.1:5001', gateway: 'http://127.0.0.1:8080', auth: `Bearer ${'a'.repeat(43)}`, peerId: 'peer', version: '0.43.1' }).profile
const bytes = new TextEncoder().encode('the repo pack bytes')
const cid = cidV1RawLeaves(bytes)
const hash = bytesToHex(sha256(bytes))
const other = cidV1RawLeaves(new TextEncoder().encode('another importer CID'))
const target = (patch: Partial<PinTarget> = {}): PinTarget => ({ cid, sizeBytes: bytes.length, sha256: hash, what: 'pack abc', private: false, ...patch })
const plan = (...targets: PinTarget[]): PinPlan => ({ targets, sizeBytes: targets.reduce((n, t) => n + t.sizeBytes, 0), notOnIpfs: 0, membersOnlySkipped: 0, requiresConsent: targets.some((t) => t.private) })
const manifest = (patch: Partial<PackManifest> = {}): PackManifest => ({ packHash: hash, kind: 0, sizeBytes: bytes.length, objectCount: 1, chunkCount: 0, storage: 1, uris: [`ipfs://${cid}`], tips: [], supersedes: [], createdAt: 1, documentId: 'auth', uploader: 'owner', ownerRole: 'maintainer', ...patch })
const access = async (): Promise<{ readable: boolean; private: boolean }> => ({ readable: true, private: false })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks() })

function fakeNode(options: { already?: boolean; swarm?: string; addCid?: string; status?: number } = {}) {
  let pinned = options.already ?? false
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(init?.credentials).toBe('omit'); expect(init?.redirect).toBe('error')
    const u = new URL(String(url))
    if (u.pathname === '/api/v0/pin/ls') return pinned ? Response.json({ Keys: { [u.searchParams.get('arg')!]: { Type: 'recursive' } } }) : Response.json({ Message: 'not pinned or pinned indirectly' }, { status: 500 })
    if (u.pathname === '/api/v0/add') { pinned = true; return Response.json({ Hash: options.addCid ?? cid }) }
    if (u.pathname === '/api/v0/pin/add') return new Response(options.swarm ?? JSON.stringify({ Pins: [u.searchParams.get('arg')] }) + '\n', { status: options.status ?? 200 })
    if (u.pathname === '/api/v0/pin/rm') return Response.json({ Pins: [u.searchParams.get('arg')] })
    throw new Error('unexpected request')
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('authorized pin targets', () => {
  it('accepts IPFS URIs and gateway paths, rejecting junk', () => {
    expect(cidOfUri(`ipfs://${cid}`)).toBe(cid)
    expect(cidOfUri(`https://gw.example/ipfs/${cid}/file`)).toBe(cid)
    expect(cidOfUri('https://example/other')).toBeNull(); expect(cidOfUri('ipfs://not-a-cid!')).toBeNull()
  })
  it('strangers only add copies to an authorized hash, never metadata or a new target', async () => {
    const p = await enumeratePinTargets({ manifests: [manifest(), manifest({ documentId: 'stranger-copy', ownerRole: null, sizeBytes: 99999, uris: [`https://gw.example/ipfs/${other}`] }), manifest({ documentId: 'junk', packHash: 'ab'.repeat(32), ownerRole: null, uris: [`ipfs://${cidV1RawLeaves(new Uint8Array([123]))}`] })], access })
    expect(p.targets.map((t) => t.cid)).toEqual([cid, other]); expect(p.targets.map((t) => t.sizeBytes)).toEqual([bytes.length, bytes.length])
  })
  it('deduplicates CID copies, includes superseded packs, and counts non-IPFS and keyed skips', async () => {
    const p = await enumeratePinTargets({ manifests: [manifest(), manifest({ documentId: 'copy', uris: [`https://gw.example/ipfs/${cid}`] }), manifest({ documentId: 'older', packHash: 'a'.repeat(64), uris: ['https://bucket.example/blob'] }), manifest({ documentId: 'private', kind: 64, packHash: 'b'.repeat(64), supersedes: [hash] })], access: async (m) => ({ readable: m.kind !== 64, private: m.kind === 64 }) })
    expect(p.targets).toHaveLength(1); expect(p.notOnIpfs).toBe(1); expect(p.membersOnlySkipped).toBe(1)
  })
  it('includes mirror CIDs and release assets, and requires consent for sealed bytes', async () => {
    const p = await enumeratePinTargets({ manifests: [manifest()], access: async () => ({ readable: true, private: true }), mirrors: async () => [`ipfs://${other}`], assets: [{ name: 'file', sha256: hash, size: bytes.length, uris: [`ipfs://${cid}`] }] })
    expect(p.targets).toHaveLength(2); expect(p.requiresConsent).toBe(true)
  })
  it('reads only authorized releases and uses sealedSha256 for private assets', async () => {
    reads.packs.mockResolvedValue([]); reads.mirrors.mockResolvedValue([]); reads.role.mockImplementation((id: string) => id === 'owner' ? 'maintainer' : null)
    reads.releases.mockResolvedValue({ current: [{ publisher: 'stranger', assets: [{ name: 'junk', sha256: hash, size: bytes.length, uris: [`ipfs://${other}`] }] }, { publisher: 'owner', assets: [], sealed: { fields: { assetManifest: hash } } }], previous: [] })
    reads.list.mockResolvedValue({ assets: [{ name: 'encrypted', sha256: 'f'.repeat(64), sizeBytes: 1, sealedSha256: hash, sealedSizeBytes: bytes.length, uris: [`ipfs://${cid}`] }] })
    const privateRepo = { ...repo, visibility: 'private', session: { reader: 'owner', closed: false, ctx: { keys: {} } } } as unknown as RepoRef
    const p = await readPinPlan(sdk, privateRepo)
    expect(p.targets).toHaveLength(1); expect(p.targets[0]).toMatchObject({ cid, sha256: hash, sizeBytes: bytes.length, private: true })
  })
})

describe('resumable bounded pinning', () => {
  it('skips already pinned files without fetching bytes', async () => {
    const fetch = fakeNode({ already: true }); const fetchBytes = vi.fn()
    const result = await pinRepo(sdk, repo, profile, plan(target()), { fetchBytes })
    expect(result).toMatchObject({ already: 1, pinned: 0, failed: 0 }); expect(fetchBytes).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce()
  })
  it('verifies hash and local CID before add, then checks the recursive pin', async () => {
    const fetch = fakeNode(); const progress: PinProgress[] = []
    const result = await pinRepo(sdk, repo, profile, plan(target()), { fetchBytes: async () => bytes, onProgress: (p) => progress.push(p) })
    expect(result).toMatchObject({ pinned: 1, failed: 0 }); expect(progress.map((p) => p.state)).toEqual(['pinning', 'pinned'])
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/add?cid-version=1'))).toBe(true)
  })
  it('uses the browsing reader for stored bytes with cancellation', async () => {
    fakeNode(); reads.bytes.mockResolvedValue(bytes)
    const pack = manifest()
    expect((await pinRepo(sdk, repo, profile, plan(target({ pack })))).pinned).toBe(1)
    expect(reads.bytes).toHaveBeenCalledWith(sdk, repo, pack, undefined, undefined, true)
  })
  it('uses pin/add, never add, when another importer derived the CID', async () => {
    const fetch = fakeNode()
    const result = await pinRepo(sdk, repo, profile, plan(target({ cid: other })), { fetchBytes: async () => bytes })
    expect(result.pinned).toBe(1)
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/pin/add?'))).toBe(true)
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/api/v0/add?'))).toBe(false)
  })
  it('aborts excessive swarm blocks and removes the pin', async () => {
    const fetch = fakeNode({ swarm: '{"Progress":99999}\n' }); const rows: PinProgress[] = []
    const result = await pinRepo(sdk, repo, profile, plan(target({ cid: other })), { fetchBytes: async () => bytes, onProgress: (p) => rows.push(p) })
    expect(result.failed).toBe(1); expect(rows.at(-1)?.why).toMatch(/more blocks/)
    expect(fetch.mock.calls.some(([url]) => String(url).includes(`/pin/rm?arg=${other}`))).toBe(true)
  })
  it('cleans up a CID returned incorrectly by add', async () => {
    const fetch = fakeNode({ addCid: other })
    expect((await pinRepo(sdk, repo, profile, plan(target()), { fetchBytes: async () => bytes })).failed).toBe(1)
    expect(fetch.mock.calls.some(([url]) => String(url).includes(`/pin/rm?arg=${other}`))).toBe(true)
  })
  it('refuses blobs over 512 MiB before RPC or allocating bytes', async () => {
    const fetch = fakeNode(); const rows: PinProgress[] = []
    expect((await pinRepo(sdk, repo, profile, plan(target({ sizeBytes: WEB_PIN_MAX_BYTES + 1 })), { onProgress: (p) => rows.push(p) })).failed).toBe(1)
    expect(fetch).not.toHaveBeenCalled(); expect(rows.at(-1)?.why).toContain('use dg ipfs pin owner/repo')
  })
  it('uses swarm for a blob larger than the 128 MiB whole-file budget', async () => {
    const fetch = fakeNode(); const fetchBytes = vi.fn()
    expect((await pinRepo(sdk, repo, profile, plan(target({ sizeBytes: PIN_IN_FLIGHT_BYTES + 1 })), { fetchBytes })).pinned).toBe(1)
    expect(fetchBytes).not.toHaveBeenCalled(); expect(fetch.mock.calls.some(([url]) => String(url).includes('/pin/add?'))).toBe(true)
  })
  it('rejects corrupt bytes without starting a swarm pin', async () => {
    const fetch = fakeNode()
    expect((await pinRepo(sdk, repo, profile, plan(target()), { fetchBytes: async () => new Uint8Array(bytes.length) })).failed).toBe(1)
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('explains pin/add scope failures and requires private consent', async () => {
    fakeNode({ status: 403 }); const rows: PinProgress[] = []
    await pinRepo(sdk, repo, profile, plan(target({ cid: other })), { fetchBytes: async () => bytes, onProgress: (p) => rows.push(p) })
    expect(rows.at(-1)?.why).toMatch(/refresh the node’s token/)
    await expect(pinRepo(sdk, repo, profile, plan(target({ private: true })))).rejects.toThrow(/privacy checkbox/)
    await expect(pinRepo(sdk, { ...repo, visibility: 'private' }, profile, plan(target()), { consent: true })).rejects.toThrow(/Only members/)
  })
  it('bounds parallel whole-file reads by both count and bytes', async () => {
    fakeNode()
    let active = 0; let peak = 0
    const fetchBytes = vi.fn(async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 10)); active--; return bytes })
    const t = (i: number, size: number) => target({ cid: cidV1RawLeaves(new Uint8Array([i])), sizeBytes: size })
    await pinRepo(sdk, repo, profile, plan(t(1, 80 * 1048576), t(2, 80 * 1048576), t(3, 80 * 1048576)), { fetchBytes })
    expect(peak).toBe(1)
    peak = 0
    await pinRepo(sdk, repo, profile, plan(t(1, bytes.length), t(2, bytes.length), t(3, bytes.length)), { fetchBytes })
    expect(peak).toBe(2)
  })
  it('times out swarm pinning after two minutes and unpins', async () => {
    vi.useFakeTimers()
    const fetch = fakeNode()
    fetch.mockImplementation(async (url, init) => {
      if (String(url).includes('/pin/add?')) return new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted'))) } }))
      if (String(url).includes('/pin/rm?')) return Response.json({})
      return Response.json({ Message: 'not pinned' }, { status: 500 })
    })
    const rows: PinProgress[] = []
    const run = pinRepo(sdk, repo, profile, plan(target({ cid: other })), { fetchBytes: async () => bytes, onProgress: (p) => rows.push(p) })
    await vi.advanceTimersByTimeAsync(120001)
    expect((await run).failed).toBe(1); expect(rows.at(-1)?.why).toMatch(/two minutes/)
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/pin/rm?'))).toBe(true)
  })
  it('does no work after cancellation and handles invalid sizes without hanging', async () => {
    const fetch = fakeNode(); const controller = new AbortController(); controller.abort()
    expect(await pinRepo(sdk, repo, profile, plan(target()), { signal: controller.signal })).toMatchObject({ pinned: 0, failed: 0 })
    expect(fetch).not.toHaveBeenCalled()
    expect((await pinRepo(sdk, repo, profile, plan(target({ sizeBytes: NaN })))).failed).toBe(1)
  })
})
