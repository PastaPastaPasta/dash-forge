/**
 * Mobile wallet sign-in, live on a devnet with a scripted wallet (e2e/wallet-responder.mjs does
 * what Dash Wallet does). SKIPPED by default (real spend):
 *
 *   FORGE_LIVE=1 NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=sakura \
 *     pnpm exec vitest run lib/auth/wallet-login.live.test.ts
 *
 * The app side is Forge's own code: the dash-key request, the poll on the legacy key-exchange
 * copy, dash-st, the on-chain key checks, the vault session, and writes through the WriteEngine.
 *
 *   1. first login: request (forge-core) → wallet approves → register (QR #2) → key lands bound
 *      to forge-core, without limits → session → a forge-core write (a repo) is signed by it;
 *      a forge-collab write (a star) is refused locally with MissingGrantError, nothing sent;
 *   2. the one-tap grant: request (forge-collab) → wallet approves → register → the star lands;
 *   3. returning login: a new request is answered with the already-registered key, no QR #2;
 *   4. cleanup: the master key disables the keys this run added.
 *
 * Uses the RELAY fixture identity (unused by the other suites) and a chain key fixed per run.
 */

import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

import { DEFAULT_NETWORK, NETWORKS } from '../constants'
import { resetMemoryStores } from '../idb'
import { evoSdkService } from '../sdk'
import { createRepo, starRelation } from '../repo/writes'
import { awaitRegisteredKey, awaitWalletAnswer, newLoginRequest, responseSources } from './app-connect'
import { AuthController, MissingGrantError } from './controller'
import { keyRegistrationUri, RevokedWalletKey, type WalletKey } from './key-registration'

const DEVNET = NETWORKS.devnet.devnetName ?? ''
const FILE = join(homedir(), '.config/dash-forge/test-identities', `devnet-${DEVNET}`, 'RELAY.identity.json')
const LIVE = process.env['FORGE_LIVE'] === '1' && DEFAULT_NETWORK === 'devnet' && existsSync(FILE)
const CHAIN_KEY = randomBytes(32).toString('hex')

type Responder = typeof import('../../e2e/wallet-responder.mjs')

