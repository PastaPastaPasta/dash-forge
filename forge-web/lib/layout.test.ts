/**
 * The contract layout over both deployment shapes (DESIGN rev 4.1 D44): sakura's three contracts
 * and a four-contract set with forge-meta. Parity: forge-core `layout` tests
 * (`the_layout_follows_the_deployment_record`, `the_four_contract_map_matches_the_layout_build`,
 * `the_four_contract_map_matches_the_mainnet_set`).
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { checkMembers } from './auth/group-trust'
import { forgeContractIds, forgeV2Ids, groupTrust, type DeploymentFile, type ForgeIds } from './deployments'
import { META_TYPES, contractKindOfType, rc1WriteProblem, writeContractKind } from './layout'
import { contractOf } from './repo/source'

const THREE: ForgeIds = { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY', group: 'G' }
const FOUR: ForgeIds = { ...THREE, meta: 'META' }

const OLD_HOME: Readonly<Record<string, string>> = {
  repoKey: 'COLLAB',
  ban: 'COLLAB',
  label: 'CORE',
  topic: 'CORE',
  packMirror: 'CORE',
  profile: 'COMMUNITY',
  follow: 'COMMUNITY',
}

describe('the layout follows the deployment record', () => {
  it('forge-meta holds the seven moved types only on a four-contract set', () => {
    expect([...META_TYPES].sort()).toEqual(Object.keys(OLD_HOME).sort())
    for (const t of META_TYPES) {
      expect(contractOf(THREE, t), t).toBe(OLD_HOME[t])
      expect(contractOf(FOUR, t), t).toBe('META')
      expect(writeContractKind(FOUR, t), t).toBe('meta')
      // Without the network's ids the answer is the three-contract home.
      expect(contractKindOfType(t), t).not.toBe('meta')
    }
    for (const t of ['repo', 'issue', 'comment', 'star', 'watch', 'event', 'runner']) {
      expect(contractOf(FOUR, t), t).toBe(contractOf(THREE, t))
    }
    expect(contractKindOfType('manifestPart', FOUR)).toBeNull()
  })

  it('the write chokepoint routes the moved types to forge-meta on a four-contract set', () => {
    expect(rc1WriteProblem(FOUR, 'META', 'label', { name: 'x' })).toBeNull()
    expect(rc1WriteProblem(FOUR, 'CORE', 'label', { name: 'x' })).toMatch(/forge-meta/)
    expect(rc1WriteProblem(FOUR, 'META', 'issue', { number: 1, vis: 'public' })).toMatch(/forge-collab/)
    expect(rc1WriteProblem(FOUR, 'META', 'topic', { name: 'x', vis: 'private' })).toMatch(/public/)
    expect(rc1WriteProblem(THREE, 'CORE', 'label', { name: 'x' })).toBeNull()
  })

  // The layout alone: `--mainnet` adds types such as B1's `pushGrant` that clients learn later.
  it('agrees with build.py --on layout_meta type for type', () => {
    const root = resolve(__dirname, '../../forge-contracts')
    const dir = mkdtempSync(join(tmpdir(), 'forge-meta-'))
    try {
      execFileSync('python3', [join(root, 'schema/build.py'), '--on', 'layout_meta', '--out', dir], { stdio: 'pipe' })
      let seen = 0
      for (const [file, kind] of [
        ['forge-core.json', 'core'],
        ['forge-collab.json', 'collab'],
        ['forge-community.json', 'community'],
        ['forge-meta.json', 'meta'],
      ] as const) {
        const json = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { documentSchemas: Record<string, unknown> }
        for (const t of Object.keys(json.documentSchemas)) {
          expect(contractKindOfType(t, FOUR), `${file}: ${t}`).toBe(kind)
          seen++
        }
      }
      expect(seen).toBeGreaterThan(META_TYPES.size)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The committed four-contract set (`build.py --mainnet`, what testnet and mainnet register).
  it('agrees with the committed mainnet set type for type', () => {
    const dir = resolve(__dirname, '../../forge-contracts/contracts/mainnet')
    const metaTypes: string[] = []
    for (const [file, kind] of [
      ['forge-core.json', 'core'],
      ['forge-collab.json', 'collab'],
      ['forge-community.json', 'community'],
      ['forge-meta.json', 'meta'],
    ] as const) {
      const json = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { documentSchemas: Record<string, unknown> }
      for (const t of Object.keys(json.documentSchemas)) {
        expect(writeContractKind(FOUR, t), `${file}: ${t}`).toBe(kind)
        expect(contractKindOfType(t, FOUR), `${file}: ${t}`).toBe(kind)
        if (kind === 'meta') metaTypes.push(t)
      }
    }
    expect(metaTypes.sort()).toEqual([...META_TYPES].sort())
  })
})

describe('the deployment record', () => {
  const record = (extra: Record<string, unknown> = {}): DeploymentFile =>
    ({
      v2: {
        forgeCore: { contractId: 'C', status: 'registered', ownerId: 'D' },
        forgeCollab: { contractId: 'L', status: 'registered' },
        forgeCommunity: { contractId: 'M', status: 'registered' },
        contractGroupId: 'G',
        ...extra,
      },
    }) as DeploymentFile

  it('reads forge-meta when recorded, and refuses a half-finished one', () => {
    expect(forgeV2Ids(record())).toEqual({ core: 'C', collab: 'L', community: 'M', group: 'G' })
    expect(forgeV2Ids(record({ forgeMeta: { contractId: 'X', status: 'registered' } }))).toEqual({ core: 'C', collab: 'L', community: 'M', meta: 'X', group: 'G' })
    expect(forgeV2Ids(record({ forgeMeta: { contractId: 'X', status: 'broadcasting' } }))).toBeNull()
    expect(forgeContractIds({ core: 'C', collab: 'L', community: 'M', meta: 'X', group: 'G' })).toEqual(['C', 'L', 'M', 'X'])
    expect(forgeContractIds({ core: 'C', collab: 'L', community: 'M', group: 'G' })).toEqual(['C', 'L', 'M'])
  })

  it("counts forge-meta's superseded contracts in the group as Forge's own", () => {
    const trust = groupTrust(
      record({
        forgeMeta: { contractId: 'X', status: 'registered' },
        forgeMetaSuperseded: [
          { contractId: 'OLDX', contractGroupId: 'G' },
          { contractId: 'ELSEWHERE', contractGroupId: 'H' },
        ],
      }),
    )
    expect(trust?.meta).toBe('X')
    expect(trust?.superseded).toEqual(['OLDX'])
  })
})

describe('group trust over both layouts', () => {
  const DEPLOYER = 'E24SPCssqYzFQmjcQ1hNmiLXrzz1o9AqTv54tuWNkgHz'
  const trust = { ...THREE, owner: DEPLOYER, superseded: [] as string[] }
  const members = (contracts: string[]) => ({ contracts, documentTypes: [], tokens: [] })

  it('a four-contract set knows forge-meta and needs it in the group', () => {
    const four = { ...trust, meta: 'META' }
    expect(checkMembers(four, members(['CORE', 'COLLAB', 'COMMUNITY', 'META']), new Map()).notice).toBeNull()
    expect(() => checkMembers(four, members(['CORE', 'COLLAB', 'COMMUNITY']), new Map())).toThrow(/forge-community COMMUNITY and forge-meta META/)
  })

  it('a three-contract build meets forge-meta as an unknown member', () => {
    const r = checkMembers(trust, members(['CORE', 'COLLAB', 'COMMUNITY', 'META']), new Map([['META', DEPLOYER]]))
    expect(r.unknown).toEqual(['META'])
  })
})
