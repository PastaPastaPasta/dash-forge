import { test, expect, type Browser, type BrowserContext, type Page, type Route } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { E2E_NETWORK, PASSPHRASE, idFile, importIdentity, shot, unlock } from './helpers'

/**
 * Passkeys that hold a key on Platform (docs/security/passkey-vault.md): the sign-in sheet's
 * "Sign in with a passkey", and Settings → Devices & keys → "Passkeys for other devices".
 * Chromium's virtual authenticator (CDP `WebAuthn.addVirtualAuthenticator`, with PRF) stands in for
 * Face ID, Touch ID or a phone.
 *
 * A WebAuthn relying party id cannot be an IP address, and Forge allows exactly `forge.dashhq.org`
 * and `localhost`. The suite's default base URL is http://127.0.0.1:<port>, so the specs that need
 * a passkey open http://localhost:<port> instead (the same local static server).
 *
 * The passkeys are inert until forge-meta has the `vaultEntry` type (a pending `--update meta` on
 * sakura): the sign-in sheet shows no passkey tile and Settings no section until then.
 *
 * No network or spend (hermetic):
 *
 *   E2E_DEVNET=sakura E2E_SKIP_BUILD=1 pnpm exec playwright test passkey-vault.spec.ts --project chromium
 *
 *   h1. On http://127.0.0.1 (an address, never a relying party) the sheet offers no passkey sign-in.
 *   h2. On http://localhost, with Platform answering that no contract exists, it stays hidden too.
 *
 * Reads only (the devnet's nodes answer; skips itself when none accepts a connection, and when
 * forge-meta has no `vaultEntry` yet):
 *
 *   r1. A passkey that only unlocks the browser that made it (a random 32-byte user handle) says
 *       so, and nothing is stored.
 *
 * Live (real spend on a devnet with the RELAY test identity; `E2E_WRITE=1`; needs `vaultEntry` in
 * the deployed forge-meta):
 *
 *   E2E_DEVNET=sakura E2E_WRITE=1 pnpm exec playwright test passkey-vault.spec.ts --project chromium
 *
 *   w1. Import the identity (one limited key) → the one-time offer → Settings → add a passkey
 *       (two prompts) → "Forget this browser" → "Sign in with a passkey" lands on the same key →
 *       renew the key with the identity file, which re-seals this device's passkey (no "Needs
 *       update") → remove the passkey.
 */

test.skip(E2E_NETWORK === 'testnet', 'testnet has no forge-v2 deployment, so no forge-meta to hold passkey entries')

const PORT = Number(process.env['E2E_PORT'] ?? 4321)
const LOCALHOST = `http://localhost:${PORT}`
const QUORUMS = /^https:\/\/quorums\.[a-z0-9-]+\.networks\.dash\.org\//
const DAPI = /\/org\.dash\.platform\.dapi\.v0\.Platform\/\w+$/
const DRIVE_MESSAGE = 'contract not found error: contract not found when querying from value with contract info'

/** A platform authenticator with PRF, user verification and resident keys, that approves every prompt. */
async function addAuthenticator(page: Page): Promise<{ credentialCount(): Promise<number> }> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable', { enableUI: false })
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  })
  return { credentialCount: async () => (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials.length }
}

async function cors(route: Route): Promise<Record<string, string>> {
  return {
    'access-control-allow-origin': (await route.request().headerValue('origin')) ?? '*',
    'access-control-expose-headers': 'grpc-status,grpc-message',
  }
}

/** Platform answers every read that no contract exists (as contracts-missing.spec.ts does). */
async function platformHasNoContracts(context: BrowserContext): Promise<{ requests: number }> {
  const stats = { requests: 0 }
  await context.route(QUORUMS, async (route) => {
    const previous = new URL(route.request().url()).pathname.endsWith('/previous')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: await cors(route),
      body: JSON.stringify(previous ? { success: true, data: { height: 10, quorums: [] } } : { success: true, data: [] }),
    })
  })
  await context.route(DAPI, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { ...(await cors(route)), 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } })
    }
    stats.requests++
    return route.fulfill({
      status: 200,
      body: '',
      headers: { ...(await cors(route)), 'content-type': 'application/grpc-web+proto', 'grpc-status': '3', 'grpc-message': encodeURIComponent(DRIVE_MESSAGE) },
    })
  })
  return stats
}

