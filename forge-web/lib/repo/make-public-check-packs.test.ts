/**
 * The private era's packs as the check opens them (`openPrivateEraPacks`): a pack sealed under a key
 * the member holds that fails to open counts as not fetched (Everything stops; Code only stops when
 * its tips need it), never skipped quietly; one under a key not held, one uploaded without standing,
 * one sealed at or above the seal-off epoch and a plaintext one are left out quietly.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EpochKeys, sealPack } from '../private'
import type { PackManifest } from './packs'

const bytesByHash = new Map<string, Uint8Array>()
let manifests: PackManifest[] = []
/** What opening each pack does, by `packHash`. */
const opens = new Map<string, 'ok' | 'corrupt' | 'suspect'>()

vi.mock('./packs', async (orig) => ({
  ...(await orig<typeof import('./packs')>()),
  readRepoPackManifests: async () => manifests,
  packsOfKind: (m: readonly PackManifest[]) => m,
}))
vi.mock('../view/browse-source', () => ({
  loadStoredArtifactBytes: async (_sdk: unknown, _view: unknown, p: PackManifest) => {
    const b = bytesByHash.get(p.packHash)
    if (b === undefined) throw new Error('no copy could be fetched')
    return b
  },
}))
vi.mock('../view/private-packs', async (orig) => {
  const real = await orig<typeof import('../view/private-packs')>()
  return {
    ...real,
    openPrivateArtifact: async (_s: unknown, p: PackManifest) => {
      const how = opens.get(p.packHash)
      if (how === 'suspect') throw new real.SuspectPackError(p.packHash)
      if (how === 'corrupt') throw new Error('sealed artifact: sealedPackCorrupt')
      return new Uint8Array([0x50, 0x41, 0x43, 0x4b])
    },
  }
})

import { openPrivateEraPacks, type PackCache } from './make-public-check'
import type { RepoRef } from './contract'
import type { PrivateSession } from './private-session'

const REPO_ID = new Uint8Array(32).fill(0x11)
const REPO = { forge: { core: 'C', collab: 'C', community: 'C', group: 'G' }, repoId: 'R', ownerId: 'O', name: 'ledger', visibility: 'public' } as RepoRef
const sdk = {} as EvoSDK
/** The member holds the keys of epochs 0 and 1, not 2. */
const session = { resolution: { keys: new Map([[0, {}], [1, {}]]) } } as unknown as PrivateSession

let n = 0
async function pack(epoch: number | null, open: 'ok' | 'corrupt' | 'suspect' = 'ok', fetched = true): Promise<void> {
  n++
  const hash = n.toString(16).padStart(64, '0')
  const bytes = epoch === null ? new Uint8Array([0x50, 0x41, 0x43, 0x4b, n]) : await sealPack(await EpochKeys.import(REPO_ID, epoch, new Uint8Array(32).fill(epoch + 1)), new Uint8Array([n]))
  if (fetched) bytesByHash.set(hash, bytes)
  opens.set(hash, open)
  manifests.push({ packHash: hash } as PackManifest)
}

beforeEach(() => {
  bytesByHash.clear()
  opens.clear()
  manifests = []
})

describe("the private era's packs (L4)", () => {
  it('a pack under a key held that fails to open is not fetched, never skipped quietly; a later check tries it again', async () => {
    await pack(0)
    await pack(1, 'corrupt')
    const cache: PackCache = new Map()
    expect(await openPrivateEraPacks(sdk, session, REPO, cache)).toMatchObject({ unfetched: 1 })
    expect((await openPrivateEraPacks(sdk, session, REPO, cache)).unfetched).toBe(1)
  })

  it('left out quietly: a key not held, an upload without standing, a plaintext pack, and one at or above the seal-off', async () => {
    await pack(0)
    await pack(2, 'corrupt')
    await pack(1, 'suspect')
    await pack(null)
    await pack(1, 'corrupt')
    const got = await openPrivateEraPacks(sdk, session, REPO, new Map(), 1)
    expect(got).toEqual({ packs: [new Uint8Array([0x50, 0x41, 0x43, 0x4b])], unfetched: 0 })
  })

  it('a copy that cannot be fetched counts too', async () => {
    await pack(0, 'ok', false)
    expect((await openPrivateEraPacks(sdk, session, REPO)).unfetched).toBe(1)
  })
})
