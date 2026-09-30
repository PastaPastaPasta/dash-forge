import { test, expect, devices, type Page } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { E2E_DEVNET, PASSPHRASE, idFile, repoUrl, shot, unlock } from './helpers'

/**
 * Sign in with a mobile Dash wallet, live on a devnet (real spend), with a scripted wallet
 * (e2e/wallet-responder.mjs) that does what Dash Wallet does with the QR the page shows:
 *
 *   E2E_DEVNET=bonsia E2E_WRITE=1 pnpm exec playwright test wallet-login.spec.ts
 *
 * m1. Desktop: on a devnet the wallet tile comes after Create and Import, and the request says
 *     plainly that Dash Wallet answers on testnet only. The sheet shows a dash-key QR (its text is
 *     in the caption) and a countdown, and no deep link. The wallet approves (legacy key-exchange contract); the page shows QR #2
 *     (dash-st); the wallet registers the key; the page shows the identity, the "no spending
 *     limit" warning and asks for a passkey; the user confirms and signs in with a passphrase;
 *     Settings shows the grant prompt for issues and pull requests. On the demo repo, Star (a
 *     forge-collab write) opens the one-tap grant sheet by itself, before anything is signed;
 *     the wallet approves it, and the star lands.
 * m2. Phone viewport: the sheet offers "Open in DashPay (Dash Wallet)" (the dash-key: link)
 *     instead of a QR, with the QR behind a disclosure.
 *
 * RELAY's keys that this run adds are disabled at the end.
 */

test.skip(E2E_DEVNET === '' || process.env['E2E_WRITE'] !== '1', 'live devnet writes: set E2E_DEVNET=bonsia E2E_WRITE=1')
test.skip(!existsSync(idFile('RELAY')), 'devnet test identities not found')
test.describe.configure({ mode: 'serial', timeout: 15 * 60_000 })

const ROOT = resolve(__dirname, '../..')
const CHAIN_KEY = randomBytes(32).toString('hex')
type Responder = typeof import('./wallet-responder.mjs')
const responder = (): Promise<Responder> => import(pathToFileURL(join(__dirname, 'wallet-responder.mjs')).href)
const DEPLOYMENT = (): Promise<{ default: { v2: { forgeCore: { contractId: string }; forgeCollab: { contractId: string } } } }> =>
  import(pathToFileURL(join(ROOT, `forge-contracts/deployments/devnet-${E2E_DEVNET}.json`)).href, { with: { type: 'json' } })

/** The URI a QR on the page encodes (the Qr component prints it as its caption). */
async function shownUri(page: Page, scheme: 'dash-key' | 'dash-st'): Promise<string> {
  const caption = page.locator('figcaption', { hasText: `${scheme}:` }).first()
  await expect(caption).toBeVisible({ timeout: 60_000 })
  return (await caption.textContent())!.trim()
}

/** Scan the page's QR with the scripted wallet: approve, and register when asked. */
async function walletAnswers(page: Page, contractId: string, label: string): Promise<void> {
  const wallet = await responder()
  const uri = await shownUri(page, 'dash-key')
  expect(uri).toMatch(/^dash-key:[1-9A-HJ-NP-Za-km-z]+\?n=d&v=1$/)
  const approved = await wallet.approve({ uri, identityFile: idFile('RELAY'), chainKeyHex: CHAIN_KEY, devnet: E2E_DEVNET })
  expect(approved.contractId).toBe(contractId)
  if (!approved.registered) {
    const st = await shownUri(page, 'dash-st')
    await shot(page, `wallet-${label}-02-register`)
    await wallet.register({ uri: st, identityFile: idFile('RELAY'), chainKeyHex: CHAIN_KEY, contractId, devnet: E2E_DEVNET })
  }
}

