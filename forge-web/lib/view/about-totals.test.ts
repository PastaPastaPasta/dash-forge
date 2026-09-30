/**
 * The About card's release count and repo size against the Drive-shaped mock (`../repo/drive-mock`):
 * exactly two proved sums, whatever the repo's size, each on the index that proves it (`release.perTag`,
 * `packManifest.bytes`), and the values the card shows.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it } from 'vitest'

import type { ForgeIds } from '../deployments'
import type { DocumentQuery } from '../sdk'
import type { RepoRef } from '../repo/contract'
import { mockSdk, newSeen, type Doc, type Seen, type Store } from '../repo/drive-mock'
import { repoContentWritten } from '../repo/push'
import { readAboutTotals, repoSizeOf } from './repo-facts'
import { invalidateSessionCache } from './session-cache'

const FORGE: ForgeIds = { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY', group: 'GROUP' }
const REPO = 'C8XSf6R4shR1kqFKUZQnuaEZ5DkW7uoe9qtQYZpS5SRd'
const OTHER = 'Ad88NKGHimxUgGHrTGpBJjKpnzrQe8Zh4V5q13mRh85h'
const OWNER = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'

const repo: RepoRef = { forge: FORGE, repoId: REPO, ownerId: OWNER, name: 'demo', visibility: 'public' }

let n = 0
const release = (tagName: string, delta: number, repoId = REPO): Doc => ({ $id: `r${n}`, $createdAt: ++n, repoId, tagName, delta })
const pack = (kind: number, storage: number, sizeBytes: number, repoId = REPO): Doc => ({ $id: `p${n}`, $createdAt: ++n, repoId, kind, storage, sizeBytes })

function store(): Store {
  return {
    CORE: {
      release: [
        // v1: published, edited, unpublished and republished: live once.
        release('v1', 1),
        release('v1', 0),
        release('v1', -1),
        release('v1', 1),
        // v2: published then yanked (a yank is an edit: still counted, as GitHub lists it).
        release('v2', 1),
        release('v2', 0),
        // v3: published and taken down.
        release('v3', 1),
        release('v3', -1),
        // Another repo's release never counts.
        release('v1', 1, OTHER),
      ],
      packManifest: [
        // Git packs on Platform: the first superseded by the second, both still stored.
        pack(0, 0, 1_000_000),
        pack(0, 0, 250_000),
        // A git pack held externally.
        pack(0, 1, 4_000_000),
        // Not git packs: a locator, a flat index, release assets.
        pack(1, 0, 9_999),
        pack(2, 1, 9_999),
        pack(4, 1, 9_999_999),
        // Another repo's pack.
        pack(0, 0, 7_777_777, OTHER),
      ],
    },
  }
}

const NET = 'devnet' as const

beforeEach(() => invalidateSessionCache(''))

/** A mock whose release sum fails while `failing()` says so. */
function flakySdk(failing: () => boolean, data: Store = store()): { sdk: EvoSDK; seen: Seen } {
  const seen = newSeen()
  const sdk = mockSdk(data, seen) as unknown as { documents: { sum: (q: DocumentQuery, p: string) => Promise<Map<string, bigint>> } }
  const sum = sdk.documents.sum
  sdk.documents.sum = (q, p) => (q.documentTypeName === 'release' && failing() ? Promise.reject(new Error('node refused')) : sum(q, p))
  return { sdk: sdk as unknown as EvoSDK, seen }
}

const ofType = (seen: Seen, type: string): DocumentQuery[] => seen.sums.filter((q) => q.documentTypeName === type)