async function openSheet(page: Page): Promise<void> {
  await page.getByRole('banner').getByRole('button', { name: /^sign in$/i }).first().click()
  await expect(page.getByTestId('tile-create')).toBeVisible({ timeout: 60_000 })
}

test.describe('hermetic: the sheet hides passkeys where they cannot work', () => {
  test('h1. on 127.0.0.1 (an address is never a relying party) there is no passkey sign-in', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await openSheet(page)
    // The other options are there: only the passkey tile is not.
    await expect(page.getByTestId('tile-import')).toBeVisible()
    await page.waitForTimeout(1_500)
    await expect(page.getByTestId('tile-passkey')).toHaveCount(0)
    await shot(page, 'passkey-vault-01-no-tile-on-ip')
  })

  test('h2. on localhost, a network whose forge-meta cannot be read as having the vault keeps it hidden', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: LOCALHOST })
    const page = await context.newPage()
    await addAuthenticator(page)
    const stats = await platformHasNoContracts(context)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await openSheet(page)
    // The sheet asked Platform (the check reads forge-meta once the sheet is open); it said no.
    await expect.poll(() => stats.requests, { timeout: 60_000 }).toBeGreaterThan(0)
    await page.waitForTimeout(3_000)
    await expect(page.getByTestId('tile-passkey')).toHaveCount(0)
    await expect(page.getByTestId('tile-import')).toBeVisible()
    await context.close()
  })
})

/** Whether the first DAPI node of the devnet under test accepts a TCP connection (5 s). */
async function devnetReachable(): Promise<boolean> {
  const { connect } = await import('node:net')
  const { resolve } = await import('node:path')
  const { deploymentFilePath } = await import('./network')
  try {
    const dep = JSON.parse(readFileSync(deploymentFilePath(undefined, resolve(__dirname, '../..')), 'utf8')) as { dapiAddresses?: string[]; v2?: { devnet?: { addresses?: string[] } } }
    const address = (dep.dapiAddresses ?? dep.v2?.devnet?.addresses ?? [])[0]
    if (!address) return false
    const url = new URL(address)
    return await new Promise<boolean>((done) => {
      const socket = connect({ host: url.hostname, port: Number(url.port || 443) })
      const end = (ok: boolean): void => {
        socket.destroy()
        done(ok)
      }
      socket.setTimeout(5000, () => end(false))
      socket.once('connect', () => end(true))
      socket.once('error', () => end(false))
    })
  } catch {
    return false
  }
}

test.describe('reads only: a passkey this browser made for itself', () => {
  test.beforeAll(async () => {
    test.skip(!(await devnetReachable()), 'the devnet nodes are not reachable from this machine (the sheet needs Platform reads)')
  })

  test('r1. says it only unlocks the browser that made it', async ({ browser }) => {
    const page = await (await browser.newContext({ baseURL: LOCALHOST })).newPage()
    await addAuthenticator(page)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await openSheet(page)
    const tile = page.getByTestId('tile-passkey')
    // Shown only when forge-meta has `vaultEntry`: the update is pending on sakura.
    const offered = await tile.waitFor({ state: 'visible', timeout: 60_000 }).then(() => true, () => false)
    test.skip(!offered, 'forge-meta on this devnet has no vaultEntry yet (deploy-v2.mjs --update meta is pending), so the tile is correctly hidden')

    // A passkey with a random 32-byte user handle, as the browser vault's own passkeys have.
    await page.evaluate(async () => {
      await navigator.credentials.create({
        publicKey: {
          rp: { id: 'localhost', name: 'Dash Forge' },
          user: { id: crypto.getRandomValues(new Uint8Array(32)), name: 'browser only', displayName: 'browser only' },
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
          extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
        },
      })
    })
    await tile.click()
    await expect(page.getByRole('alert').filter({ hasText: /only unlocks the browser that made it/i })).toBeVisible({ timeout: 60_000 })
    // Nothing was stored: still signed out.
    await expect(page.getByTestId('funds-pill')).toHaveCount(0)
    await shot(page, 'passkey-vault-02-not-vault')
  })
})

