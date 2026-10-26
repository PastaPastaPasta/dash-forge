/**
 * The passkey vault, live on testnet or a devnet with a software authenticator (the vendored core's fake
 * adapter stands in for Face ID or a phone; everything else is Forge's own code: the Platform port
 * with proved reads, the writes through the WriteEngine, the chain check on every open, the vault
 * session). SKIPPED by default (real spend: it registers and disables a key, and writes, replaces
 * and deletes passkey entries):
 *
 *   FORGE_LIVE=1 NEXT_PUBLIC_NETWORK=testnet pnpm exec vitest run lib/auth/passkey-vault.live.test.ts
 *   (or NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=<name>)
 *
 * Needs the network's RELAY test identity (`~/.config/dash-forge/test-identities/<testnet|devnet-
 * name>/RELAY.identity.json`), or the identity file named by FORGE_WALLET_IDENTITY_FILE, with about
 * 0.05 DASH of credits. It also needs `vaultEntry` in the deployed forge-meta
 * (`deploy-v2.mjs --update meta`); until that lands the test says so and ends before it spends.
 *
 *   1. a limited key is registered for a fresh browser with the identity file (group-bound, 0.05 DASH);
 *   2. add a passkey, then a second: the group-bound key writes `vaultEntry` (whole-contract group
 *      membership covers a type added later: the assumption the update's rehearsal must confirm);
 *   3. a new device (empty browser storage) signs in with the passkey alone: same key, free reads;
 *   4. re-seal one entry with its passkey; remove both entries (refunded deposits);
 *   5. cleanup: the master key disables the key this run registered.
 *
 * It prints what each step cost, for docs/economics.md and lib/sdk/cost.ts (`FEE …` lines).
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { DEFAULT_NETWORK, NETWORKS } from '../constants'
import { resetMemoryStores } from '../idb'
import { evoSdkService } from '../sdk'
import { readIdentityBalance } from '../sdk/write'
import { fakePasskeyAdapter } from '../vendor/platform-auth/passkey-vault/__fixtures__/fake-passkey'
import { AuthController } from './controller'
import { vaultEntryDeployed } from './passkey-vault/deployed'

const network = DEFAULT_NETWORK
const FILE = process.env['FORGE_WALLET_IDENTITY_FILE'] ?? join(homedir(), '.config/dash-forge/test-identities', NETWORKS[network].key, 'RELAY.identity.json')
// Never on mainnet: it spends real credits.
const LIVE = process.env['FORGE_LIVE'] === '1' && network !== 'mainnet' && existsSync(FILE)

/** Credits to DASH, for the printed lines. */
const dash = (credits: bigint): string => (Number(credits) / 1e11).toFixed(6)

describe.skipIf(!LIVE)('live passkey vault (software authenticator, forge-meta vaultEntry)', () => {
  it(
    'add, add, sign in on a new device, re-seal, remove, cleanup',
    async () => {
      await evoSdkService.initialize({ network, contractIds: [], timeoutMs: 30000 })
      const sdk = evoSdkService.getSdk()
      const forge = NETWORKS[network].v2!
      if (forge.meta === undefined || !(await vaultEntryDeployed(sdk, forge.meta))) {
        // eslint-disable-next-line no-console
        console.log('SKIPPED: forge-meta on this network has no vaultEntry yet (deploy-v2.mjs --update meta is pending). Nothing was spent.')
        return
      }

      const fileText = readFileSync(FILE, 'utf8')
      const adapter = fakePasskeyAdapter({ multiDevice: true })
      const deps = {
        adapter: () => adapter,
        location: () => ({ hostname: 'localhost', pathname: '/' }),
        available: () => true,
      }
      const make = (): AuthController => new AuthController(async () => sdk, network, deps)
      const protection = { passphrase: 'live passkey vault passphrase' }
      let identityId = ''

      /** What `step` cost the identity, once the balance settles. */
      const measure = async (label: string, step: () => Promise<unknown>): Promise<bigint> => {
        const before = await readIdentityBalance(sdk, identityId)
        await step()
        let after = before
        for (let i = 0; i < 15; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 2000))
          const now = await readIdentityBalance(sdk, identityId)
          if (now === after && now !== before) break
          after = now
        }
        // eslint-disable-next-line no-console
        console.log(`FEE ${label}: ${before - after} credits (${dash(before - after)} DASH)`)
        return before - after
      }

      resetMemoryStores()
      const first = make()
      // Whoever holds the key at the end revokes it (the new device, once it signed in).
      let owner = first
      try {
        // 1. A fresh browser's limited key, registered with the identity file.
        const session = await first.importIdentity({ fileText }, protection)
        identityId = session.identityId
        expect(session.storage).toBe('vault')
        expect(first.platformPasskeyProblem()).toBeNull()

        // 2. Two passkeys: the first builds the owner's subtree, the second is the steady state.
        const firstFee = await measure('first entry', () => first.addPlatformPasskey())
        const secondFee = await measure('later entry', () => first.addPlatformPasskey())
        expect(firstFee).toBeGreaterThan(0n)
        expect(secondFee).toBeGreaterThan(0n)
        const rows = await first.listPlatformPasskeys()
        expect(rows).toHaveLength(2)
        expect(rows.every((r) => r.thisDevice && r.current && !r.needsUpdate && r.keyState === 'live')).toBe(true)

        // 3. A new device: nothing of the identity in this browser, the passkey alone.
        resetMemoryStores()
        const device = make()
        owner = device
        const free = await measure('sign-in (reads only)', async () => {
          const next = await device.signInWithPasskey()
          expect(next).toMatchObject({ identityId, keyId: session.keyId, storage: 'vault', origin: 'passkey' })
        })
        expect(free).toBe(0n)

        // 4. Re-seal one entry (its passkey confirms it), then remove both (deposits come back).
        const [one, two] = await device.listPlatformPasskeys()
        await measure('re-seal', async () => expect(await device.resealPlatformPasskeys({ id: one!.id })).toEqual({ resealed: 1, needUpdate: 0 }))
        await measure('delete (refund is negative)', () => device.removePlatformPasskey(one!.id))
        await measure('delete (the last one)', () => device.removePlatformPasskey(two!.id))
        expect(await device.listPlatformPasskeys()).toEqual([])
      } finally {
        // 5. Leave the identity as it was: the master key disables the key this run registered.
        if (identityId !== '') await owner.revokeStored(identityId, { fileText }, { removePasskeys: true }).catch(() => undefined)
      }
    },
    20 * 60_000,
  )
})
