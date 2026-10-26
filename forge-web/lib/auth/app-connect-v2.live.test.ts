/**
 * App Connect v2 wallet sign-in, live on a devnet with a scripted wallet
 * (e2e/wallet-responder-v2.ts does what a wallet that speaks the profile does). SKIPPED by default
 * (real spend: it creates a repository, stars it, and registers and disables keys):
 *
 *   FORGE_LIVE=1 NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=sakura \
 *     pnpm exec vitest run lib/auth/app-connect-v2.live.test.ts
 *
 * Needs the RELAY test identity of the devnet (`~/.config/dash-forge/test-identities/devnet-sakura/
 * RELAY.identity.json`), or the identity file named by FORGE_WALLET_IDENTITY_FILE, with about
 * 0.2 DASH of credits. The app side is Forge's own code: the v2 request, the poll on the App
 * Connect contract, the vendored verifier plus Forge's key rules, the vault session, the renewal
 * and writes through the WriteEngine.
 *
 *   1. login: request (forge group, 0.05 DASH, 90 days) → the wallet adds one group-bound key and
 *      publishes the response → the verified grant covers all four contracts, has a budget and an
 *      expiry, and opens a session of origin `app-connect`;
 *   2. a forge-core write (a repository) and a forge-community write (a star) are signed by that
 *      one key, with no further approval;
 *   3. renewal: the session's `walletRenewalRequest` names the identity and carries the same
 *      connection id → the wallet adds a new key and disables the old one in the same update →
 *      the new key is stored and signs a write; the old key is disabled on chain;
 *   4. cleanup: the master key disables every key this run added.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_NETWORK, NETWORKS } from '../constants'
import { resetMemoryStores } from '../idb'
import { evoSdkService } from '../sdk'
import { createRepo, starRelation } from '../repo/writes'
import { authSdk } from '../sdk/facade'

import { approveV2, disableGrants, newV2Wallet } from '../../e2e/wallet-responder-v2'
import { appConnectV2Available, awaitV2Grant, newV2LoginRequest, readChainClock, type V2Grant } from './app-connect-v2'
import { AuthController } from './controller'
import { defaultLimits } from './limited-key'

// Node has no localStorage, so the connection id would be new on every request and the wallet
// could not tell a renewal from a second device: one fixed id stands in for the browser's.
const CONNECTION = new Uint8Array(16).fill(0x5a)
vi.mock('./connection-id', async (orig) => ({ ...(await orig<typeof import('./connection-id')>()), connectionId: () => CONNECTION }))

const DEVNET = NETWORKS.devnet.devnetName ?? ''
const FILE = process.env['FORGE_WALLET_IDENTITY_FILE'] ?? join(homedir(), '.config/dash-forge/test-identities', `devnet-${DEVNET}`, 'RELAY.identity.json')
const LIVE = process.env['FORGE_LIVE'] === '1' && DEFAULT_NETWORK === 'devnet' && existsSync(FILE)

describe.skipIf(!LIVE)('live App Connect v2 sign-in (scripted wallet, App Connect contract)', () => {
  it(
    'login, writes on every contract with one key, renewal in the wallet, cleanup',
    async () => {
      await evoSdkService.initialize({ network: 'devnet', contractIds: [], timeoutMs: 30000 })
      const sdk = evoSdkService.getSdk()
      const forge = NETWORKS.devnet.v2!
      const network = 'devnet' as const
      const wallet = newV2Wallet()
      const poll = { network, forge, intervalMs: 2000, settleMs: 2000 }
      expect(await appConnectV2Available(sdk, network)).toBe(true)

      /** The app shows `req`'s code; the wallet approves it; the app's poll verifies the answer. */
      async function approve(req: Parameters<typeof awaitV2Grant>[1]): Promise<{ grant: V2Grant; replacedKeyId: number | null; keyId: number }> {
        const answering = awaitV2Grant(sdk, req, poll)
        const approved = await approveV2({ wallet, uri: req.qrUri, identityFile: FILE, devnet: DEVNET })
        expect(approved.label).toBe('Dash Forge')
        const grant = await answering
        expect(grant.identityId).toBe(approved.identityId)
        expect(grant.key.keyId).toBe(approved.keyId)
        return { grant, replacedKeyId: approved.replacedKeyId, keyId: approved.keyId }
      }

      try {
        resetMemoryStores()
        const controller = new AuthController(async () => sdk, network)
        // The group check Forge runs before it shows a code.
        await controller.checkGroup()

        // 1. Login: one request, one key, bound to the whole group, with the default budget.
        const { timeMs } = await readChainClock(sdk)
        const proposed = defaultLimits(timeMs)
        const first = await approve(newV2LoginRequest(network, forge, { connectionId: CONNECTION, chainNow: timeMs }))
        expect(first.replacedKeyId).toBeNull()
        expect(first.grant.key.scope).toEqual({ core: true, collab: true, community: true, meta: true, unbounded: false })
        expect(first.grant.key.limits?.total).toBe(proposed.budgetCredits)
        const expiry = first.grant.key.limits?.expiresAt ?? 0
        expect(Math.abs(expiry - proposed.expiresAt)).toBeLessThan(60 * 60_000)

        const protection = { passphrase: 'live app connect v2 passphrase' }
        const session = await controller.adoptWalletKeys(first.grant.identityId, [first.grant.key], protection, { origin: 'app-connect' })
        expect(session.origin).toBe('app-connect')
        expect(session.grants).toMatchObject({ core: true, collab: true, community: true })
        expect(session.unlimited).toBeFalsy()
        const auth = controller.writeAuth!

        // 2. A forge-core write and a forge-community write, both signed by the one key: no grant sheet.
        const name = `ac-v2-e2e-${Date.now().toString(36)}`
        const repo = await createRepo(sdk, auth, forge, { name })
        expect(repo.repoId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/)
        const starOf = { kind: 'v2' as const, forge, repoId: repo.repoId, ownerId: first.grant.identityId, name, visibility: 'public' as const }
        expect(await starRelation(sdk, auth, first.grant.identityId, starOf).add()).toBe(true)

        // 3. Renewal in the wallet: the same identity and connection id, so the old key goes.
        const renewal = await controller.walletRenewalRequest()
        expect(renewal.identityHint).toBe(first.grant.identityId)
        expect(renewal.replacesKeyId).toBe(first.keyId)
        const second = await approve(renewal)
        expect(second.replacedKeyId).toBe(first.keyId)
        expect(second.keyId).not.toBe(first.keyId)
        const renewed = await controller.adoptWalletKeys(second.grant.identityId, [second.grant.key], protection, { origin: 'app-connect' })
        expect(renewed.keyId).toBe(second.keyId)
        expect(renewed.origin).toBe('app-connect')

        // The wallet disabled the old key in the update that added the new one.
        const identity = await authSdk(sdk).identities.fetch(first.grant.identityId)
        expect(identity?.publicKeys.find((k) => k.keyId === first.keyId)?.disabledAt).toBeDefined()
        expect(identity?.publicKeys.find((k) => k.keyId === second.keyId)?.disabledAt).toBeUndefined()

        // The new key signs: take the star back.
        expect(await starRelation(sdk, controller.writeAuth!, first.grant.identityId, starOf).remove()).toBe(true)
      } finally {
        // 4. Leave the identity as it was: disable what this run added.
        await disableGrants({ wallet, identityFile: FILE, devnet: DEVNET })
      }
    },
    20 * 60_000,
  )
})