test.describe('live (real spend)', () => {
  test.skip(process.env['E2E_WRITE'] !== '1', 'live writes: set E2E_DEVNET=sakura E2E_WRITE=1 (and deploy vaultEntry to forge-meta first)')
  test.skip(!existsSync(idFile('RELAY')), 'devnet test identities not found (RELAY)')
  test.describe.configure({ mode: 'serial', timeout: 15 * 60_000 })

  async function freshLocalhost(browser: Browser): Promise<Page> {
    return (await browser.newContext({ baseURL: LOCALHOST })).newPage()
  }

  test('w1. add a passkey, forget this browser, sign in with the passkey, renew (re-seal), remove it', async ({ browser }) => {
    const page = await freshLocalhost(browser)
    const authenticator = await addAuthenticator(page)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await importIdentity(page, 'RELAY')

    // The one-time offer, once, with what a passkey is not.
    const offer = page.getByTestId('passkey-offer')
    await expect(offer).toBeVisible({ timeout: 60_000 })
    await expect(offer).toContainText(/doesn't recover an account/i)
    await page.getByTestId('passkey-offer-setup').click()
    await expect(page.getByTestId('passkeys-section')).toBeVisible({ timeout: 60_000 })
    await expect(offer).toHaveCount(0)

    // Add: two prompts (make, then confirm), the encryption key off.
    await page.getByTestId('passkey-add').click()
    await expect(page.getByTestId('passkey-encryption-warning')).toHaveCount(0)
    await page.getByTestId('passkey-add-confirm').click()
    const mine = page.locator('[data-testid="passkey-row"][data-this-device="true"]')
    await expect(mine).toHaveCount(1, { timeout: 180_000 })
    await expect(mine).not.toContainText(/needs update/i)
    expect(await authenticator.credentialCount()).toBe(1)
    await shot(page, 'passkey-vault-03-added')

    // The key this browser signs with, to compare after the passkey brings it back.
    await page.goto('/settings/', { waitUntil: 'domcontentloaded' })
    await unlock(page)
    const keyId = await page.getByTestId('key-id').getAttribute('data-key-id')
    expect(keyId).not.toBeNull()

    // Forget this browser: nothing of the key is left here.
    await page.getByRole('button', { name: /sign out & forget key/i }).click()
    await page.getByTestId('confirm-action').click()
    await expect(page.getByRole('banner').getByRole('button', { name: /^sign in$/i }).first()).toBeVisible({ timeout: 60_000 })

    // Sign in with the passkey alone: one prompt, the same key.
    await openSheet(page)
    await page.getByTestId('tile-passkey').click()
    await expect(page.getByTestId('funds-pill')).toBeVisible({ timeout: 120_000 })
    await page.goto('/settings/', { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('key-id')).toHaveAttribute('data-key-id', keyId!, { timeout: 60_000 })
    await shot(page, 'passkey-vault-04-signed-in-with-passkey')

    // Renew with the identity file: the key changes, and this device's passkey is re-sealed to it.
    await page.getByRole('button', { name: /^renew key$|renew with identity file/i }).first().click()
    await page.setInputFiles('input[type="file"]', idFile('RELAY'))
    await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
    await page.getByLabel('Repeat passphrase').fill(PASSPHRASE)
    await page.getByRole('button', { name: /renew this browser's key/i }).click()
    // The reload above left this tab holding only the signing key: a renewal asks it to unlock
    // first (one passkey gesture, which the virtual authenticator approves), then carries on.
    const unlockFirst = page.getByTestId('renew-unlock')
    if (await unlockFirst.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false)) {
      await unlockFirst.getByRole('button', { name: /unlock with passkey/i }).click()
    }
    await expect(page.getByTestId('key-id')).not.toHaveAttribute('data-key-id', keyId!, { timeout: 180_000 })
    // Client-side, not a reload: the re-seal runs in this tab after the renewal and a reload could cut it off.
    await page.getByTestId('devices-keys-link').click()
    await expect(page.getByTestId('passkeys-section')).toBeVisible({ timeout: 60_000 })
    await expect(mine).toHaveCount(1, { timeout: 60_000 })
    await expect(mine).not.toContainText(/needs update/i, { timeout: 120_000 })
    await shot(page, 'passkey-vault-05-resealed')

    // Remove it: the entry goes from Platform, and the list is empty.
    await mine.getByTestId('passkey-remove').click()
    await page.getByTestId('confirm-action').click()
    // Passkeys an earlier run left behind (rows of "Another device") are not this test's to count.
    await expect(mine).toHaveCount(0, { timeout: 180_000 })
    await shot(page, 'passkey-vault-06-removed')
  })
})
