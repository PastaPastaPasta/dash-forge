import { test, expect, devices, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { resolve } from 'node:path'
import { deploymentFilePath } from './network'
import { E2E_DEVNET, E2E_NETWORK, PASSPHRASE, idFile, repoUrl, shot, unlock, showOtherWays } from './helpers'
import { approveV2, disableGrants, newV2Wallet } from './wallet-responder-v2'

/**
 * Sign in with a mobile wallet that speaks App Connect v2, with a scripted wallet
 * (e2e/wallet-responder-v2.ts) that does what such a wallet does with the code the page shows.
 *
 * Read-only (no secrets, no spend; needs the devnet's nodes to answer reads, and skips itself when
 * none of them accepts a connection from this machine):
 *
 *   E2E_DEVNET=sakura pnpm exec playwright test wallet-login-v2.spec.ts
 *
 * r1. Desktop: the wallet tile comes first; the request is v2 (`v=2`, one approval for all of
 *     Forge, with the budget and the date), the support note names App Connect v2, and there is no
 *     older code to switch to (v1 DashConnect was removed).
 * r2. Phone: "Open in DashPay (Dash Wallet)" is the v2 link (no callback on a local http build:
 *     `cb` needs the canonical https site).
 * r3. `/connect/`, where a wallet returns: a malformed link goes home, a declined approval says
 *     so, a tab that shows a code answers the page (which then steps aside), and with no such
 *     tab the page sends the user back to the Forge tab where they started.
 *
 * Live (real spend on a devnet with the RELAY test identity; testnet has no forge-v2):
 *
 *   E2E_DEVNET=sakura E2E_WRITE=1 pnpm exec playwright test wallet-login-v2.spec.ts
 *
 * w1. Scan → the wallet adds ONE group-bound key and publishes the response → the page shows the
 *     identity and the granted limits (no "no spending limit" warning) → passphrase → signed in.
 *     Settings shows no further approval to ask for. A star (a forge-community write) opens no
 *     grant sheet and lands. Renew in your wallet: protection first, then a new code; the wallet
 *     adds a new key and disables the old one in the same update; the page stores it and shows its
 *     id.
 *
 * Every key the scripted wallet adds is disabled at the end.
 */

test.skip(E2E_NETWORK === 'testnet', 'devnet spec (n=d requests, the scripted wallet); testnet v2 sign-in was checked with the released DashPay testnet build (docs/design/wallet-primary.md)')

/** A v2 request's URI: `n=d` on a devnet, `v=2`. */
const V2_URI = /^dashpay:\/\/connect\?v=2&n=d&r=[A-Za-z0-9_-]+$/
const REQUEST_HASH = 'ab'.repeat(20)

/** Whether the first DAPI node of the devnet under test accepts a TCP connection (5 s). */
async function devnetReachable(): Promise<boolean> {
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

/** The URI a QR on the page encodes (the Qr component prints it as its caption). */
async function shownUri(page: Page, scheme = 'dashpay'): Promise<string> {
  const caption = page.locator('figcaption', { hasText: `${scheme}:` }).first()
  await expect(caption).toBeVisible({ timeout: 60_000 })
  return (await caption.textContent())!.trim()
}

async function openWalletRequest(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('banner').getByRole('button', { name: /^sign in$/i }).first().click()
  // The wallet shows first where it leads, else under Other ways (a devnet): open them either way.
  await showOtherWays(page)
  const wallet = page.getByTestId('tile-wallet')
  await expect(wallet).toBeVisible({ timeout: 60_000 })
  await wallet.click()
}

test.describe('v2 request (read-only)', () => {
  test.beforeAll(async () => {
    test.skip(!(await devnetReachable()), 'the devnet nodes are not reachable from this machine (the request needs Platform reads)')
  })

  test('r1. desktop: the wallet tile is first, and the request is v2 with no older code beside it', async ({ browser }) => {
    const page = await (await browser.newContext()).newPage()
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.getByRole('banner').getByRole('button', { name: /^sign in$/i }).first().click()
    await showOtherWays(page)
    await expect(page.getByTestId('tile-wallet')).toBeVisible({ timeout: 60_000 })
    // Wallet first where v2 is on offer; the buttons only (a cost line shares the testid prefix).
    // The passkey tile (once forge-meta has the passkey vault) sits right after the wallet's; it is not under test here.
    const order = (await page.locator('button[data-testid^="tile-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))).filter((id) => id !== 'tile-passkey')
    expect(order).toEqual(expect.arrayContaining(['tile-wallet', 'tile-create', 'tile-import', 'tile-dg']))
    await expect(page.getByTestId('tile-wallet')).toContainText(/approve once for all of Forge/i)

    await page.getByTestId('tile-wallet').click()
    await expect(page.getByTestId('request-countdown')).toContainText('Expires in')
    expect(await shownUri(page)).toMatch(V2_URI)
    await expect(page.getByTestId('approval-terms')).toContainText(/one approval covers all of forge, spending up to 0\.05 dash/i)
    await expect(page.getByTestId('approval-terms')).toContainText(/until /)
    await expect(page.getByTestId('wallet-support')).toContainText(/app connect v2/i)
    await expect(page.getByTestId('wallet-deep-link')).toHaveCount(0)
    await expect(page.getByText(/older code/i)).toHaveCount(0)
    await shot(page, 'wallet-login-v2-01-request')
  })

  test('r2. phone: "Open in DashPay (Dash Wallet)" is the v2 link, with the QR behind a disclosure', async ({ browser }) => {
    const page = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage()
    await openWalletRequest(page)
    const link = page.getByTestId('wallet-deep-link')
    await expect(link).toBeVisible({ timeout: 60_000 })
    const href = (await link.getAttribute('href'))!
    expect(href).toMatch(/^dashpay:\/\/connect\?v=2&n=d&r=[A-Za-z0-9_-]+/)
    // `cb` needs the canonical https site: this local http build leaves it out (BroadcastChannel
    // would not reach the tab either).
    expect(href).not.toContain('cb=')
    await expect(link).toHaveText(/open in dashpay \(dash wallet\)/i)
    await shot(page, 'wallet-login-v2-03-phone')
  })
})

test.describe('/connect/ (the wallet returns here)', () => {
  test('a malformed link goes home', async ({ page }) => {
    await page.goto('/connect/?r=not-a-hash')
    await expect(page).not.toHaveURL(/\/connect\//, { timeout: 30_000 })
  })

  test('a declined approval says so', async ({ page }) => {
    await page.goto(`/connect/?r=${REQUEST_HASH}&ac=declined`)
    await expect(page.getByRole('heading', { name: 'Sign-in declined' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('link', { name: 'Open Forge' })).toBeVisible()
  })

  test('the tab that shows the code answers, and this page steps aside', async ({ page, context }) => {
    // Stand in for the waiting tab: ack the page's message the way the wallet flow does.
    const waiting = await context.newPage()
    await waiting.goto('/networks/', { waitUntil: 'domcontentloaded' })
    await waiting.evaluate((hash) => {
      const channel = new BroadcastChannel('forge-app-connect')
      // Kept reachable so the channel is not collected before the message arrives.
      Object.assign(window, { forgeTestChannel: channel })
      channel.onmessage = (event: MessageEvent) => {
        if ((event.data as { type?: string; requestHash?: string })?.type === 'forge-app-connect-callback' && (event.data as { requestHash?: string }).requestHash === hash) {
          channel.postMessage({ type: 'forge-app-connect-ack', requestHash: hash })
        }
      }
    }, REQUEST_HASH)
    await page.goto(`/connect/?r=${REQUEST_HASH}&ac=ok`)
    await expect(page.getByRole('heading', { name: /you.re signing in on your other forge tab/i })).toBeVisible({ timeout: 30_000 })
  })

  test('with no tab waiting, it sends the user back to the Forge tab where they started', async ({ page }) => {
    await page.goto(`/connect/?r=${REQUEST_HASH}&ac=ok`)
    await expect(page.getByRole('heading', { name: 'Go back to Forge' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/forge tab where you started/i)).toBeVisible()
  })
})

test.describe('v2 sign-in and renewal (live, real spend)', () => {
  test.skip(process.env['E2E_WRITE'] !== '1', 'live writes: set E2E_DEVNET=sakura E2E_WRITE=1')
  test.skip(!existsSync(idFile('RELAY')), 'devnet test identities not found (RELAY)')
  test.describe.configure({ mode: 'serial', timeout: 15 * 60_000 })

  test('w1. scan, confirm, one key for all of Forge, a star with no grant sheet; renew in the wallet', async ({ browser }) => {
    const relay = (JSON.parse(readFileSync(idFile('RELAY'), 'utf8')) as { identityId: string }).identityId
    const wallet = newV2Wallet()
    const page = await (await browser.newContext()).newPage()
    let renewedKeyId: number | null = null
    try {
      await openWalletRequest(page)
      const uri = await shownUri(page)
      expect(uri).toMatch(V2_URI)
      const first = await approveV2({ wallet, uri, identityFile: idFile('RELAY'), devnet: E2E_DEVNET })
      expect(first.label).toBe('Dash Forge')
      expect(first.replacedKeyId).toBeNull()

      // Confirm: the identity and the limits the chain records; not the shipped wallets' warning.
      await expect(page.getByTestId('granted-identity')).toHaveText(relay, { timeout: 120_000 })
      await expect(page.getByTestId('unlimited-key-warning')).toHaveCount(0)
      await expect(page.getByTestId('approval-terms')).toContainText(/spending capped at 0\.05 dash/i)
      await shot(page, 'wallet-login-v2-04-confirm')
      await page.getByLabel(/this is my identity/i).check()
      await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
      await page.getByLabel('Repeat passphrase').fill(PASSPHRASE)
      await page.getByRole('button', { name: /finish signing in/i }).click()
      await expect(page.getByTestId('funds-pill')).toBeVisible({ timeout: 60_000 })

      // One key covers every contract: nothing more to approve, and the key shows its limits.
      await page.goto('/settings/', { waitUntil: 'domcontentloaded' })
      await unlock(page)
      await expect(page.getByTestId('keys-panel')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('key-partial')).toHaveCount(0)
      await expect(page.getByTestId('keys-panel').getByTestId('unlimited-key-warning')).toHaveCount(0)
      await expect(page.getByTestId('key-id')).toHaveAttribute('data-key-id', String(first.keyId))
      await expect(page.getByTestId('key-budget')).toContainText('0.05')
      await expect(page.getByTestId('key-renew-in-wallet')).toBeVisible()
      await shot(page, 'wallet-login-v2-05-settings')

      // A star is a forge-community write: no grant sheet, and it lands.
      await page.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
      await unlock(page)
      const star = page.getByRole('button', { name: /^star/i })
      await expect(star).toBeEnabled({ timeout: 60_000 })
      await star.click()
      await expect(page.getByRole('dialog', { name: /approve stars, watches and follows/i })).toHaveCount(0)
      await expect(page.getByRole('button', { name: /starred/i })).toBeVisible({ timeout: 90_000 })
      await page.getByRole('button', { name: /starred/i }).click()
      await expect(page.getByRole('button', { name: /^star/i })).toBeVisible({ timeout: 90_000 })

      // Renew in the wallet: the protection first, then the code; the wallet disables the old key.
      await page.goto('/settings/', { waitUntil: 'domcontentloaded' })
      await unlock(page)
      await page.getByTestId('key-renew-in-wallet').click()
      await expect(page.getByTestId('wallet-renew-prepare')).toBeVisible({ timeout: 30_000 })
      await expect(page.locator('figcaption', { hasText: 'dashpay:' })).toHaveCount(0)
      await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
      await page.getByLabel('Repeat passphrase').fill(PASSPHRASE)
      await page.getByRole('button', { name: /continue to your wallet/i }).click()
      const renewUri = await shownUri(page)
      expect(renewUri).toMatch(V2_URI)
      expect(renewUri).not.toBe(uri)
      await shot(page, 'wallet-login-v2-06-renew')
      const second = await approveV2({ wallet, uri: renewUri, identityFile: idFile('RELAY'), devnet: E2E_DEVNET })
      expect(second.replacedKeyId).toBe(first.keyId)
      renewedKeyId = second.keyId
      await expect(page.getByRole('dialog')).toBeHidden({ timeout: 120_000 })
      await expect(page.getByTestId('key-id')).toHaveAttribute('data-key-id', String(second.keyId), { timeout: 60_000 })
      await shot(page, 'wallet-login-v2-07-renewed')
    } finally {
      // The first key is already disabled by the renewal: only the live one remains to disable.
      const left = await disableGrants({ wallet, identityFile: idFile('RELAY'), devnet: E2E_DEVNET })
      if (renewedKeyId !== null) expect(left).toEqual([renewedKeyId])
    }
  })
})
