import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import {
  JULY_POOL_IDS,
  buildEnv,
  deploymentFilePath,
  dgEnv,
  fixtureFilePath,
  hasFixture,
  noFixtureReason,
  resolveE2ETarget,
  sdkOptions,
} from '../e2e/network'

const DEVNET = resolveE2ETarget({})
const TESTNET = resolveE2ETarget({ E2E_NETWORK: 'testnet' })

describe('resolveE2ETarget', () => {
  it('defaults to devnet sakura, as before', () => {
    expect(DEVNET).toEqual({ network: 'devnet', devnet: 'sakura', name: 'devnet-sakura' })
    expect(resolveE2ETarget({ E2E_NETWORK: '' })).toEqual(DEVNET)
    expect(resolveE2ETarget({ E2E_NETWORK: 'devnet', E2E_DEVNET: 'moutai' })).toEqual({ network: 'devnet', devnet: 'moutai', name: 'devnet-moutai' })
  })

  it('selects testnet, with no devnet name', () => {
    expect(TESTNET).toEqual({ network: 'testnet', devnet: '', name: 'testnet' })
  })

  it('refuses ambiguity and unknown names', () => {
    expect(() => resolveE2ETarget({ E2E_NETWORK: 'testnet', E2E_DEVNET: 'sakura' })).toThrow(/unset E2E_DEVNET/)
    expect(() => resolveE2ETarget({ E2E_NETWORK: 'mainnet' })).toThrow(/devnet or testnet/)
    expect(() => resolveE2ETarget({ E2E_DEVNET: '../testnet' })).toThrow(/E2E_DEVNET must match/)
    expect(() => resolveE2ETarget({ E2E_DEVNET: 'Sakura' })).toThrow(/E2E_DEVNET must match/)
  })
})

describe('what a network selects', () => {
  it('the build environment', () => {
    expect(buildEnv(DEVNET)).toBe('NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=sakura NEXT_PUBLIC_MIN_STARGAZERS=1 ')
    expect(buildEnv(TESTNET)).toBe('NEXT_PUBLIC_NETWORK=testnet NEXT_PUBLIC_MIN_STARGAZERS=1 ')
  })

  it('the deployment record and the fixture summary', () => {
    const root = '/repo'
    expect(deploymentFilePath(DEVNET, root)).toBe('/repo/forge-contracts/deployments/devnet-sakura.json')
    expect(deploymentFilePath(TESTNET, root)).toBe('/repo/forge-contracts/deployments/testnet.json')
    expect(fixtureFilePath(DEVNET, root)).toBe('/repo/forge-contracts/deployments/fixtures/devnet-sakura.json')
    expect(fixtureFilePath(TESTNET, root)).toBe('/repo/forge-contracts/deployments/fixtures/testnet.json')
  })

  it('the SDK and dg settings', () => {
    expect(sdkOptions(['https://a:1443'], DEVNET)).toEqual({ network: 'devnet', trusted: true, devnetName: 'sakura', addresses: ['https://a:1443'] })
    // testnet discovers its nodes: the recorded list is not passed
    expect(sdkOptions(['https://a:1443'], TESTNET)).toEqual({ network: 'testnet', trusted: true })
    expect(dgEnv(DEVNET)).toEqual({ DASH_FORGE_NETWORK: 'devnet', DASH_FORGE_DEVNET_NAME: 'sakura' })
    expect(dgEnv(TESTNET)).toEqual({ DASH_FORGE_NETWORK: 'testnet', DASH_FORGE_DEVNET_NAME: '' })
  })
})

describe('the committed deployments', () => {
  it('sakura has its fixture; testnet has none until the registration commits one', () => {
    const repo = resolve(__dirname, '../..')
    expect(hasFixture(DEVNET, repo, {})).toBe(true)
    // a regression guard for this PR's premise: when fixtures/testnet.json lands, the skips lift on their own
    expect(hasFixture(TESTNET, repo, {})).toBe(readdirSync(join(repo, 'forge-contracts/deployments/fixtures')).includes('testnet.json'))
  })

  const tmp = mkdtempSync(join(tmpdir(), 'e2e-network-'))
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  it('a fixture file, or FORGE_SEED_SUMMARY, lifts the skip', () => {
    mkdirSync(join(tmp, 'forge-contracts/deployments/fixtures'), { recursive: true })
    expect(hasFixture(TESTNET, tmp, {})).toBe(false)
    const own = join(tmp, 'own-summary.json')
    writeFileSync(own, '{}')
    expect(hasFixture(TESTNET, tmp, { FORGE_SEED_SUMMARY: own })).toBe(true)
    expect(hasFixture(TESTNET, tmp, { FORGE_SEED_SUMMARY: join(tmp, 'missing.json') })).toBe(false)
    writeFileSync(join(tmp, 'forge-contracts/deployments/fixtures/testnet.json'), '{}')
    expect(hasFixture(TESTNET, tmp, {})).toBe(true)
  })

  it('names the file and the reason when it skips', () => {
    expect(noFixtureReason(TESTNET)).toMatch(/fixtures\/testnet\.json is not committed/)
  })
})

describe('the July pool', () => {
  it('matches the ids the contracts tools refuse', async () => {
    const target = (await import('../../forge-contracts/scripts/lib/target.mjs')) as { JULY_POOL_IDS: Map<string, string> }
    expect([...JULY_POOL_IDS].sort()).toEqual([...target.JULY_POOL_IDS.keys()].sort())
  })
})

describe('every spec that reads a fixture says so', () => {
  const dir = resolve(__dirname, '../e2e')
  const FIXTURE_NAMES = ['DEMO', 'EMPTY', 'MAINTAINER', 'loadSeedPulls']
  const importedFromHelpers = (src: string): string[] => {
    const m = /import \{([^}]*)\} from '\.\/helpers'/.exec(src)
    return m === null ? [] : (m[1] ?? '').split(',').map((n) => n.trim()).filter(Boolean)
  }

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.spec.ts'))) {
    const src = readFileSync(join(dir, file), 'utf8')
    const names = importedFromHelpers(src)
    const usesFixture = names.some((n) => FIXTURE_NAMES.includes(n))
    const readsRegistration = names.includes('deployment')
    if (!usesFixture && !readsRegistration) continue
    it(`${file} skips without the fixture or the registration`, () => {
      const skips = usesFixture ? /^skipWithoutFixture\(\)$/m : /^skip(WithoutFixture|WithoutRegistration)\(\)$/m
      expect(src).toMatch(skips)
    })
  }
})
