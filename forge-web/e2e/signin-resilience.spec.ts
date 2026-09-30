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
 * s4. The owner's second report: Import → "Create this browser's key" (private repos on) spun
 *     forever after the group check, with nothing broadcast. Same cause as s1: importIdentity
 *     reads the stored keys (IndexedDB) before its first write. Now a named error, before
 *     anything is written on chain.
 * s5. A pasted private key never reaches the DOM (no `value` attribute, no password field
 *     outside a form, whose Chrome warning prints the element into the console).
 *
 * Runs in Chromium and WebKit (`playwright.config.ts`). Local only: no key is registered.
 */

/** A well-formed identity file whose master key belongs to no identity (nothing can be written). */
function identityFile(): string {
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
  return file
}

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
  // The SDK's JS chunk and its separately fetched wasm (lib/sdk/wasm-fetch.ts).
  const chunk = /\/_next\/static\/(chunks\/evo-sdk\.[^/]*\.js|wasm\/[^/]*\.wasm)$/
  await page.route(chunk, (r) => r.abort())
  await page.goto('/', { waitUntil: 'domcontentloaded' })

  await openSheet(page, 'create')
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('alert')).toContainText('Could not download the Dash Platform library', { timeout: WITHIN })
  // One "Try again" on screen (L-30): the page's own unreachable banner defers to the sheet's.
  await expect(page.getByRole('button', { name: /try again/i })).toHaveCount(1)
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
  await page.setInputFiles('input[type="file"]', identityFile())
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
  // A well-formed ID (32 zero bytes; 44 ones would be 44 bytes, refused before any read).
  await page.getByLabel('Identity ID').fill('11111111111111111111111111111111')
  await page.getByLabel('Private key (WIF or hex)').fill(encodeWif(new Uint8Array(32).fill(9), 'devnet'))
  await dialog.getByRole('button', { name: /sign in for this tab/i }).click()
  await expect(failed).toBeVisible({ timeout: WITHIN })
  await context.close()
})

