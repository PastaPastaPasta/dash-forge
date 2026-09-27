import { test, expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { PASSPHRASE, nodeSdk, shot } from './helpers'

/**
 * L-07: signing in on a new device from the 12 words alone. Import → Recovery phrase, no
 * identity ID: Forge finds the identity by its master key's hash (`identities.byPublicKeyHash`)
 * and registers a limited key for this browser. A live devnet write (one IdentityUpdate):
 *
 *   E2E_WRITE=1 E2E_WORDS_IDENTITY=<identity file with a mnemonic> pnpm exec playwright test signin-words-recovery.spec.ts
 *
 * Use a freshly minted identity (`qa mint`), never a shared fixture.
 */

const FILE = process.env['E2E_WORDS_IDENTITY'] ?? ''
test.skip(process.env['E2E_WRITE'] !== '1', 'live devnet write: set E2E_WRITE=1')
test.skip(FILE === '' || !existsSync(FILE), 'set E2E_WORDS_IDENTITY to an identity file with a mnemonic')
test.describe.configure({ timeout: 5 * 60_000 })

test('w1. the 12 words alone sign in: the identity is found, a limited key lands on it', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'one live write per run')
  const { identityId, mnemonic } = JSON.parse(readFileSync(FILE, 'utf8')) as { identityId: string; mnemonic: string }
  const sdk = await nodeSdk()
  const before = (await sdk.identities.fetch(identityId)).publicKeys.length as number

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /^sign in$/i }).first().click({ timeout: 60_000 })
  await page.getByTestId('tile-import').click({ timeout: 60_000 })
  await page.getByRole('tab', { name: 'Recovery phrase' }).click()
  await page.getByLabel('Recovery phrase (12 or 24 words)').fill(mnemonic)
  await expect(page.getByLabel('Identity ID (optional)')).toHaveValue('')
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
  await page.getByLabel('Repeat passphrase').fill(PASSPHRASE)
  const create = page.getByRole('button', { name: /create this browser's key/i })
  await expect(create).toBeEnabled()
  await create.click()
  await expect(page.getByTestId('funds-pill')).toBeVisible({ timeout: 180_000 })
  await shot(page, 'signin-w1-words-only-signed-in')

  const after = (await sdk.identities.fetch(identityId)).publicKeys.length as number
  expect(after).toBe(before + 1)

  // L-29: this device now holds a key. After a reload the sheet opens straight on Unlock: the
  // tile list is never rendered first, not even for a frame.
  await page.addInitScript(() => {
    const w = window as unknown as { sawTiles: boolean }
    w.sawTiles = false
    new MutationObserver(() => {
      if (document.querySelector('[data-testid^="tile-"]')) w.sawTiles = true
    }).observe(document, { childList: true, subtree: true })
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /^sign in$|^unlock$/i }).first().click({ timeout: 60_000 })
  await expect(page.getByText('This browser holds a key for')).toBeVisible({ timeout: 30_000 })
  expect(await page.evaluate(() => (window as unknown as { sawTiles: boolean }).sawTiles)).toBe(false)
  await shot(page, 'signin-w1-reopen-unlock')

  // The same words again on this device: it already holds a key for the identity found, so the
  // sheet offers Unlock instead of a paid renewal, and nothing is written.
  const writes: string[] = []
  page.on('request', (r) => {
    if (/broadcastStateTransition/.test(r.url())) writes.push(r.url())
  })
  await page.getByRole('button', { name: /other sign-in options/i }).click()
  await page.getByTestId('tile-import').click()
  await page.getByRole('tab', { name: 'Recovery phrase' }).click()
  await page.getByLabel('Recovery phrase (12 or 24 words)').fill(mnemonic)
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
  await page.getByLabel('Repeat passphrase').fill(PASSPHRASE)
  await page.getByRole('button', { name: /create this browser's key/i }).click()
  await expect(page.getByText('This browser holds a key for')).toBeVisible({ timeout: 60_000 })
  expect(writes).toEqual([])
  expect((await sdk.identities.fetch(identityId)).publicKeys.length).toBe(after)
})
