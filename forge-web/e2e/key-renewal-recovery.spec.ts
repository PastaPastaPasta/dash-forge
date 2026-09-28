import { test, expect, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { E2E_DEVNET, PASSPHRASE, shot } from './helpers'

/**
 * A key renewal interrupted after its identity update was broadcast, live on a devnet (D-016):
 *
 *   E2E_DEVNET=moutai E2E_WRITE=1 E2E_RENEW_IDENTITY=/path/to/fresh.identity.json \
 *     pnpm exec playwright test key-renewal-recovery.spec.ts
 *
 * Needs a freshly minted identity of its own (about 0.05 DASH: two key registrations and one
 * follow); never a shared fixture identity. One browser context, one vault:
 *
 * k1. Import the identity file: this browser's key is registered and shown in Settings → Keys.
 * k2. Renew it, and close the page the moment Platform accepts the update (the broadcast's
 *     response), before the page can commit the new key: the renewal is staged, not committed.
 * k3. Reload: Settings → Keys is locked; unlock with the passphrase. The staged key is on
 *     Platform, so it is adopted: Settings → Keys shows the new key id, no pending renewal, and
 *     the old key is disabled on the identity.
 * k4. The adopted key signs a write (follow), and Platform charges that key's budget.
 */

const ID_FILE = process.env['E2E_RENEW_IDENTITY'] ?? ''
const SHOTS = process.env['E2E_SHOT_PREFIX'] ?? 'renewal'
test.skip(process.env['E2E_WRITE'] !== '1', 'live devnet writes: set E2E_WRITE=1')
test.skip(ID_FILE === '' || !existsSync(ID_FILE), 'set E2E_RENEW_IDENTITY to a freshly minted identity file of your own')
test.describe.configure({ mode: 'serial', timeout: 6 * 60_000 })

const ROOT = resolve(__dirname, '../..')
/** Someone to follow: the read fixture's seeder (following writes only to the follower). */
const DEMO_OWNER = '5999iJiaZLMEb6KbjXYFDDYjwGWssatToUTJbXvXhxBp'
const BROADCAST = '**/org.dash.platform.dapi.v0.Platform/broadcastStateTransition'

/* eslint-disable @typescript-eslint/no-explicit-any -- evo-sdk is imported by path in Node */
let sdkPromise: Promise<any> | null = null
function nodeSdk(): Promise<any> {
  sdkPromise ??= (async () => {
    const evo = await import(pathToFileURL(join(ROOT, 'forge-web/node_modules/@dashevo/evo-sdk/dist/evo-sdk.module.js')).href)
    const dep = JSON.parse(readFileSync(join(ROOT, `forge-contracts/deployments/devnet-${E2E_DEVNET}.json`), 'utf8'))
    const sdk = new evo.EvoSDK({ network: 'devnet', trusted: true, devnetName: E2E_DEVNET, addresses: dep.dapiAddresses })
    await sdk.connect()
    return sdk
  })()
  return sdkPromise
}
const IDENTITY: string = ID_FILE && existsSync(ID_FILE) ? String(JSON.parse(readFileSync(ID_FILE, 'utf8')).identityId) : ''

/** The identity's keys as Platform shows them: id → disabled. */
async function chainKeys(): Promise<Map<number, boolean>> {
  const identity = await (await nodeSdk()).identities.fetch(IDENTITY)
  return new Map(identity.publicKeys.map((k: any) => [Number(k.keyId), k.disabledAt !== undefined]))
}
async function balance(): Promise<bigint> {
  return BigInt((await (await nodeSdk()).identities.fetch(IDENTITY)).balance)
}
async function remainingBudget(keyId: number): Promise<bigint | null> {
  const map = await (await nodeSdk()).identities.keysRemainingBudgets(IDENTITY, [keyId])
  return (map.get(keyId) as bigint | undefined) ?? null
}
/* eslint-enable @typescript-eslint/no-explicit-any */

let context: import('@playwright/test').BrowserContext
let page: Page
let firstKey = -1
let renewedKey = -1

/**
 * Open Settings through the account menu. A client-side navigation: a full page load would
 * lock the vault (the unlocked key lives in this page's memory only).
 */
async function openSettings(p: Page): Promise<void> {
  await p.getByRole('button', { name: 'Account menu' }).click()
  await p.getByRole('link', { name: 'Settings & spend' }).click()
  await expect(p.getByTestId('keys-panel')).toBeVisible({ timeout: 30_000 })
}

async function keysPanelKeyId(p: Page): Promise<number> {
  await openSettings(p)
  const id = p.getByTestId('key-id')
  await expect(id).toBeVisible({ timeout: 90_000 })
  return Number(await id.getAttribute('data-key-id'))
}

/** Fill the import sheet (from its tile at sign-in; "Renew key" opens the form directly). */
async function importFile(p: Page, passphrase: string, fromTile = true): Promise<void> {
  if (fromTile) await p.getByTestId('tile-import').click()
  // The dialog's own file input (Settings → Keys has one too, for revoking).
  await p.getByRole('dialog').locator('input[type="file"]').setInputFiles(ID_FILE)
  await p.getByLabel('Passphrase', { exact: true }).fill(passphrase)
  await p.getByLabel('Repeat passphrase').fill(passphrase)
  await p.getByRole('button', { name: /create this browser's key/i }).click()
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext()
  page = await context.newPage()
})
test.afterAll(async () => {
  await context?.close()
})

test("k1. import: this browser's key is registered and shown in Settings → Keys", async () => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /^sign in$/i }).first().click()
  await importFile(page, PASSPHRASE)
  await expect(page.getByTestId('funds-pill')).toBeVisible({ timeout: 150_000 })
  firstKey = await keysPanelKeyId(page)
  expect((await chainKeys()).get(firstKey)).toBe(false)
  await expect(page.getByTestId('pending-renewal')).toHaveCount(0)
  await shot(page, `${SHOTS}-k1-keys`)
})

