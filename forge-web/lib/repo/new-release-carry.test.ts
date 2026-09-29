/**
 * publishRelease superseding a release (D-504): it reads the current release for the tag itself
 * (never the page's possibly unloaded list) and carries its assets, title and notes forward; a
 * failed write reports as "uploaded" only this attempt's own uploads, never the kept assets nor
 * a retry's reused ones.
 */

import { describe, expect, it, vi } from 'vitest'

import type { EvoSDK } from '@dashevo/evo-sdk'
import type { WriteAuth } from '../sdk'
import type { RepoRef } from './contract'
import type { ReleaseView } from './releases'

const written: Record<string, unknown>[] = []
let failWrite = false
const H = 'ab'.repeat(32)
const current: ReleaseView = {
  id: 'r1',
  tagName: 'v1',
  name: 'One',
  notes: 'first notes',
  yanked: false,
  assets: [
    { name: 'app.tar.gz', sha256: H, size: 10, uris: ['https://a.example/app'] },
    { name: 'CHANGES.txt', sha256: H, size: 5, uris: ['https://a.example/c'] },
  ],
  badAssets: 0,
  notesBody: 'first notes',
  omitted: null,
  published: null,
  publisher: 'M',
  createdAt: 1,
}

vi.mock('./members', () => ({
  invalidateMembers: () => undefined,
  readViewerPermissions: async () => ({ maintain: true }),
}))
vi.mock('./releases', async (orig) => ({
  ...(await orig<typeof import('./releases')>()),
  readReleases: async () => ({ current: [current], previous: [] }),
}))
vi.mock('./writes', async (orig) => ({
  ...(await orig<typeof import('./writes')>()),
  createRelease: async (_sdk: unknown, _auth: unknown, _repo: unknown, input: Record<string, unknown>) => {
    written.push(input)
    if (failWrite) throw new Error('refused')
    return { documentId: 'D' }
  },
}))
vi.mock('../storage', async (orig) => ({
  ...(await orig<typeof import('../storage')>()),
  storeFile: async (bytes: Uint8Array, opts: { sha256Hex: string }) => ({
    sha256: opts.sha256Hex,
    sizeBytes: bytes.length,
    uris: ['https://pub.example/new'],
    confirmed: ['r2'],
    failures: [],
  }),
}))

const { ReleaseWriteError, publishRelease } = await import('./new-release')
const { policyFor } = await import('../storage')

const sdk = {} as EvoSDK
const auth = { identityId: 'M', network: 'testnet' } as unknown as WriteAuth
const repo = { visibility: 'public', repoId: 'R' } as unknown as RepoRef
const S3 = {
  name: 'r2',
  settings: { kind: 's3', provider: 'r2', endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'b', pathStyle: true, publicUrl: 'https://pub.example', prefix: 'rel' },
  secrets: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
} as const
const storage = { policy: policyFor(['r2'], 'one'), profiles: [S3] }
const file = (name: string) => ({ name, size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })
const kept = ['app.tar.gz', 'CHANGES.txt']

describe('publishRelease superseding a release (D-504)', () => {
  it('a yank with nothing else given keeps the assets, title and notes it reads itself', async () => {
    failWrite = false
    written.length = 0
    const { assets } = await publishRelease(sdk, auth, repo, { tagName: 'v1', name: '', notes: '', draft: 'd', files: [], yanked: true }, storage)
    expect(assets.map((a) => a.name)).toEqual(kept)
    expect(written[0]).toMatchObject({ yanked: true, name: 'One', notes: 'first notes' })
  })

  it('a failed write counts only the files this attempt uploaded', async () => {
    failWrite = true
    const input = { tagName: 'v1', name: '', notes: 'second', draft: 'd', files: [file('new.bin')] }
    const e = await publishRelease(sdk, auth, repo, input, storage).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ReleaseWriteError)
    const err = e as InstanceType<typeof ReleaseWriteError>
    expect(err.assets.map((a) => a.name)).toEqual([...kept, 'new.bin'])
    expect(err.assetsStored).toBe(1)

    // The retry re-signs exactly that release and uploads nothing: 0 uploaded, not 3; the
    // carried title with the given notes, the same assets, the same intent (one signed write).
    const retry = await publishRelease(sdk, auth, repo, { ...input, stored: err.resolved }, storage).catch((x: unknown) => x)
    expect((retry as InstanceType<typeof ReleaseWriteError>).assetsStored).toBe(0)
    expect((retry as InstanceType<typeof ReleaseWriteError>).assets).toEqual(err.assets)
    const [first, second] = written.slice(-2)
    expect(second).toEqual(first)
    expect(second).toMatchObject({ name: 'One', notes: 'second' })
  })

  it('a retry keeps the carried title and notes even with the form fields blank', async () => {
    failWrite = true
    const input = { tagName: 'v1', name: '', notes: '', draft: 'd', files: [], yanked: true }
    const err = (await publishRelease(sdk, auth, repo, input, storage).catch((x: unknown) => x)) as InstanceType<typeof ReleaseWriteError>
    failWrite = false
    await publishRelease(sdk, auth, repo, { ...input, stored: err.resolved }, storage)
    const [first, second] = written.slice(-2)
    expect(first).toMatchObject({ name: 'One', notes: 'first notes', yanked: true })
    expect(second).toEqual(first)
  })
})
