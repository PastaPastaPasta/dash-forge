import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EvoSDK } from '@dashevo/evo-sdk'
import type { RepoRef } from '../repo/contract'
import type { PrivateSession } from '../repo/private-session'
import type { PackManifest } from '../repo/packs'
import { pinArtifactAccess, resetExternalFetchState } from './browse-source'

const branch = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../repo/pack-mirrors', () => ({ mirrorUrisOf: async () => [], resetMirrorUris: () => undefined }))
vi.mock('../repo/branch-ring', () => ({ branchRingFor: branch.read }))
const sdk = {} as EvoSDK
const repo = { forge: { core: 'core' }, repoId: 'r', ownerId: 'owner', name: 'repo', visibility: 'public' } as RepoRef
const pack = { packHash: 'ab'.repeat(32), kind: 0, sizeBytes: 128, objectCount: 0, chunkCount: 0, tips: [], supersedes: [], storage: 1, uris: ['https://copy.example/pack'], documentId: 'm', uploader: 'owner', createdAt: 1 } as PackManifest
const session = (epochs: number[], closed = false) => ({ id: String(epochs), closed, ctx: { keys: new Map(epochs.map((e) => [e, {}])) } }) as unknown as PrivateSession
function serve(version: number | null, epoch = 1): void {
  const bytes = new Uint8Array(36)
  if (version === null) bytes.set([80, 65, 67, 75])
  else { bytes.set([68, 70, 80, 75, version]); new DataView(bytes.buffer).setUint32(8, epoch) }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { status: 206, headers: { 'Content-Range': 'bytes 0-35/128' } })))
}
afterEach(() => { vi.unstubAllGlobals(); branch.read.mockReset(); resetExternalFetchState() })

describe('pinning follows the reader’s held keys', () => {
  it('includes public plain packs and refuses a private repo without its session', async () => {
    serve(null)
    expect(await pinArtifactAccess(sdk, repo, pack)).toEqual({ readable: true, private: false })
    expect(await pinArtifactAccess(sdk, { ...repo, visibility: 'private' }, pack)).toEqual({ readable: false, private: true })
  })
  it('skips members-only content without a key and includes a held epoch', async () => {
    serve(1)
    expect(await pinArtifactAccess(sdk, repo, { ...pack, kind: 64 })).toEqual({ readable: false, private: true })
    expect(await pinArtifactAccess(sdk, { ...repo, lane: session([1]) }, { ...pack, kind: 64 })).toEqual({ readable: true, private: true })
  })
  it('checks private-era packs even in a public repo; published keys need no private consent', async () => {
    serve(1, 2)
    expect((await pinArtifactAccess(sdk, repo, pack)).readable).toBe(false)
    expect(await pinArtifactAccess(sdk, { ...repo, published: session([2]) }, pack)).toEqual({ readable: true, private: false })
    expect(await pinArtifactAccess(sdk, { ...repo, published: session([1]), lane: session([2]) }, pack)).toEqual({ readable: true, private: true })
    expect((await pinArtifactAccess(sdk, { ...repo, published: session([2], true) }, pack)).readable).toBe(false)
  })
  it('includes narrower branch packs only with their shared branch key', async () => {
    serve(3)
    branch.read.mockResolvedValue(null)
    expect((await pinArtifactAccess(sdk, repo, pack)).readable).toBe(false)
    branch.read.mockResolvedValue({ ring: { branchOfKcv: () => 'branch' } })
    expect(await pinArtifactAccess(sdk, { ...repo, lane: session([1]) }, { ...pack, kind: 64 })).toEqual({ readable: true, private: true })
  })
  it('reports an unreachable header as skipped instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await pinArtifactAccess(sdk, repo, pack)).toMatchObject({ readable: false, unavailable: true })
  })
  it('skips unknown sealed formats', async () => {
    serve(9)
    expect((await pinArtifactAccess(sdk, repo, pack)).readable).toBe(false)
  })
})
