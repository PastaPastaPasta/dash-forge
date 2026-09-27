import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { encodeWif } from '../lib/auth/wif'
import { PASSPHRASE, shot } from './helpers'

/**
 * No spinner in the sign-in sheet waits forever (owner report: "Sign in → Create" showed a
 * bare spinner under "Forge signs with a limited key…" and never moved).
 *
 * s1. The reproduced cause: a tab still running a build from before the IndexedDB v2 upgrade
 *     (660d5a1) holds the "dash-forge" database open at version 1. The upgrade is blocked; the
 *     old code dropped the blocked open, and the next `indexedDB.open` queued behind it and
 *     never fired any event, so Create's first step (read the creation journal) hung. Now:
 *     a named error at once, and "Try again" works once the old tab is gone.
 * s2. The evo-sdk chunk cannot download: Create and Wallet end in a named error with "Try
 *     again", and "Try again" recovers once the chunk loads.
 * s3. Platform never answers (DAPI and the quorum endpoint hang): every sub-view reaches its
 *     content or a named error within the connect timeout.
 *
 * Runs in Chromium and WebKit (`playwright.config.ts`). Local only: no key is registered.
 */

/** The connect deadline (lib/auth/connect.ts CONNECT_MS) plus slack for a CI runner. */
const WITHIN = 30_000

async function openSheet(page: Page, tile: 'create' | 'import' | 'wallet' | 'advanced'): Promise<void> {
  await page.getByRole('button', { name: /^sign in$/i }).first().click({ timeout: 60_000 })
  if (tile === 'advanced') {
    await page.getByRole('button', { name: 'Advanced' }).click()
  }
  await page.getByTestId(`tile-${tile}`).click({ timeout: 60_000 })
}

/** Close the sheet (Escape) and wait for it to go. */
async function closeSheet(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

/** Another same-origin tab holding the pre-660d5a1 schema open (v1, no onversionchange). */
async function oldBuildTab(context: BrowserContext, baseURL: string): Promise<Page> {
  const url = `${baseURL}/__old-build-tab__/`
  await context.route(url, (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>old Dash Forge tab</title>' }))
  const old = await context.newPage()
  await old.goto(url)
  const state = await old.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const req = indexedDB.open('dash-forge', 1)
        req.onupgradeneeded = () => {
          for (const n of ['spend', 'journal', 'vault']) req.result.createObjectStore(n)
        }
        req.onsuccess = () => {
          ;(window as unknown as { held: IDBDatabase }).held = req.result
          resolve('open')
        }
        req.onerror = () => resolve(String(req.error))
      }),
  )
  expect(state).toBe('open')
  return old
}

test('s1. an old tab blocking the storage upgrade: Create names it, then recovers', async ({ browser, baseURL }) => {
  const context = await browser.newContext()
  const old = await oldBuildTab(context, baseURL!)
  const page = await context.newPage()
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await openSheet(page, 'create')

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('alert')).toContainText('open in another tab', { timeout: WITHIN })
  await expect(dialog.getByRole('button', { name: /try again/i })).toBeVisible()
  await shot(page, `signin-s1-blocked-${test.info().project.name}`)

  // The other tab goes away: the blocked upgrade completes and "Try again" gets the words.
  await old.close()
  await dialog.getByRole('button', { name: /try again/i }).click()
  await expect(page.getByTestId('mnemonic-words').locator('li')).toHaveCount(12, { timeout: WITHIN })
  await context.close()
})

