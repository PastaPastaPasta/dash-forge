import { test, expect, type Page, type Route } from '@playwright/test'
import { existsSync, mkdirSync, rmdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { E2E_DEVNET, PASSPHRASE, nodeSdk, shot, unlock } from './helpers'

/**
 * L-06, live on a devnet (real spend: two 0.03 DASH deposits from the devnet funding key):
 *
 *   E2E_DEVNET=moutai E2E_WRITE=1 FORGE_DEVNET_FUNDING_KEY_FILE=… pnpm exec playwright test create-identity-recovery.spec.ts
 *
 * An IdentityCreate whose answer cannot be verified must not end in "Failed to create identity"
 * when Platform recorded it, and must not make the user pay again when it did not.
 *
 * cr-1. The identity lands, but its proof cannot be checked: every quorum list fetched while the
 *       sheet says "Registering…" and before the broadcast (the connection renewed right before
 *       the create) comes back emptied, as after a rotation the prefetch did not see. So
 *       wasm-sdk's `identityCreate` fails with "Quorum not found in cache" after the broadcast,
 *       exactly as in L-06. The flow reads the identity, finds it, and finishes.
 * cr-2. The broadcast never reaches Platform (every node answers DEADLINE_EXCEEDED). The flow
 *       finds no identity and an unused asset lock, and offers "Try again with the same
 *       deposit"; with the network back, that creates the identity from the same lock, with no
 *       second deposit.
 *
 * Run it on a port nothing else serves (E2E_PORT): with `reuseExistingServer` another build
 * already listening there would be tested instead.
 */

test.skip(process.env['E2E_WRITE'] !== '1', 'live devnet writes: set E2E_WRITE=1')
test.describe.configure({ mode: 'serial', timeout: 30 * 60_000 })

const ROOT = resolve(__dirname, '../..')
const QUORUMS = /^https:\/\/quorums\.[a-z0-9-]+\.networks\.dash\.org\//
const BROADCAST = /\/org\.dash\.platform\.dapi\.v0\.Platform\/broadcastStateTransition$/
const REGISTERING = 'Registering your identity…'
const CHECKING = 'Checking whether Platform recorded your identity…'

function fundingKeyFile(): string {
  const keyFile = process.env['FORGE_DEVNET_FUNDING_KEY_FILE'] ?? ''
  test.skip(keyFile === '' || !existsSync(keyFile), 'set FORGE_DEVNET_FUNDING_KEY_FILE to the devnet funding key (YAML or WIF)')
  return keyFile
}

/** Walk the create sheet to its deposit address. */
async function openDeposit(page: Page): Promise<string> {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /^sign in$/i }).first().click()
  await page.getByTestId('tile-create').click()
  const words = page.getByTestId('mnemonic-words')
  await expect(words).toBeVisible({ timeout: 60_000 })
  const list = await words.locator('[data-word]').allInnerTexts()
  await page.getByRole('button', { name: /i wrote them down/i }).click()
  for (const input of await page.getByLabel(/^Word \d+$/).all()) {
    const n = Number((await input.getAttribute('id'))?.replace('quiz-', ''))
    await input.fill(list[n] ?? '')
  }
  await page.getByRole('button', { name: /^continue$/i }).click()
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
  await page.getByLabel('Repeat passphrase').fill(PASSPHRASE)
  await page.getByRole('button', { name: /continue to funding/i }).click()
  const address = (await page.getByTestId('deposit-address').textContent({ timeout: 60_000 }))?.trim() ?? ''
  expect(address).toMatch(/^y[1-9A-HJ-NP-Za-km-z]{33}$/)
  return address
}

function tryMkdir(path: string): boolean {
  try {
    mkdirSync(path)
    return true
  } catch {
    return false
  }
}

/** Send 0.03 DASH to `address` from the devnet funding key. */
async function fund(address: string): Promise<string> {
  const keyFile = fundingKeyFile()
  const funding = await import(pathToFileURL(join(ROOT, 'tools/mint-identity/src/funding.mjs')).href)
  const config = await import(pathToFileURL(join(ROOT, 'tools/mint-identity/src/config.mjs')).href)
  const ledgers = await import(pathToFileURL(join(ROOT, 'tools/mint-identity/src/utxo-ledger.mjs')).href)
  const network = config.devnetConfig(E2E_DEVNET)
  const key = funding.loadFundingKey(network, { keyFile })
  const ledgerPath = ledgers.defaultLedgerPath({ keyFile, address: key.address })
  // Other runs may spend from the same key: E2E_FUND_LOCK names a lock directory to hold while funding.
  const lock = process.env['E2E_FUND_LOCK']
  if (lock) {
    while (!tryMkdir(lock)) await new Promise((r) => setTimeout(r, 5_000))
  }
  let txid: string
  try {
    ;({ txid } = await funding.fundFromKey(key, [{ address, duffs: 3_000_000 }], network, () => undefined, { ledgerPath }))
  } finally {
    if (lock) rmdirSync(lock)
  }
  test.info().annotations.push({ type: 'funding', description: `${txid} → ${address} (0.03 DASH)` })
  return txid
}

/**
 * Record every stage line and error the sheet shows, from the page itself (a MutationObserver),
 * so a stage shown for a moment is not missed. Read them with {@link seenInPage}.
 */
async function recordStages(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __stages: string[]; __errors: string[] }
    w.__stages = []
    w.__errors = []
    const note = (list: string[], text: string | null | undefined): void => {
      if (text && list.at(-1) !== text) list.push(text)
    }
    new MutationObserver(() => {
      note(w.__stages, document.querySelector('[data-testid="create-stage"]')?.textContent)
      note(w.__errors, document.querySelector('[data-testid="signin-failed"]')?.textContent)
    }).observe(document, { subtree: true, childList: true, characterData: true })
  })
}

