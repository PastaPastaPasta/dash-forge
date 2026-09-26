import { test, expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { E2E_DEVNET, PASSPHRASE, idFile, shot, signedIn, unlock } from './helpers'

/**
 * Limited-key sign-in, live on a devnet (real spend):
 *
 *   E2E_DEVNET=moutai E2E_WRITE=1 pnpm exec playwright test v2-auth.spec.ts
 *
 * a1. Import an identity file: the master key registers a limited key for this browser; the
 *     spec then reads the identity from Platform itself and checks the key is live, HIGH,
 *     bound to the dash-forge contract group, with the default budget (0.05 DASH) and expiry
 *     (~90 days). The vault survives a reload and unlocks with the passphrase; nothing that
 *     looks like a private key sits in localStorage.
 * a2. Create an identity in the browser: words, quiz, passphrase, deposit address — which the
 *     harness funds from the devnet faucet key (FORGE_DEVNET_FUNDING_KEY_FILE, a
 *     dash-network-configs devnet YAML; tools/mint-identity `fundFromKey`) — then the asset
 *     lock, its chain-lock proof and the IdentityCreate. Skipped without a funding key.
 */

test.skip(E2E_DEVNET === '' || process.env['E2E_WRITE'] !== '1', 'live devnet writes: set E2E_DEVNET=moutai E2E_WRITE=1')
test.skip(!existsSync(idFile('CI-RUNNER')), 'devnet test identities not found')
test.describe.configure({ mode: 'serial', timeout: 30 * 60_000 })

const ROOT = resolve(__dirname, '../..')
const GROUP = '23iVLZABbVQ5a4heSa6GLVbVqSWr74JTSESSMTEYNd6o'

/** Read an identity's keys straight from Platform (evo-sdk in Node), independent of the app. */
async function onChainKeys(identityId: string): Promise<{ id: number; level: string; budget: bigint | null; expiresAt: number | null; bound: string | null; remaining: bigint | null }[]> {
  const evo = await import(pathToFileURL(join(ROOT, 'forge-web/node_modules/@dashevo/evo-sdk/dist/evo-sdk.module.js')).href)
  const dep = (await import(pathToFileURL(join(ROOT, `forge-contracts/deployments/devnet-${E2E_DEVNET}.json`)).href, { with: { type: 'json' } })).default
  const sdk = new evo.EvoSDK({ network: 'devnet', trusted: true, devnetName: E2E_DEVNET, addresses: dep.dapiAddresses })
  await sdk.connect()
  const identity = await sdk.identities.fetch(identityId)
  const keys = identity.publicKeys as { keyId: number; securityLevel: string; totalBudget?: bigint; expiresAt?: bigint; contractBounds?: { toJSON(): { id: string } } }[]
  const budgets = await sdk.identities.keysRemainingBudgets(identityId, keys.map((k) => k.keyId))
  return keys.map((k) => ({
    id: k.keyId,
    level: String(k.securityLevel).toUpperCase(),
    budget: k.totalBudget ?? null,
    expiresAt: k.expiresAt === undefined ? null : Number(k.expiresAt),
    bound: k.contractBounds?.toJSON().id ?? null,
    remaining: budgets.get(k.keyId) ?? null,
  }))
}

test('a1. import once: a limited key lands on chain, the vault survives a reload', async ({ browser }) => {
  const identityId = String(JSON.parse(readFileSync(idFile('CI-RUNNER'), 'utf8')).identityId)
  const before = await onChainKeys(identityId)
  const page = await signedIn(browser, 'CI-RUNNER', '/settings/')
  await expect(page.getByTestId('key-budget')).toContainText('0.05 DASH', { timeout: 30_000 })
  await shot(page, 'v2a-01-settings-key')

  const after = await onChainKeys(identityId)
  const added = after.filter((k) => !before.some((b) => b.id === k.id))
  expect(added).toHaveLength(1)
  const key = added[0]!
  expect(key.level).toBe('HIGH')
  expect(key.bound).toBe(GROUP)
  expect(key.budget).toBe(5_000_000_000n)
  expect(key.remaining).toBe(5_000_000_000n)
  const days = ((key.expiresAt ?? 0) - Date.now()) / 86_400_000
  expect(days).toBeGreaterThan(89)
  expect(days).toBeLessThan(91)

  // Nothing key-like is left in localStorage; the vault holds only ciphertext.
  const ls = await page.evaluate(() => Object.entries(localStorage).map(([k, v]) => `${k}=${v}`).join('\n'))
  expect(ls).not.toMatch(/forge_key_/)
  expect(ls).not.toMatch(/\bc[1-9A-HJ-NP-Za-km-z]{51}\b/)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await unlock(page)
  await expect(page.getByTestId('funds-pill')).toBeVisible()
})

test('a2. create an identity in the browser, funded from the devnet key', async ({ browser }) => {
  const keyFile = process.env['FORGE_DEVNET_FUNDING_KEY_FILE'] ?? ''
  test.skip(keyFile === '' || !existsSync(keyFile), 'set FORGE_DEVNET_FUNDING_KEY_FILE to a devnet YAML with faucet_privkey')
  const funding = await import(pathToFileURL(join(ROOT, 'tools/mint-identity/src/funding.mjs')).href)
  const config = await import(pathToFileURL(join(ROOT, 'tools/mint-identity/src/config.mjs')).href)
  const network = config.devnetConfig(E2E_DEVNET)

  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /^sign in$/i }).first().click()
  await page.getByTestId('tile-create').click()
  const words = page.getByTestId('mnemonic-words')
  await expect(words).toBeVisible({ timeout: 60_000 })
  const list = await words.locator('[data-word]').allInnerTexts()
  expect(list).toHaveLength(12)
  await shot(page, 'v2a-02-words')
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
  await shot(page, 'v2a-03-deposit')
  const fundingKey = funding.loadFundingKey(network, { keyFile })
  const fundTx = await funding.fundFromKey(fundingKey, [{ address, duffs: 3_000_000 }], network, () => undefined)
  test.info().annotations.push({ type: 'funding', description: `${fundTx} → ${address} (0.03 DASH)` })

  // Chain-lock proofs on a devnet wait for a mined, chain-locked block: minutes.
  await expect(page.getByTestId('funds-pill')).toBeVisible({ timeout: 25 * 60_000 })
  await page.goto('/settings/', { waitUntil: 'domcontentloaded' })
  await unlock(page)
  await expect(page.getByTestId('key-budget')).toContainText('0.05 DASH', { timeout: 30_000 })
  const identityId = await page.getByTestId('settings-identity').getAttribute('data-identity')
  test.info().annotations.push({ type: 'identity', description: identityId ?? '' })
  await shot(page, 'v2a-04-created')
})
