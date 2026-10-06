import { describe, expect, it } from 'vitest'

import { mirrorCopy, mirrorRecordOf, mirrorUrisOf } from './pack-mirrors'
import type { RepoRef } from './contract'
import type { PackManifest } from './packs'

const H = 'ab'.repeat(32)

describe('pack mirrors (web reader)', () => {
  it('reads a record, and skips one without a pack or addresses', () => {
    expect(mirrorRecordOf({ $id: 'm1', $ownerId: 'o', $createdAt: 3, packHash: H, kind: 1, uris: ['https://m.example/p'] })).toEqual({
      id: 'm1',
      owner: 'o',
      ownerRole: null,
      createdAt: 3,
      packHash: H,
      kind: 1,
      uris: ['https://m.example/p'],
    })
    expect(mirrorRecordOf({ $id: 'm2', packHash: H, kind: 1, uris: [] })).toBeNull()
  })

  it('stands in as one external copy at the mirrors, never for a private repo', async () => {
    const m = { packHash: H, storage: 0, uris: [], copies: [], documentId: 'd' } as unknown as PackManifest
    expect(mirrorCopy(m, ['ipfs://bafyq'])).toMatchObject({ storage: 1, uris: ['ipfs://bafyq'], copies: undefined })
    // A private repo reads nothing at all.
    expect(await mirrorUrisOf({} as never, { visibility: 'private' } as unknown as RepoRef, m)).toEqual([])
  })
})
