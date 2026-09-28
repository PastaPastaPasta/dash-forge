/**
 * The fork plan, ported from forge-core `fork.rs` with the same test cases as its Rust tests:
 * a Platform pack is referenced by the parent's chunk locator (not re-uploaded), an external
 * pack keeps the parent's URIs, one manifest per pack with every copy (members first), and
 * refs are copied once without moving the fork's own.
 */

import { describe, expect, it } from 'vitest'

import type { ForgeIds } from '../deployments'
import type { RefState } from '../rules'
import { forkManifest, planManifests, planRefs, type ForkCopy } from './fork'

const FORGE: ForgeIds = { core: 'CORE', collab: 'COLLAB', group: 'G' }
const PARENT = 'A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1'
const UPLOADER = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'

function manifest(id: string, hash: number, storage: 0 | 1, at: number, uris: string[], extra: Partial<ForkCopy> = {}): ForkCopy {
  return {
    documentId: id,
    createdAt: at,
    uploader: UPLOADER,
    ownerRole: 'maintainer',
    packHash: hash.toString(16).padStart(2, '0').repeat(32),
    kind: 0,
    sizeBytes: 10,
    objectCount: 3,
    storage,
    uris,
    supersedes: [],
    ...extra,
  }
}

describe('fork_manifest', () => {
  it("references a Platform pack by the parent's chunk locator, not re-uploaded", () => {
    const f = forkManifest(FORGE, PARENT, [manifest('a', 1, 0, 1, [])])
    expect(f).not.toBeNull()
    expect([f?.storage, f?.chunkCount]).toEqual([1, 0])
    expect(f?.uris).toEqual([`platform://CORE/${PARENT}/${UPLOADER}/${'01'.repeat(32)}`])
    expect(f?.packHash).toBe('01'.repeat(32))
    expect([f?.kind, f?.sizeBytes, f?.objectCount]).toEqual([0, 10, 3])
  })

  it("keeps an external pack's URIs, and names nothing when there is nothing to name", () => {
    const f = forkManifest(FORGE, PARENT, [manifest('a', 2, 1, 1, ['https://x/p.pack', 'ipfs://bafy', 's3://b/p.pack'])])
    expect(f?.storage).toBe(1)
    expect(f?.uris).toEqual(['https://x/p.pack', 'ipfs://bafy', 's3://b/p.pack'])
    expect(forkManifest(FORGE, PARENT, [manifest('b', 3, 1, 1, [])])).toBeNull()
    expect(forkManifest(FORGE, PARENT, [])).toBeNull()
  })

  it('drops s3:// first when the list is too long, then trims to 8 URIs of at most 300 bytes', () => {
    const https = Array.from({ length: 7 }, (_, i) => `https://m${i}/p`)
    const f = forkManifest(FORGE, PARENT, [manifest('a', 4, 1, 1, ['s3://b/1', ...https, 's3://b/2', `https://long/${'x'.repeat(300)}`])])
    expect(f?.uris).toEqual(https)
    const fits = forkManifest(FORGE, PARENT, [manifest('a', 4, 1, 1, ['s3://b/1', 'https://y'])])
    expect(fits?.uris).toEqual(['s3://b/1', 'https://y'])
  })
})

describe('plan_manifests', () => {
  it('writes one manifest per pack with every copy, members first; skips locators and packs the fork has', () => {
    const stranger = '7Ej2YTftCL23mVwvhviak8ZJMmpqcsVj7CU5KPxzyy4h'
    const all = [
      // A former member's early, chunkless copy of pack 1 ...
      manifest('hostile', 1, 0, 1, [], { uploader: stranger, ownerRole: null }),
      // ... and the maintainer's later one.
      manifest('plat', 1, 0, 5, ['https://x/p1']),
      manifest('other', 2, 1, 2, ['https://y']),
      manifest('had', 3, 0, 3, []),
      manifest('locator', 4, 0, 1, [], { kind: 1 }),
    ]
    const plan = planManifests(all, new Set(['03'.repeat(32)]))
    expect(plan.map((g) => g.map((m) => m.documentId))).toEqual([['plat', 'hostile'], ['other']])
    const f = forkManifest(FORGE, PARENT, plan[0] ?? [])
    const h = '01'.repeat(32)
    expect(f?.uris).toEqual([`platform://CORE/${PARENT}/${UPLOADER}/${h}`, `platform://CORE/${PARENT}/${stranger}/${h}`, 'https://x/p1'])
  })
})

describe('plan_refs', () => {
  const r = (oid: string): RefState => ({ state: 'resolved', oid, author: 'a', createdAt: 1 })
  const ref = (refName: string, state: RefState) => ({ refName, state })

  it("copies refs once and leaves the fork's own alone", () => {
    const parent = [
      ref('refs/heads/main', r('aa')),
      ref('refs/heads/dev', r('bb')),
      ref('refs/heads/new', r('cc')),
      ref('refs/heads/gone', { state: 'unborn' }),
    ]
    // A resumed fork: main copied, dev since moved by the fork's owner.
    const fork = [ref('refs/heads/main', r('aa')), ref('refs/heads/dev', r('dd'))]
    expect(planRefs(parent, fork)).toEqual([{ refName: 'refs/heads/new', oid: 'cc' }])
    expect(planRefs(parent, [])).toHaveLength(3)
  })

  it('copies a diverged ref at its provisional tip', () => {
    const diverged: RefState = {
      state: 'diverged',
      heads: [
        { oid: 'ee', author: 'a', createdAt: 2, id: 'x' },
        { oid: 'ff', author: 'b', createdAt: 1, id: 'y' },
      ],
    }
    expect(planRefs([ref('refs/heads/race', diverged)], [])).toEqual([{ refName: 'refs/heads/race', oid: 'ee' }])
  })
})