test('s4. Import with an old tab blocking storage: a named error before any write', async ({ browser, baseURL }) => {
  const context = await browser.newContext()
  const old = await oldBuildTab(context, baseURL!)
  const page = await context.newPage()
  const writes: string[] = []
  page.on('request', (r) => {
    if (/broadcastStateTransition|waitForStateTransitionResult/.test(r.url())) writes.push(r.url())
  })
  await page.goto('/new/', { waitUntil: 'domcontentloaded' })
  await openSheet(page, 'import')
  await page.setInputFiles('input[type="file"]', identityFile())
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
  await page.getByLabel('Repeat passphrase').fill(PASSPHRASE)
  await page.getByTestId('enable-private-repos').check()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: /create this browser's key/i }).click()
  await expect(dialog.getByRole('alert')).toContainText('open in another tab', { timeout: WITHIN })
  await expect(dialog.getByRole('button', { name: /create this browser's key/i })).toBeEnabled()
  expect(writes).toEqual([])
  await shot(page, `signin-s4-import-blocked-${test.info().project.name}`)
  await old.close()
  await context.close()
})

test('s5. a pasted private key never reaches the DOM', async ({ page }) => {
  const secret = encodeWif(new Uint8Array(32).fill(11), 'devnet')
  const logged: string[] = []
  page.on('console', (m) => logged.push(m.text()))
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await openSheet(page, 'advanced')
  await page.getByLabel('Private key (WIF or hex)').fill(secret)
  await page.getByLabel('Identity ID').fill('11111111111111111111111111111111111111111111')
  expect(await page.content()).not.toContain(secret)
  const loose = await page.evaluate(() => [...document.querySelectorAll('input[type=password]')].filter((i) => !i.closest('form')).map((i) => i.id))
  expect(loose).toEqual([])
  expect(logged.filter((t) => t.includes(secret))).toEqual([])

  // A recovery phrase typed into Import: in the field, never in the page's HTML.
  const words = 'abandon ability able about above absent absorb abstract absurd abuse access accident'
  await page.getByRole('button', { name: 'All options' }).click()
  await page.getByTestId('tile-import').click()
  await page.getByRole('tab', { name: 'Recovery phrase' }).click()
  await page.getByLabel('Recovery phrase (12 or 24 words)').fill(words)
  await expect(page.getByLabel('Recovery phrase (12 or 24 words)')).toHaveValue(words)
  expect(await page.content()).not.toContain('abandon ability')
})

test('s8. a remounted passphrase form never keeps a passphrase the screen does not show', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await openSheet(page, 'import')
  const dialog = page.getByRole('dialog')
  await page.setInputFiles('input[type="file"]', identityFile())
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
  await page.getByLabel('Repeat passphrase').fill(PASSPHRASE)
  await expect(dialog.getByRole('button', { name: /create this browser's key/i })).toBeEnabled()
  // Away to the tile list and back: a fresh form, empty, and nothing to submit with.
  await dialog.getByRole('button', { name: 'All options' }).click()
  await page.getByTestId('tile-import').click()
  await page.setInputFiles('input[type="file"]', identityFile())
  await expect(page.getByLabel('Passphrase', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('Repeat passphrase')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: /create this browser's key/i })).toBeDisabled()
})

test('s9. Create: a passphrase typed on Resume does not carry into the new words after Discard', async ({ page, baseURL }) => {
  // A creation in progress on this device, seeded from a blank page of the same origin before
  // the app opens its storage (the app's current schema: version 2, with a journal store).
  const blank = `${baseURL}/__seed__/`
  await page.route(blank, (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>seed</title>' }))
  await page.goto(blank)
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('dash-forge', 2)
        req.onupgradeneeded = () => {
          for (const n of ['spend', 'journal', 'vault', 'inbox']) {
            if (!req.result.objectStoreNames.contains(n)) req.result.createObjectStore(n)
          }
        }
        req.onsuccess = () => {
          const tx = req.result.transaction('journal', 'readwrite')
          tx.objectStore('journal').put(
            { network: 'devnet', depositAddress: 'yNPbcFfabtNmmxKdGwhHomdYfVs6gikbPf', identityId: null, lockTxid: null, lockRaw: null, startedAt: Date.now() },
            'create-identity:devnet',
          )
          tx.oncomplete = () => {
            req.result.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
        req.onerror = () => reject(req.error)
      }),
  )
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await openSheet(page, 'create')
  const dialog = page.getByRole('dialog')
  await expect(page.getByTestId('create-resume')).toBeVisible({ timeout: WITHIN })
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
  await page.getByLabel('Repeat passphrase').fill(PASSPHRASE)
  // Discard: it checks the deposit address first. Empty, it goes ahead; otherwise (or when
  // the check fails) it warns once and needs "Discard anyway".
  await dialog.getByRole('button', { name: /discard this creation/i }).click()
  const words12 = page.getByTestId('mnemonic-words').locator('li')
  const anyway = dialog.getByRole('button', { name: /discard anyway/i })
  await expect(words12.or(anyway).first()).toBeVisible({ timeout: 60_000 })
  if (await anyway.isVisible()) await anyway.click()
  await expect(words12).toHaveCount(12, { timeout: 60_000 })
  const words = await page.getByTestId('mnemonic-words').locator('[data-word]').allInnerTexts()
  await dialog.getByRole('button', { name: /i wrote them down/i }).click()
  for (const input of await dialog.locator('input[id^="quiz-"]').all()) {
    const at = Number((await input.getAttribute('id'))!.slice('quiz-'.length))
    await input.fill(words[at]!)
  }
  await dialog.getByRole('button', { name: /^continue$/i }).click()
  await expect(page.getByLabel('Passphrase', { exact: true })).toHaveValue('')
  await expect(dialog.getByRole('button', { name: /continue to funding/i })).toBeDisabled()
})

test('s6. a newer tab upgrading storage: this tab lets go at once and offers a reload', async ({ browser, baseURL }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  // Open the storage in this tab (Create reads the creation journal).
  await openSheet(page, 'create')
  await expect(page.getByTestId('mnemonic-words').locator('li')).toHaveCount(12, { timeout: 60_000 })

  // A tab running a later build upgrades the database: this one must not block it.
  const url = `${baseURL}/__newer-build-tab__/`
  await context.route(url, (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>newer Dash Forge tab</title>' }))
  const newer = await context.newPage()
  await newer.goto(url)
  const upgraded = await newer.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const req = indexedDB.open('dash-forge', 99)
        req.onblocked = () => resolve('blocked')
        req.onsuccess = () => resolve('upgraded')
        req.onerror = () => resolve(String(req.error))
        setTimeout(() => resolve('no answer'), 10_000)
      }),
  )
  expect(upgraded).toBe('upgraded')
  await expect(page.getByTestId('storage-updated')).toContainText('updated in another tab')
  await shot(page, `signin-s6-reload-banner-${test.info().project.name}`)
  await context.close()
})

test('s7. a slow first download shows how much of the Platform library has arrived', async ({ page, browserName }) => {
  // Network throttling is a Chromium DevTools feature.
  test.skip(browserName !== 'chromium', 'throttling needs Chromium DevTools')
  test.setTimeout(4 * 60_000)
  // Throttled before the page loads: ~4 Mbps, so the ~8 MB library takes ~20 s and its
  // progress is visible. /login opens the sheet by itself (the home page reads repos, which
  // would start the download before the sheet shows it).
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 50, downloadThroughput: 500_000, uploadThroughput: 500_000 })
  await page.goto('/login/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.getByTestId('tile-create').click({ timeout: 60_000 })
  const waiting = page.getByTestId('signin-waiting')
  await expect(waiting).toContainText('Downloading the Dash Platform library')
  const progress = page.getByTestId('signin-download')
  await expect(progress).toContainText(/[\d.]+ of [\d.]+ MB of the library/, { timeout: 30_000 })
  const first = await progress.innerText()
  await expect(progress).not.toHaveText(first, { timeout: 15_000 })
  await shot(page, `signin-s7-downloading-${test.info().project.name}`)
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await expect(page.getByTestId('mnemonic-words').locator('li')).toHaveCount(12, { timeout: 90_000 })
})
