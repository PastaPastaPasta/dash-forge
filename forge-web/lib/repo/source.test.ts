/**
 * The v2 `repoId ==` prefix must keep complete reads tie-safe and descending reads pageable:
 * `queryAllDocuments` probes a page boundary's `$createdAt` only when every earlier order
 * field is pinned by `==` (`tieProbeAllowed`), and pages a descending read ascending
 * (`ascendingEquivalent`). The prefix is an `==` on an index's leading field, so both still
 * apply to every scoped complete read the readers make.
 */

import { describe, expect, it } from 'vitest'

import { ascendingEquivalent, tieProbeAllowed } from '../sdk'
import type { V2RepoRef } from './contract'
import { repoSource } from './source'

const V2: V2RepoRef = {
  kind: 'v2',
  forge: { core: 'CORE', collab: 'COLLAB', group: 'G' },
  repoId: 'R',
  ownerId: 'O',
  name: 'n',
  visibility: 'public',
}
const s = repoSource(V2)

describe('repoId-scoped complete reads', () => {
  it('stay tie-safe', () => {
    expect(tieProbeAllowed(s.repoQuery('config', { orderBy: [['$createdAt', 'asc']] }))).toBe(true)
    expect(tieProbeAllowed(s.repoQuery('event', { orderBy: [['$createdAt', 'asc']] }))).toBe(true)
    expect(
      tieProbeAllowed(
        s.repoQuery('refUpdate', { where: [['refNameHash', '==', 'h']], orderBy: [['$createdAt', 'asc']] }),
      ),
    ).toBe(true)
  })

  it('page a newest-first read ascending', () => {
    expect(ascendingEquivalent(s.repoQuery('packManifest', { orderBy: [['$createdAt', 'desc']] }))).toEqual([
      ['$createdAt', 'asc'],
    ])
  })
})
