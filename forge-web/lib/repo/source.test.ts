/**
 * `repoSource`: which Forge contract holds each document type, and that the layout names
 * exactly the types each contract schema declares.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

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
    expect(() => three.repoQuery('manifestPart')).toThrow(/no Forge contract/)
  })

  it.each([
    ['forge-core', CORE_TYPES],
    ['forge-collab', COLLAB_TYPES],
    ['forge-community', COMMUNITY_TYPES],
  ] as const)('names the types the %s schema declares, and no other', (name, types) => {
    const schema = JSON.parse(readFileSync(resolve(process.cwd(), '..', 'forge-contracts', 'contracts', `${name}.json`), 'utf8')) as { documentSchemas: Record<string, unknown> }
    // A fused-star forge-community (RC2 C1) has no starBeat; the layout keeps it for the beat shape.
    // `pushGrant` is the mainnet set's only (B1, D42): clients detect it on the loaded contract.
    const optional = ['starBeat', 'pushGrant']
    const declared = [...types].filter((t) => !optional.includes(t) || t in schema.documentSchemas)
    expect(declared.sort()).toEqual(Object.keys(schema.documentSchemas).sort())
  })
})