function seenInPage(page: Page): Promise<{ stages: string[]; errors: string[] }> {
  return page.evaluate(() => {
    const w = window as unknown as { __stages: string[]; __errors: string[] }
    return { stages: w.__stages, errors: w.__errors }
  })
}

/** What the sheet's stage line says now. */
function stageNow(page: Page): Promise<string | null> {
  return page.evaluate(() => document.querySelector('[data-testid="create-stage"]')?.textContent ?? null).catch(() => null)
}

/** The identity as Platform shows it, read from Node (retried: a shared devnet node may refuse once). */
async function identityOnChain(identityId: string): Promise<{ keyIds: number[] } | null> {
  let last: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const sdk = await nodeSdk()
      const identity = await sdk.identities.fetch(identityId)
      return identity ? { keyIds: (identity.publicKeys as { keyId: number }[]).map((k) => k.keyId) } : null
    } catch (e) {
      last = e
      await new Promise((r) => setTimeout(r, 5_000))
    }
  }
  throw new Error(`reading ${identityId} from Node failed: ${String((last as { message?: unknown })?.message ?? last)}`)
}

async function createdIdentity(page: Page): Promise<string> {
  await expect(page.getByTestId('funds-pill')).toBeVisible({ timeout: 25 * 60_000 })
  await page.goto('/settings/', { waitUntil: 'domcontentloaded' })
  // A full load locks the vault (L-04): unlock with the passphrase, as a returning user does.
  if (!(await page.getByTestId('funds-pill').isVisible())) await unlock(page)
  const id = await page.getByTestId('settings-identity').getAttribute('data-identity', { timeout: 60_000 })
  expect(id).toBeTruthy()
  return id as string
}

test('cr-1. the create lands but its proof names a quorum the SDK lacks: the flow finishes (L-06)', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  await recordStages(page)
  // Decided per request, from the page: a quorum list fetched while the sheet says
  // "Registering…" and before the broadcast (the renewal right before the create) comes back
  // with every key removed. Lists fetched after the broadcast (the probe's reconnect) are real.
  const quorum = { emptied: 0, broadcasts: 0 }
  await context.route(QUORUMS, async (route: Route) => {
    if (quorum.broadcasts > 0 || (await stageNow(page)) !== REGISTERING) return route.continue()
    quorum.emptied++
    const response = await route.fetch()
    const json = (await response.json()) as { data: unknown }
    const data = Array.isArray(json.data) ? [] : { ...(json.data as object), quorums: [] }
    return route.fulfill({ response, json: { ...json, data } })
  })
  await context.route(BROADCAST, (route: Route) => {
    quorum.broadcasts++
    return route.continue()
  })
  const address = await openDeposit(page)
  await shot(page, 'cr-1-01-deposit')
  // A real user takes a while to fund; an InstantSend lock can finish the create in seconds.
  // Let the connection outlive the freshness window (FRESH_WRITE_MS, 30 s) so the create renews
  // it, and that renewal is what gets the emptied lists.
  await page.waitForTimeout(35_000)
  await fund(address)
  await expect(page.getByTestId('funds-pill')).toBeVisible({ timeout: 25 * 60_000 })
  // The create's answer could not be verified, and the flow checked instead of failing.
  const seen = await seenInPage(page)
  await shot(page, 'cr-1-02-signed-in')
  expect(quorum.emptied).toBeGreaterThanOrEqual(2)
  expect(quorum.broadcasts).toBeGreaterThanOrEqual(1)
  expect(seen.stages).toContain(REGISTERING)
  expect(seen.stages).toContain(CHECKING)
  expect(seen.errors).toEqual([])
  const identityId = await createdIdentity(page)
  await shot(page, 'cr-1-03-settings')
  const onChain = await identityOnChain(identityId)
  expect(onChain?.keyIds).toContain(5)
  test.info().annotations.push({ type: 'identity', description: identityId })
})

test('cr-2. the broadcast never lands: "Try again with the same deposit" creates it with no second payment', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  await recordStages(page)
  const net = { blocked: true, refused: 0, sent: 0 }
  await context.route(BROADCAST, (route: Route) => {
    if (!net.blocked) {
      net.sent++
      return route.continue()
    }
    net.refused++
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/grpc-web+proto', 'grpc-status': '4', 'grpc-message': 'deadline exceeded' },
      body: '',
    })
  })
  const address = await openDeposit(page)
  await fund(address)

  const retry = page.getByRole('button', { name: 'Try again with the same deposit' })
  await expect(retry).toBeVisible({ timeout: 25 * 60_000 })
  await expect(page.getByTestId('signin-failed')).toContainText('shows no record of identity')
  expect((await seenInPage(page)).stages).toContain(CHECKING)
  expect(net.refused).toBeGreaterThanOrEqual(1)
  await shot(page, 'cr-2-01-not-created-retry')
  // Still the same deposit address: no new payment is asked for.
  await expect(page.getByTestId('deposit-address')).toHaveText(address)

  net.blocked = false
  await retry.click()
  await expect(page.getByTestId('funds-pill')).toBeVisible({ timeout: 10 * 60_000 })
  await shot(page, 'cr-2-02-created-after-retry')
  const identityId = await createdIdentity(page)
  expect(net.sent).toBeGreaterThanOrEqual(1)
  const onChain = await identityOnChain(identityId)
  expect(onChain?.keyIds).toContain(5)
  test.info().annotations.push({ type: 'identity', description: identityId })
})