test('k2. renew, and close the page once Platform accepts the update, before the commit', async () => {
  test.skip(firstKey < 0, 'k1 did not register a key')
  // Settings → Keys → Renew key: the import sheet, as a renewal of the signed-in identity.
  await page.getByRole('button', { name: /renew key/i }).click()
  // The response to the broadcast is the moment the update is accepted: the page is closed
  // there, so whatever runs after it (the commit to the main record) never does.
  let accepted = false
  await page.route(BROADCAST, async (route) => {
    const response = await route.fetch()
    accepted = response.ok()
    await route.fulfill({ response })
    if (accepted) await page.close({ runBeforeUnload: false }).catch(() => undefined)
  })
  await importFile(page, PASSPHRASE, false)
  await expect.poll(() => page.isClosed(), { timeout: 150_000 }).toBe(true)
  expect(accepted).toBe(true)
  // The update landed: a new key is on the identity (the old one disabled in the same update).
  await expect
    .poll(async () => [...(await chainKeys()).entries()].some(([id, disabled]) => id > firstKey && !disabled), { timeout: 60_000, intervals: [2_000] })
    .toBe(true)
  renewedKey = Math.max(...(await chainKeys()).keys())
  expect((await chainKeys()).get(firstKey)).toBe(true)
})

test('k3. reload and unlock: the staged renewal is adopted; Settings → Keys shows the new key', async () => {
  test.skip(renewedKey < 0, 'k2 did not interrupt a renewal')
  page = await context.newPage()
  await page.goto('/settings/', { waitUntil: 'domcontentloaded' })
  // Locked: the stored keys are offered for unlock (nothing opened yet).
  await page.getByRole('button', { name: /^sign in$/i }).first().click()
  await shot(page, `${SHOTS}-k3-locked`)
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
  await page.getByRole('button', { name: /^unlock$/i }).click()
  await expect(page.getByTestId('funds-pill')).toBeVisible({ timeout: 120_000 })
  expect(await keysPanelKeyId(page)).toBe(renewedKey)
  await expect(page.getByTestId('pending-renewal')).toHaveCount(0)
  await shot(page, `${SHOTS}-k3-adopted`)
})

test('k4. the adopted key signs a write, and Platform charges it', async () => {
  test.skip(renewedKey < 0, 'k2 did not interrupt a renewal')
  const before = await balance()
  expect(await remainingBudget(renewedKey)).not.toBeNull()
  // The header search (client-side, the vault stays unlocked).
  await page.getByRole('searchbox').or(page.getByPlaceholder('owner/name or @name')).first().fill(`@${DEMO_OWNER}`)
  await page.keyboard.press('Enter')
  // Its name carries the price: "Follow ~0.0005 DASH" / "Following +0.0004 DASH".
  const follow = page.getByRole('button', { name: /^(follow|following)\b/i })
  await expect(page.getByTestId('follow-cost')).toContainText('DASH', { timeout: 90_000 })
  const wasFollowing = /following/i.test(await follow.innerText())
  await follow.click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: /sign & (follow|unfollow)/i }).click()
  await expect(page.getByRole('button', { name: wasFollowing ? /^follow\b(?!ing)/i : /^following\b/i })).toBeVisible({ timeout: 120_000 })
  // The write landed: the balance moved (a follow is charged; an unfollow refunds its storage).
  // The old key is disabled on the identity, so the adopted key is the only one that signs.
  await expect.poll(balance, { timeout: 60_000, intervals: [3_000] }).not.toBe(before)
  const keysNow = await chainKeys()
  expect(keysNow.get(firstKey)).toBe(true)
  expect(keysNow.get(renewedKey)).toBe(false)
  await shot(page, `${SHOTS}-k4-signed`)
  // Still the adopted key, still no pending renewal.
  expect(await keysPanelKeyId(page)).toBe(renewedKey)
  await expect(page.getByTestId('pending-renewal')).toHaveCount(0)
})