describe.skipIf(!LIVE)('live wallet sign-in (scripted Dash Wallet, legacy key-exchange contract)', () => {
  it(
    'first login, one-tap forge-collab grant, returning login, cleanup',
    async () => {
      const wallet: Responder = await import(pathToFileURL(resolve(__dirname, '../../e2e/wallet-responder.mjs')).href)
      await evoSdkService.initialize({ network: 'devnet', contractIds: [], timeoutMs: 30000 })
      const sdk = evoSdkService.getSdk()
      const forge = NETWORKS.devnet.v2!
      const network = 'devnet' as const
      const sources = await responseSources(sdk, NETWORKS.devnet.key)
      expect(sources.map((s) => s.kind)).toEqual(['legacy', 'app-connect'])
      const opts = { network, forge, sources, intervalMs: 2000, settleMs: 2000 }

      /** The app shows `contractId`'s request; the wallet approves and, if asked, registers. */
      async function signIn(contractId: string, identityId?: string): Promise<{ identityId: string; key: WalletKey; registered: boolean }> {
        const req = newLoginRequest(network, contractId)
        const answering = awaitWalletAnswer(sdk, req, { ...opts, ...(identityId ? { identityId } : {}) })
        const approved = await wallet.approve({ uri: req.uri, identityFile: FILE, chainKeyHex: CHAIN_KEY, devnet: DEVNET })
        expect(approved.contractId).toBe(contractId)
        expect(approved.label).toBe('Dash Forge')
        const answer = await answering
        if (answer.kind === 'keys') return { identityId: answer.identityId, key: answer.keys[0]!, registered: false }
        const until = Date.now() + 5 * 60_000
        const uri = await keyRegistrationUri(sdk, { identityId: answer.identityId, keys: answer.keys, contractId, network })
        await wallet.register({ uri, identityFile: FILE, chainKeyHex: CHAIN_KEY, contractId, devnet: DEVNET })
        const key = await awaitRegisteredKey(sdk, { identityId: answer.identityId, wif: answer.wif, network, forge, until })
        return { identityId: answer.identityId, key, registered: true }
      }

      try {
        // 1. First login on forge-core: QR #2 registers the key, bound to forge-core, no limits.
        const first = await signIn(forge.core)
        expect(first.registered).toBe(true)
        expect(first.key.scope).toEqual({ core: true, collab: false, unbounded: false })
        expect(first.key.limits).toBeNull()

        resetMemoryStores()
        const controller = new AuthController(async () => sdk, network)
        const session = await controller.adoptWalletKeys(first.identityId, [first.key], { passphrase: 'live wallet e2e passphrase' })
        expect(session.grants).toEqual({ core: true, collab: false })
        expect(session.unlimited).toBe(true)
        const auth = controller.writeAuth!

        // A forge-core write, signed by the wallet's key.
        const name = `wallet-e2e-${Date.now().toString(36)}`
        const repo = await createRepo(sdk, auth, forge, { name })
        expect(repo.repoId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/)

        // A forge-collab write: refused before signing (nothing broadcast, nothing charged).
        const starOf = { kind: 'v2' as const, forge, repoId: repo.repoId, ownerId: first.identityId, name, visibility: 'public' as const }
        await expect(starRelation(sdk, auth, first.identityId, starOf).add()).rejects.toBeInstanceOf(MissingGrantError)

        // 2. The one-tap grant for forge-collab, then the star lands.
        const grant = await signIn(forge.collab, first.identityId)
        expect(grant.key.scope).toEqual({ core: false, collab: true, unbounded: false })
        const after = await controller.addWalletGrant(first.identityId, grant.key, forge.collab)
        expect(after.grants).toEqual({ core: true, collab: true })
        expect(await starRelation(sdk, controller.writeAuth!, first.identityId, starOf).add()).toBe(true)

        // 3. Returning login: the registered key answers straight away.
        const again = await signIn(forge.core)
        expect(again.registered).toBe(false)
        expect(again.key.keyId).toBe(first.key.keyId)
      } finally {
        // 4. Leave the identity as it was: disable what this run added.
        await wallet.disableDerived({ identityFile: FILE, chainKeyHex: CHAIN_KEY, contractIds: [forge.core, forge.collab], devnet: DEVNET })
      }
    },
    20 * 60_000,
  )

  it(
    'Android: the key lands unbounded, covers both contracts, and a revoked key is not registered again',
    async () => {
      const wallet: Responder = await import(pathToFileURL(resolve(__dirname, '../../e2e/wallet-responder.mjs')).href)
      await evoSdkService.initialize({ network: 'devnet', contractIds: [], timeoutMs: 30000 })
      const sdk = evoSdkService.getSdk()
      const forge = NETWORKS.devnet.v2!
      const network = 'devnet' as const
      const sources = await responseSources(sdk, NETWORKS.devnet.key)
      const chainKey = randomBytes(32).toString('hex')
      const opts = { network, forge, sources, intervalMs: 2000, settleMs: 2000 }
      try {
        const req = newLoginRequest(network, forge.core)
        const answering = awaitWalletAnswer(sdk, req, opts)
        await wallet.approve({ uri: req.uri, identityFile: FILE, chainKeyHex: chainKey, devnet: DEVNET })
        const answer = await answering
        if (answer.kind !== 'register') throw new Error('expected a first login')
        const uri = await keyRegistrationUri(sdk, { identityId: answer.identityId, keys: answer.keys, contractId: forge.core, network })
        await wallet.register({ uri, identityFile: FILE, chainKeyHex: chainKey, contractId: forge.core, devnet: DEVNET, android: true })
        const key = await awaitRegisteredKey(sdk, { identityId: answer.identityId, wif: answer.wif, network, forge, until: Date.now() + 5 * 60_000 })
        // Android drops the bound: the key covers both contracts (and any other), no limits.
        expect(key.scope).toEqual({ core: true, collab: true, unbounded: true })
        expect(key.limits).toBeNull()

        resetMemoryStores()
        const controller = new AuthController(async () => sdk, network)
        const session = await controller.adoptWalletKeys(answer.identityId, [key], { passphrase: 'live wallet e2e passphrase' })
        expect(session.grants).toEqual({ core: true, collab: true })
        expect(session.unbounded).toBe(true)

        // Revoke it; a new login from the same wallet derives the same key: refused.
        await wallet.disableDerived({ identityFile: FILE, chainKeyHex: chainKey, contractIds: [forge.core], devnet: DEVNET })
        const again = newLoginRequest(network, forge.core)
        const answering2 = awaitWalletAnswer(sdk, again, opts)
        await wallet.approve({ uri: again.uri, identityFile: FILE, chainKeyHex: chainKey, devnet: DEVNET })
        await expect(answering2).rejects.toBeInstanceOf(RevokedWalletKey)
      } finally {
        await wallet.disableDerived({ identityFile: FILE, chainKeyHex: chainKey, contractIds: [forge.core], devnet: DEVNET })
      }
    },
    20 * 60_000,
  )
})
