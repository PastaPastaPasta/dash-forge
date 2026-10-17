/**
 * Which network the Playwright suite (and the live vitest tests that share its fixtures) targets.
 *
 *   E2E_NETWORK=devnet (default)   the devnet named by E2E_DEVNET (default `sakura`)
 *   E2E_NETWORK=testnet            Dash testnet; E2E_DEVNET must be unset
 *
 * The network picks the build the suite serves (`NEXT_PUBLIC_NETWORK`), the deployment record it
 * reads (`forge-contracts/deployments/devnet-<name>.json`, or `testnet.json`) and the read fixture
 * (`forge-contracts/deployments/fixtures/<same name>.json`, seeded by seed-v2-fixture.mjs).
 *
 * Testnet has no fixture file yet (the registration PR commits `fixtures/testnet.json`). Until it
 * exists, a spec that reads the fixture repos calls `skipWithoutFixture()` (helpers.ts) and skips
 * with the reason below; the specs that read nothing from the fixture run.
 *
 * Testnet is production: a spec that signs needs identities from `E2E_IDENTITY_DIR`, never the
 * July-era pool (QA-05), and never the real deployer.
 *
 * This module imports no Playwright code: playwright.config.ts and the vitest live tests load it too.
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type E2ENetwork = 'devnet' | 'testnet'

export interface E2ETarget {
  readonly network: E2ENetwork
  /** The devnet's name; the empty string on testnet (the convention of the specs' `E2E_DEVNET === ''` skips). */
  readonly devnet: string
  /** The deployment record's base name: `devnet-sakura`, `testnet`. */
  readonly name: string
}

const DEVNET_NAME = /^[a-z0-9-]+$/

/** Resolve the target from the environment (`env` is a parameter so the rules are unit tested). */
export function resolveE2ETarget(env: Readonly<Record<string, string | undefined>> = process.env): E2ETarget {
  const network = env['E2E_NETWORK'] || 'devnet'
  if (network !== 'devnet' && network !== 'testnet') {
    throw new Error(`E2E_NETWORK must be devnet or testnet, got ${JSON.stringify(network)} (no e2e suite runs on mainnet)`)
  }
  if (network === 'testnet') {
    if (env['E2E_DEVNET']) {
      throw new Error(`E2E_DEVNET=${env['E2E_DEVNET']} names a devnet but E2E_NETWORK=testnet: unset E2E_DEVNET`)
    }
    return { network, devnet: '', name: 'testnet' }
  }
  const devnet = env['E2E_DEVNET'] || 'sakura'
  if (!DEVNET_NAME.test(devnet)) {
    throw new Error(`E2E_DEVNET must match ${DEVNET_NAME} (lower-case letters, digits, hyphens), got ${JSON.stringify(devnet)}`)
  }
  return { network, devnet, name: `devnet-${devnet}` }
}

const TARGET = resolveE2ETarget()

export const E2E_NETWORK: E2ENetwork = TARGET.network
/** The devnet under test; '' on testnet. Keep the default in step with playwright.config.ts (both use resolveE2ETarget). */
export const E2E_DEVNET: string = TARGET.devnet
/** `devnet-<name>` or `testnet`: the file stem of the deployment record and the fixture summary. */
export const E2E_TARGET_NAME: string = TARGET.name

const REPO_ROOT = resolve(__dirname, '../..')

export function deploymentFilePath(target: E2ETarget = TARGET, root: string = REPO_ROOT): string {
  return join(root, 'forge-contracts', 'deployments', `${target.name}.json`)
}

export function fixtureFilePath(target: E2ETarget = TARGET, root: string = REPO_ROOT): string {
  return join(root, 'forge-contracts', 'deployments', 'fixtures', `${target.name}.json`)
}

/** True when the read fixture's summary is committed for this network (or `$FORGE_SEED_SUMMARY` names one). */
export function hasFixture(target: E2ETarget = TARGET, root: string = REPO_ROOT, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const override = env['FORGE_SEED_SUMMARY']
  return (override ? existsSync(override) : false) || existsSync(fixtureFilePath(target, root))
}

/** Why the fixture specs skip on a network that has no fixture summary. */
export function noFixtureReason(target: E2ETarget = TARGET): string {
  return (
    `no read fixture for ${target.name}: forge-contracts/deployments/fixtures/${target.name}.json is not committed ` +
    '(seed-v2-fixture.mjs writes it after the registration); set FORGE_SEED_SUMMARY to run against a local one'
  )
}

/** The build-time environment of the app under test (the config prefixes it to `pnpm build`). */
export function buildEnv(target: E2ETarget = TARGET): string {
  // MIN_STARGAZERS=1: trending.spec's seed has 3, 2 and 1 stargazers, under the hosted floor of 5.
  const net = target.network === 'devnet' ? `NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=${target.devnet}` : 'NEXT_PUBLIC_NETWORK=testnet'
  return `${net} NEXT_PUBLIC_MIN_STARGAZERS=1 `
}

/** evo-sdk constructor options for a Node-side read of the network under test. A devnet names itself and its recorded nodes; testnet discovers its nodes. */
export function sdkOptions(addresses: readonly string[] | undefined, target: E2ETarget = TARGET): Record<string, unknown> {
  if (target.network === 'testnet') return { network: 'testnet', trusted: true }
  return { network: 'devnet', trusted: true, devnetName: target.devnet, addresses }
}

/** `dg` / `git-remote-dash` environment for the network under test. */
export function dgEnv(target: E2ETarget = TARGET): Record<string, string> {
  return target.network === 'testnet'
    ? { DASH_FORGE_NETWORK: 'testnet', DASH_FORGE_DEVNET_NAME: '' }
    : { DASH_FORGE_NETWORK: 'devnet', DASH_FORGE_DEVNET_NAME: target.devnet }
}

/**
 * The July-era testnet pool (keys committed in forge-web/lib/sdk/write.test.ts, SECU-03): no spec
 * signs as one of these. Kept in step with forge-contracts/scripts/lib/target.mjs JULY_POOL_IDS
 * (lib/e2e-network.test.ts compares them).
 */
export const JULY_POOL_IDS: readonly string[] = [
  '8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB',
  '8igVywVvFTf8aNoaLfS9KsURfAfdHGb3gEeo3vGupZPV',
  'B72TJDCsaExkoET6enz6HZGvGcHiSRYupjgve9KARoGx',
  'BESA6ZwQD2qBdA5owz6YRm95GkL46xobC4k1s8XjehtM',
  'CmGHMP2VqWZng8gtF7Nr9pPXKzmFoKpJQs4mYrCHkyVw',
  '6acfxhgD2c8siYVmJrHgzTE3HF5DcyU3599T4r1vPTr1',
  'BSGeWyh3tQYT1p5Z7SaGpVhU4xsKzSEpQgAPZKTBmvv8',
  '7Tg7PXre8eQL1scWnwvXNa4jq35sbpPpXJ2NM8JxuVe3',
  '3r5GmtjsC2terox8RgXcJh8nPsgW4vT9gT36sA9hZx15',
]
