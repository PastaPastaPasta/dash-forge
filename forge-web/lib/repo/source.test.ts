/**
 * The v2 `repoId ==` prefix must keep complete reads tie-safe and descending reads pageable:
 * `queryAllDocuments` probes a page boundary's `$createdAt` only when every earlier order
 * field is pinned by `==` (`tieProbeAllowed`), and pages a descending read ascending
 * (`ascendingEquivalent`). The prefix is an `==` on an index's leading field, so both still
 * apply to every scoped complete read the readers make.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ascendingEquivalent, tieProbeAllowed } from '../sdk'
import type { RepoRef } from './contract'
import { COLLAB_TYPES, COMMUNITY_TYPES, CORE_TYPES } from '../layout'
import { repoSource } from './source'

const DEMO: RepoRef = {
  forge: { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'G' },
  repoId: 'R',
  ownerId: 'O',
  name: 'n',
  visibility: 'public',
}
const s = repoSource(DEMO)

describe('which contract holds a type', () => {
  const three = repoSource({ ...DEMO, forge: { ...DEMO.forge, community: 'COMMUNITY' } })
  it('routes core, collab and community types to their contracts', () => {
    expect(three.repoQuery('config').dataContractId).toBe('CORE')
    expect(three.repoQuery('issue').dataContractId).toBe('COLLAB')
    expect(three.repoQuery('transition').dataContractId).toBe('COLLAB')
    expect(three.repoQuery('repoKey').dataContractId).toBe('COLLAB')
    expect(three.repoQuery('consent').dataContractId).toBe('CORE')
    for (const t of ['event', 'authorEvent', 'milestone', 'runner', 'star', 'starBeat', 'watch', 'follow', 'checkRun', 'policy', 'webhook', 'profile']) {
      expect(three.repoQuery(t).dataContractId, t).toBe('COMMUNITY')
    }
  })

  it('refuses a type no contract holds (manifestPart is gone in RC1)', () => {
    expect(() => three.repoQuery('manifestPart')).toThrow(/no forge-v2 contract/)
  })

  it.each([
    ['forge-core', CORE_TYPES],
    ['forge-collab', COLLAB_TYPES],
    ['forge-community', COMMUNITY_TYPES],
  ] as const)('names the types the %s schema declares, and no other', (name, types) => {
    const schema = JSON.parse(readFileSync(resolve(process.cwd(), '..', 'forge-contracts', 'contracts', `${name}.json`), 'utf8')) as { documentSchemas: Record<string, unknown> }
    expect([...types].sort()).toEqual(Object.keys(schema.documentSchemas).sort())
  })
})

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