test('m1. desktop: scan, register, confirm, sign in; then the one-tap grant for issues and PRs', async ({ browser }) => {
  const dep = (await DEPLOYMENT()).default.v2
  const relay = (JSON.parse((await import('node:fs')).readFileSync(idFile('RELAY'), 'utf8')) as { identityId: string }).identityId
  const page = await (await browser.newContext()).newPage()
  try {
    await page.goto('/settings/', { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /^sign in$/i }).first().click()
    const wallet = page.getByTestId('tile-wallet')
    await expect(wallet).toBeVisible({ timeout: 60_000 })
    // Not the first option on a devnet: no released wallet answers here.
    const order = await page.locator('[data-testid^="tile-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
    expect(order.slice(0, 3)).toEqual(['tile-create', 'tile-import', 'tile-wallet'])
    await expect(wallet).toContainText(/testnet/i)
    await wallet.click()
    await expect(page.getByTestId('request-countdown')).toContainText('Expires in')
    await expect(page.getByTestId('wallet-support')).toContainText(/arrives when Forge is on testnet/i)
    await expect(page.getByTestId('wallet-deep-link')).toHaveCount(0)
    await expect(page.getByText(/pairing|shows code/i)).toHaveCount(0)
    await shot(page, 'wallet-login-01-request')

    await walletAnswers(page, dep.forgeCore.contractId, 'login')

    await expect(page.getByTestId('granted-identity')).toHaveText(relay, { timeout: 120_000 })
    await expect(page.getByTestId('unlimited-key-warning')).toBeVisible()
    await shot(page, 'wallet-login-03-confirm')
    await page.getByLabel(/this is my identity/i).check()
    await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
    await page.getByLabel('Repeat passphrase').fill(PASSPHRASE)
    await page.getByRole('button', { name: /finish signing in/i }).click()
    await expect(page.getByTestId('funds-pill')).toBeVisible({ timeout: 60_000 })

    // Settings: the key has no limits, and issues/PRs need one more approval.
    await expect(page.getByTestId('grant-collab')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('keys-panel').getByTestId('unlimited-key-warning')).toBeVisible()
    await shot(page, 'wallet-login-04-settings')

    // A forge-collab write opens the grant sheet by itself (nothing is signed first).
    await page.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
    await unlock(page)
    const star = page.getByRole('button', { name: /^star/i })
    await expect(star).toBeEnabled({ timeout: 60_000 })
    await star.click()
    await expect(page.getByRole('dialog', { name: /approve issues and pull requests/i })).toBeVisible({ timeout: 30_000 })
    await shot(page, 'wallet-login-05-grant-sheet')
    await walletAnswers(page, dep.forgeCollab.contractId, 'grant')
    await expect(page.getByRole('dialog', { name: /approve issues and pull requests/i })).toBeHidden({ timeout: 120_000 })

    // Now the star is signed by the forge-collab grant and lands.
    await page.getByRole('button', { name: /^star/i }).click()
    await expect(page.getByRole('button', { name: /starred/i })).toBeVisible({ timeout: 90_000 })
    await page.getByRole('button', { name: /starred/i }).click()
    await expect(page.getByRole('button', { name: /^star/i })).toBeVisible({ timeout: 90_000 })
    await shot(page, 'wallet-login-06-starred')
  } finally {
    const wallet = await responder()
    await wallet.disableDerived({ identityFile: idFile('RELAY'), chainKeyHex: CHAIN_KEY, contractIds: [dep.forgeCore.contractId, dep.forgeCollab.contractId], devnet: E2E_DEVNET })
  }
})

test('m2. phone: "Open in DashPay (Dash Wallet)" instead of a QR', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['Pixel 7'] })
  const page = await context.newPage()
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /^sign in$/i }).first().click()
  await page.getByTestId('tile-wallet').click({ timeout: 60_000 })
  const link = page.getByTestId('wallet-deep-link')
  await expect(link).toBeVisible({ timeout: 60_000 })
  expect(await link.getAttribute('href')).toMatch(/^dash-key:[1-9A-HJ-NP-Za-km-z]+\?n=d&v=1$/)
  await expect(link).toHaveText(/open in dashpay \(dash wallet\)/i)
  await expect(page.getByRole('img', { name: /wallet login request/i })).toHaveCount(0)
  await expect(page.getByText(/wallet on another device/i)).toBeVisible()
  await shot(page, 'wallet-login-07-phone')
})