describe('readAboutTotals', () => {
  it('reads the release count and the git pack bytes in exactly two proved sums', async () => {
    const seen = newSeen()
    const totals = await readAboutTotals(mockSdk(store(), seen), repo, NET)

    expect(totals).toEqual({ releases: 2, gitPacks: { platform: 1_250_000, external: 4_000_000 } })
    expect(seen.sums).toHaveLength(2)
    expect([seen.queries.length, seen.counts.length, seen.composites.length]).toEqual([0, 0, 0])

    // perTag (repoId, tagName), rangeSummable: the carrier shape, `repoId in [R]` grouped by
    // `repoId` with a range over every tag.
    expect(ofType(seen, 'release')[0]).toEqual({
      dataContractId: 'CORE',
      documentTypeName: 'release',
      where: [['repoId', 'in', [REPO]], ['tagName', '>', '']],
      orderBy: [['repoId', 'asc']],
      groupBy: ['repoId'],
    })
    // bytes (repoId, storage, kind), summable: every property bound, one entry per storage.
    expect(ofType(seen, 'packManifest')[0]).toMatchObject({
      dataContractId: 'CORE',
      where: [['repoId', '==', REPO], ['storage', 'in', [0, 1]], ['kind', '==', 0]],
      groupBy: ['storage'],
    })
  })

  it('counts 0 releases and no bytes for a repo that never had either', async () => {
    const seen = newSeen()
    expect(await readAboutTotals(mockSdk({}, seen), repo, NET)).toEqual({ releases: 0, gitPacks: { platform: 0, external: 0 } })
    expect(seen.sums).toHaveLength(2)
  })

  it('does not use the plain range shape, which fails to verify over a repo with no releases', async () => {
    // Why the carrier: `repoId == R, tagName > ''` with no groupBy proves R by existence only.
    const plain = { dataContractId: 'CORE', documentTypeName: 'release', where: [['repoId', '==', REPO], ['tagName', '>', '']] }
    const sdk = mockSdk({}, newSeen()) as unknown as { documents: { sum: (q: unknown, p: string) => Promise<unknown> } }
    await expect(sdk.documents.sum(plain, 'delta')).rejects.toThrow(/absent path/)
  })

  it('keeps one total when the other read fails', async () => {
    const { sdk } = flakySdk(() => true)
    expect(await readAboutTotals(sdk, repo, NET)).toEqual({ releases: null, gitPacks: { platform: 1_250_000, external: 4_000_000 } })
  })

  it('keeps a good total for the session but reads a failed one again', async () => {
    let fail = true
    const { sdk, seen } = flakySdk(() => fail)
    expect((await readAboutTotals(sdk, repo, NET)).releases).toBeNull()
    fail = false
    expect(await readAboutTotals(sdk, repo, NET)).toEqual({ releases: 2, gitPacks: { platform: 1_250_000, external: 4_000_000 } })
    // The size was kept (read once); the failed count was read again (the failure never reached the mock).
    expect(ofType(seen, 'packManifest')).toHaveLength(1)
    expect(ofType(seen, 'release')).toHaveLength(1)
  })

  it('reads the count again after a publish drops the releases list, and the size after a push', async () => {
    const seen = newSeen()
    const sdk = mockSdk(store(), seen)
    await readAboutTotals(sdk, repo, NET)
    await readAboutTotals(sdk, repo, NET)
    expect(seen.sums).toHaveLength(2)

    // What the release pages drop after a publish or an unpublish.
    invalidateSessionCache(`releases:${NET}:${REPO}`)
    await readAboutTotals(sdk, repo, NET)
    expect([ofType(seen, 'release').length, ofType(seen, 'packManifest').length]).toEqual([2, 1])

    // A push from this tab.
    repoContentWritten(repo)
    await readAboutTotals(sdk, repo, NET)
    expect([ofType(seen, 'release').length, ofType(seen, 'packManifest').length]).toEqual([2, 2])
  })

  it("reads no count for a private repo (its sealed releases carry delta 0), only the size", async () => {
    const seen = newSeen()
    const totals = await readAboutTotals(mockSdk(store(), seen), { ...repo, visibility: 'private' }, NET)
    expect(totals).toEqual({ releases: null, gitPacks: { platform: 1_250_000, external: 4_000_000 } })
    expect(ofType(seen, 'release')).toHaveLength(0)
    expect(seen.sums).toHaveLength(1)
  })
})

describe('repoSizeOf', () => {
  it('shows the total, and where it is stored in the tooltip', () => {
    expect(repoSizeOf({ platform: 1_250_000, external: 4_000_000 })).toEqual({
      text: '5.0 MB',
      tooltip: 'Git packs stored for this repo: 1.2 MB on Platform, 3.8 MB external. Every pack pushed counts, including ones a later push superseded.',
    })
    expect(repoSizeOf({ platform: 2048, external: 0 })?.tooltip).toContain('2.0 KB on Platform.')
  })

  it('shows no size for a repo with no packs', () => {
    expect(repoSizeOf({ platform: 0, external: 0 })).toBeNull()
  })
})
