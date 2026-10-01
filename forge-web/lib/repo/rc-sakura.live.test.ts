/**
 * Live, read-only smoke of forge-web's reads against the contracts registered on devnet sakura
 * (RC2, Platform v5; first written for RC1 on devnet bonsia): each contract holds exactly the
 * types the layout (`lib/layout.ts`) routes to it, every stamped type requires `vis`, and every
 * new or changed query the web makes is one the registered indexes answer (on a repo id nothing
 * uses, so each answers empty). Nothing is written.
 *
 * The ids are devnet-sakura.json's once committed; before that they come from the environment:
 *
 *   FORGE_LIVE=1 NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=sakura \
 *   [FORGE_RC1_CORE=… FORGE_RC1_COLLAB=… FORGE_RC1_COMMUNITY=… FORGE_RC1_GROUP=…] \
 *   pnpm vitest run lib/repo/rc-sakura.live.test.ts
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import { NETWORKS } from '../constants'
import { COLLAB_TYPES, COMMUNITY_TYPES, CORE_TYPES, PUBLIC_ONLY_TYPES, VIS_TYPES } from '../layout'
import { ensureSdk } from '../sdk/service'
import { countDocuments, queryAllDocuments } from '../sdk'
import { readRunners } from './checks'
import type { RepoRef } from './contract'
import { readGitPackBytes } from './packs'
import { findOwnManifest } from './push'
import { readReleaseCount } from './releases'
import { readTopicDocNames } from './settings'
import { repoSource } from './source'
import { readKindCounts, readThreadStates } from './transitions'
import { findConsent, readConsents, readTagLive } from './writes'

const env = (k: string): string => process.env[k] ?? ''
const fromEnv = { core: env('FORGE_RC1_CORE'), collab: env('FORGE_RC1_COLLAB'), community: env('FORGE_RC1_COMMUNITY'), group: env('FORGE_RC1_GROUP') }
const forge = Object.values(fromEnv).every((v) => v !== '') ? fromEnv : NETWORKS.devnet.v2 ?? fromEnv
const live = process.env['FORGE_LIVE'] === '1' && NETWORKS.devnet.devnetName === 'sakura' && Object.values(forge).every((v) => v !== '')

const id = (name: string): string => base58Encode(sha256(new TextEncoder().encode(`rc1-smoke:${name}`)))
const REPO: RepoRef = { forge, repoId: id('repo'), ownerId: id('owner'), name: 'rc1-smoke', visibility: 'public' }

type ContractJson = { documentSchemas: Record<string, { required?: string[] }> }

describe.skipIf(!live)('the registered contracts on devnet sakura (live, read-only)', () => {
  it('each contract holds the types the layout routes to it, and the stamped types require vis', async () => {
    const sdk = await ensureSdk('devnet')
    for (const [contractId, types] of [
      [forge.core, CORE_TYPES],
      [forge.collab, COLLAB_TYPES],
      [forge.community, COMMUNITY_TYPES],
    ] as const) {
      const contract = (await sdk.contracts.fetch(contractId)) as unknown as { toJSON(): ContractJson } | undefined
      expect(contract, contractId).toBeTruthy()
      const schemas = (contract as { toJSON(): ContractJson }).toJSON().documentSchemas
      expect(Object.keys(schemas).sort()).toEqual([...types].sort())
      for (const [type, schema] of Object.entries(schemas)) {
        if (VIS_TYPES.has(type) || PUBLIC_ONLY_TYPES.has(type)) expect(schema.required ?? [], type).toContain('vis')
      }
    }
  }, 180_000)

  it('answers every RC1 read the web makes (empty on an unused repo)', async () => {
    const sdk = await ensureSdk('devnet')
    const source = repoSource(REPO)
    const target = id('target')
    expect(await findConsent(sdk, REPO, id('member'))).toBeNull()
    expect(await readConsents(sdk, REPO)).toEqual([])
    expect(await readThreadStates(sdk, REPO, [target])).toEqual(new Map([[target, { code: 0, locked: false }]]))
    expect((await readKindCounts(sdk, REPO)).size).toBe(0)
    expect(await readTagLive(sdk, REPO, 'v1.0.0')).toBe(0)
    // The About card's totals: the carrier release sum proves an absent repo as 0 (the plain range sum fails there).
    expect(await readReleaseCount(sdk, REPO)).toBe(0)
    expect(await readGitPackBytes(sdk, REPO)).toEqual({ platform: 0, external: 0 })
    expect(await findOwnManifest(sdk, REPO, REPO.ownerId, 'ab'.repeat(32))).toBeNull()
    expect(await queryAllDocuments(sdk, source.chunkQuery('ab'.repeat(32), REPO.ownerId, [0, 1]))).toEqual([])
    expect(await readRunners(sdk, REPO)).toEqual([])
    expect(await readTopicDocNames(sdk, REPO)).toEqual([])
    expect(await countDocuments(sdk, source.repoQuery('issue'))).toBe(0)
    // Member events are read from forge-community since RC1.
    expect(await queryAllDocuments(sdk, source.targetQuery('event', { where: [['targetId', '==', target]], orderBy: [['targetId', 'asc'], ['$createdAt', 'asc']] }))).toEqual([])
  }, 180_000)
})