test('s2. the Platform library cannot download: a named error and a working "Try again"', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const chunk = /\/_next\/static\/chunks\/evo-sdk\.[^/]*\.js/
  await page.route(chunk, (r) => r.abort())
  await page.goto('/', { waitUntil: 'domcontentloaded' })

  await openSheet(page, 'create')
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('alert')).toContainText('Could not download the Dash Platform library', { timeout: WITHIN })
  await shot(page, `signin-s2-create-${test.info().project.name}`)

  // The wallet tile still shows (its availability could not be checked) and names the failure.
  await dialog.getByRole('button', { name: 'All options' }).click()
  await dialog.getByTestId('tile-wallet').click({ timeout: WITHIN })
  await expect(dialog.getByRole('alert')).toContainText('Could not download the Dash Platform library', { timeout: WITHIN })
  await expect(dialog.getByRole('button', { name: /try again/i })).toBeVisible()

  // The network comes back: "Try again" loads the library, and the wallet request proceeds
  // past it (to the QR, or to the next named step).
  await page.unroute(chunk)
  await dialog.getByRole('button', { name: /try again/i }).click()
  await expect(dialog.getByRole('alert').filter({ hasText: 'Could not download the Dash Platform library' })).toHaveCount(0, { timeout: 60_000 })
  // And Create, opened again, shows the words.
  await dialog.getByRole('button', { name: 'All options' }).click()
  await dialog.getByTestId('tile-create').click()
  await expect(page.getByTestId('mnemonic-words').locator('li')).toHaveCount(12, { timeout: 60_000 })
  await context.close()
})

test('s3. Platform never answers: every sub-view reaches content or a named error in time', async ({ browser, baseURL }) => {
  test.setTimeout(5 * 60_000)
  const context = await browser.newContext()
  // Every network request off this origin hangs: the DAPI nodes and the quorum endpoint. (Not
  // `blob:` URLs: WebKit loads the SDK's WASM through one.)
  await context.route((url) => /^https?:$/.test(url.protocol) && !url.href.startsWith(baseURL!), () => new Promise(() => {}))
  const page = await context.newPage()
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const dialog = page.getByRole('dialog')
  const failed = dialog.getByRole('alert').filter({ hasText: 'Could not connect to Dash Platform' })

  // Create: the words need only the library, not the network.
  await openSheet(page, 'create')
  await expect(page.getByTestId('mnemonic-words').locator('li')).toHaveCount(12, { timeout: 60_000 })
  await closeSheet(page)

  // Import: the form shows at once; submitting names the connect failure.
  await openSheet(page, 'import')
  const dir = join(tmpdir(), `forge-signin-resilience-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'unreachable.identity.json')
  writeFileSync(
    file,
    JSON.stringify({
      identityId: '11111111111111111111111111111111111111111111',
      identityKeys: [{ id: 0, purpose: 'AUTHENTICATION', securityLevel: 'MASTER', keyType: 'ECDSA_SECP256K1', privateKeyWif: encodeWif(new Uint8Array(32).fill(7), 'devnet') }],
    }),
  )
  await page.setInputFiles('input[type="file"]', file)
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
  await page.getByLabel('Repeat passphrase').fill(PASSPHRASE)
  await dialog.getByRole('button', { name: /create this browser's key/i }).click()
  await expect(failed).toBeVisible({ timeout: WITHIN })
  // "Try again" is the same button, enabled again.
  await expect(dialog.getByRole('button', { name: /create this browser's key/i })).toBeEnabled()
  await shot(page, `signin-s3-import-${test.info().project.name}`)
  await closeSheet(page)

  // Wallet: the request cannot be made without Platform; a named error and "Try again".
  await openSheet(page, 'wallet')
  await expect(dialog.getByTestId('signin-waiting')).toContainText('Connecting to Dash Platform')
  await expect(failed).toBeVisible({ timeout: WITHIN })
  await expect(dialog.getByRole('button', { name: /try again/i })).toBeVisible()
  await shot(page, `signin-s3-wallet-${test.info().project.name}`)
  await closeSheet(page)

  // Advanced: a pasted key is checked on Platform; the check fails in time, with a reason.
  await openSheet(page, 'advanced')
  await page.getByLabel('Identity ID').fill('11111111111111111111111111111111111111111111')
  await page.getByLabel('Private key (WIF or hex)').fill(encodeWif(new Uint8Array(32).fill(9), 'devnet'))
  await dialog.getByRole('button', { name: /sign in for this tab/i }).click()
  await expect(failed).toBeVisible({ timeout: WITHIN })
  await context.close()
})
