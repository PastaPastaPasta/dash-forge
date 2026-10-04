import { test, expect, type Browser, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEMO, E2E_DEVNET, shot } from './helpers'

/**
 * Refused writes, retries and the write flow's guards, live on a devnet (D-007, D-008, D-012,
 * D-042, D-048, D-049):
 *
 *   E2E_DEVNET=sakura E2E_WRITE=1 E2E_REFUSAL_IDENTITY=/path/to/funded.identity.json \
 *     pnpm exec playwright test write-refusals.spec.ts
 *
 * Needs an identity of its own with about 0.02 DASH to spend: the spec registers limited keys
 * on it with its master key and writes to a scratch repo it creates, so never point it at a
 * shared fixture identity. Each browser signs in with a pasted limited key (Advanced), so every
 * test controls exactly the key it signs with.
 *
 * s0. Create the scratch repo (every write below goes there, never to the read fixtures).
 * r1. A key whose budget covers the old estimate but not what Platform requires: the write is
 *     stopped before signing and the key sheet opens (D-012).
 * r2. Exhaust a key's budget from another tab, then write: Platform refuses it and the Renew
 *     sheet opens with the reason, never "Sent, not yet visible" (D-007).
 * r3. Retry after an edit: the first attempt's answer is lost ("Sent, not yet visible"), the
 *     title is edited and submitted again, and the edited title is what lands (D-008).
 * r4. A key expires while the page is open: the pill turns red without a reload, and a write
 *     opens Renew instead of a raw error (D-042).
 * r5. Follow shows its price and asks to confirm (D-048); an over-long comment is blocked with
 *     a live counter (D-049).
 */

const ID_FILE = process.env['E2E_REFUSAL_IDENTITY'] ?? ''
/** Where the evidence screenshots go (default: e2e/screenshots). */
const SHOTS = process.env['E2E_SHOT_PREFIX'] ?? 'refusal'
test.skip(process.env['E2E_WRITE'] !== '1', 'live devnet writes: set E2E_WRITE=1')
test.skip(ID_FILE === '' || !existsSync(ID_FILE), 'set E2E_REFUSAL_IDENTITY to a funded identity file of your own')
test.describe.configure({ mode: 'serial', timeout: 6 * 60_000 })

const ROOT = resolve(__dirname, '../..')
const DEMO_OWNER = DEMO.owner
/** The scratch repo: made by s0, or an earlier run's (`E2E_REFUSAL_REPO`) to rerun one test. */
const SCRATCH = process.env['E2E_REFUSAL_REPO'] || `refusal-${Date.now().toString(36)}`
const DAY = 86_400_000
/** Unique per run, so a rerun in the same scratch repo never reads an earlier run's issue. */
const RUN = Date.now().toString(36).slice(-5)
const TITLE_A = `RETRY-TITLE-A ${RUN}`
const TITLE_B = `RETRY-TITLE-B ${RUN}`

/* eslint-disable @typescript-eslint/no-explicit-any -- evo-sdk is imported by path in Node */
interface Env {
  evo: any
  sdk: any
  dep: any
  identityId: string
  masterWif: string
}
let envPromise: Promise<Env> | null = null
function env(): Promise<Env> {
  envPromise ??= (async () => {
    const evo = await import(pathToFileURL(join(ROOT, 'forge-web/node_modules/@dashevo/evo-sdk/dist/evo-sdk.module.js')).href)
    const dep = JSON.parse(readFileSync(join(ROOT, `forge-contracts/deployments/devnet-${E2E_DEVNET}.json`), 'utf8'))
    const sdk = new evo.EvoSDK({ network: 'devnet', trusted: true, devnetName: E2E_DEVNET, addresses: dep.dapiAddresses })
    await sdk.connect()
    const rec = JSON.parse(readFileSync(ID_FILE, 'utf8'))
    const master = rec.identityKeys.find((k: { securityLevel: string }) => k.securityLevel === 'MASTER')
    return { evo, sdk, dep, identityId: String(rec.identityId), masterWif: String(master.privateKeyWif) }
  })()
  return envPromise
}

/** Register a Forge-style limited key (group-bound, HIGH) with `budget` credits; its WIF. */
async function limitedKey(budget: bigint, ttlMs = DAY): Promise<string> {
  const { evo, sdk, dep, identityId, masterWif } = await env()
  const identity = await sdk.identities.fetch(identityId)
  const fresh = evo.PrivateKey.fromBytes(crypto.getRandomValues(new Uint8Array(32)), 'testnet')
  const keyId = Math.max(...identity.publicKeys.map((k: { keyId: number }) => k.keyId)) + 1
  const signer = new evo.IdentitySigner()
  signer.addKey(evo.PrivateKey.fromWIF(masterWif))
  signer.addKey(fresh)
  const key = new evo.IdentityPublicKeyInCreation({
    keyId,
    purpose: 'authentication',
    securityLevel: 'high',
    keyType: 'ecdsa_secp256k1',
    data: fresh.getPublicKey().toBytes(),
    contractBounds: evo.ContractBounds.ContractGroup(dep.v2.contractGroupId ?? dep.v2.forgeCore.contractGroupId),
    totalBudget: budget,
    expiresAt: BigInt(Date.now() + ttlMs),
  })
  await sdk.identities.update({ identity, addPublicKeys: [key], signer })
  // A node a block behind does not show the key yet.
  for (let i = 0; i < 10; i++) {
    const now = await sdk.identities.fetch(identityId)
    if (now.publicKeys.some((k: { keyId: number }) => k.keyId === keyId)) break
    await new Promise((r) => setTimeout(r, 1500))
  }
  return fresh.toWIF()
}

/** The identity's issue titles in the scratch repo, read from Platform (not the app). */
async function scratchIssueTitles(): Promise<string[]> {
  const { sdk, dep, identityId } = await env()
  const repos = await sdk.documents.query({
    dataContractId: dep.v2.forgeCore.contractId,
    documentTypeName: 'repo',
    where: [
      ['$ownerId', '==', identityId],
      ['name', '==', SCRATCH],
    ],
    limit: 1,
  })
  const repo = [...repos.values()][0] as any
  if (!repo) return []
  const rows = await sdk.documents.query({
    dataContractId: dep.v2.forgeCollab.contractId,
    documentTypeName: 'issue',
    where: [['repoId', '==', repo.toJSON(14).$id]],
    orderBy: [['number', 'asc']],
    limit: 100,
  })
  return [...rows.values()].filter(Boolean).map((d: any) => String(d.toJSON(14).title))
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** A fresh browser context signed in with a pasted key (the tab signs with exactly that key). */
async function signedInWithKey(browser: Browser, wif: string, path: string): Promise<Page> {
  const { identityId } = await env()
  const page = await (await browser.newContext()).newPage()
  await page.goto(path, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /^sign in$/i }).first().click()
  await page.getByRole('button', { name: 'Advanced' }).click()
  await page.getByTestId('tile-advanced').click()
  await page.getByLabel('Identity ID').fill(identityId)
  await page.getByLabel('Private key (WIF or hex)').fill(wif)
  await page.getByRole('button', { name: /sign in for this tab/i }).click()
  await expect(page.getByTestId('funds-pill')).toBeVisible({ timeout: 90_000 })
  return page
}

async function issuesPath(): Promise<string> {
  return `/repo/issues/?owner=${(await env()).identityId}&name=${SCRATCH}`
}

/** Open the new-issue dialog and fill its title. */
async function composeIssue(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: /new issue/i }).first().click({ timeout: 90_000 })
  await page.getByLabel('Title', { exact: true }).fill(title)
}

test('s0. create the scratch repo', async ({ browser }) => {
  test.skip(Boolean(process.env['E2E_REFUSAL_REPO']), 'reusing E2E_REFUSAL_REPO')
  const page = await signedInWithKey(browser, await limitedKey(1_000_000_000n), '/new/')
  await page.getByLabel('Repository name').fill(SCRATCH)
  await page.getByRole('button', { name: 'Create repository' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('cost-preview')).toBeVisible()
  await dialog.getByRole('button', { name: /sign & create/i }).click()
  await expect(page.getByRole('region', { name: 'Empty repository' })).toBeVisible({ timeout: 120_000 })
})

test('r1. a key short of what Platform requires is stopped before signing (D-012)', async ({ browser }) => {
  // 0.0009 DASH: more than the old estimate of an issue (0.000585), less than Drive requires.
  const page = await signedInWithKey(browser, await limitedKey(90_000_000n), await issuesPath())
  await composeIssue(page, 'r1 stopped before signing')
  await page.getByRole('button', { name: /submit issue/i }).click()
  const sheet = page.getByTestId('top-up-sheet')
  await expect(sheet).toBeVisible({ timeout: 30_000 })
  await expect(sheet).toHaveAttribute('data-blocker', 'key-budget')
  await expect(page.getByText(/Sent, not yet visible/)).toHaveCount(0)
  await shot(page, `${SHOTS}-r1-precheck`)
  expect(await scratchIssueTitles()).not.toContain('r1 stopped before signing')
})

test('r2. exhaust the key budget, write: the Renew sheet opens, not "sent" (D-007)', async ({ browser }) => {
  // 0.0015 DASH: the page's pre-check passes (Drive requires ~0.00105 for an issue); the other
  // tab's issue (~0.0006) leaves ~0.0009, less than Platform requires for the next one.
  const wif = await limitedKey(150_000_000n)
  const page = await signedInWithKey(browser, wif, await issuesPath())
  // Another tab signing with the same key spends most of its budget; this page still holds
  // the budget it read at sign-in, so its pre-check lets the write go to Platform.
  const other = await signedInWithKey(browser, wif, await issuesPath())
  await composeIssue(other, 'r2 drain from another tab')
  await other.getByRole('button', { name: /submit issue/i }).click()
  await expect(other.getByRole('heading', { name: /r2 drain from another tab/ })).toBeVisible({ timeout: 120_000 })
  await other.context().close()

  await composeIssue(page, 'r2 refused by Platform')
  await page.getByRole('button', { name: /submit issue/i }).click()
  const sheet = page.getByTestId('top-up-sheet')
  await expect(sheet).toBeVisible({ timeout: 120_000 })
  await expect(sheet).toContainText('Renew key')
  await expect(page.getByRole('dialog', { name: /renew this browser's key/i })).toContainText(/does not have enough budget left/)
  await expect(page.getByText(/Sent, not yet visible/)).toHaveCount(0)
  await shot(page, `${SHOTS}-r2-renew-sheet`)
  await expect(page.getByRole('dialog', { name: 'Open an issue' })).toContainText(/doesn't have enough budget left\. You weren't charged/)
  expect(await scratchIssueTitles()).not.toContain('r2 refused by Platform')
})

test('r3. retry after an edit lands the edited title (D-008)', async ({ browser }) => {
  const page = await signedInWithKey(browser, await limitedKey(1_000_000_000n), await issuesPath())
  await composeIssue(page, TITLE_A)
  // The broadcast never reaches a node and the page hears nothing back.
  const BROADCAST = '**/org.dash.platform.dapi.v0.Platform/broadcastStateTransition'
  await page.route(BROADCAST, (route) => route.abort('timedout'))
  await page.getByRole('button', { name: /submit issue/i }).click()
  const dialog = page.getByRole('dialog', { name: 'Open an issue' })
  await expect(dialog).toContainText(/Sent, not yet visible/, { timeout: 120_000 })
  await shot(page, `${SHOTS}-r3-unconfirmed`)
  await page.unroute(BROADCAST)
  // The nodes the failed attempt marked down come back after the budget gate's hold.
  await page.waitForTimeout(16_000)

  await page.getByLabel('Title', { exact: true }).fill(TITLE_B)
  await page.getByRole('button', { name: /submit issue/i }).click()
  await expect(page.getByRole('heading', { name: TITLE_B })).toBeVisible({ timeout: 120_000 })
  await shot(page, `${SHOTS}-r3-edited-landed`)
  const titles = await scratchIssueTitles()
  expect(titles).toContain(TITLE_B)
  expect(titles).not.toContain(TITLE_A)
})

test('r4. a key that expires turns the pill red without a reload and opens Renew (D-042)', async ({ browser }) => {
  const page = await signedInWithKey(browser, await limitedKey(1_000_000_000n, 75_000), await issuesPath())
  const pill = page.getByTestId('funds-pill')
  await expect(pill).toHaveAttribute('data-level', 'low')
  await expect(pill).toHaveAttribute('data-level', 'empty', { timeout: 120_000 })
  await shot(page, `${SHOTS}-r4-pill-expired`)
  await page.getByRole('button', { name: /new issue/i }).first().click()
  await page.getByLabel('Title', { exact: true }).fill('r4 expired key')
  // The submit button is disabled with the reason; the pill opens the fix.
  await expect(page.getByRole('button', { name: /submit issue/i })).toBeDisabled()
  await page.keyboard.press('Escape')
  await pill.click()
  const sheet = page.getByTestId('top-up-sheet')
  await expect(sheet).toHaveAttribute('data-blocker', 'key-expiry')
  await expect(page.getByRole('dialog', { name: /renew this browser's key/i })).toContainText(/has expired/)
  await expect(sheet).toContainText('Renew key')
  await expect(page.getByText(/no usable AUTHENTICATION key/)).toHaveCount(0)
  await shot(page, `${SHOTS}-r4-renew-sheet`)
})

test('r5. follow asks with its price; an over-long comment is blocked (D-048, D-049)', async ({ browser }) => {
  const page = await signedInWithKey(browser, await limitedKey(500_000_000n), `/u/?name=${DEMO_OWNER}`)
  const follow = page.getByRole('button', { name: /^(follow|following)/i })
  await expect(page.getByTestId('follow-cost')).toContainText('DASH', { timeout: 90_000 })
  await follow.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('cost-preview')).toBeVisible()
  await expect(dialog.getByRole('button', { name: /sign & (follow|unfollow)/i })).toBeVisible()
  await shot(page, `${SHOTS}-r5-follow-confirm`)
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  const issue = await signedInWithKey(browser, await limitedKey(500_000_000n), `/repo/issue/?owner=${(await env()).identityId}&name=${SCRATCH}&number=1`)
  const box = issue.getByLabel('Comment', { exact: true })
  await expect(box).toBeVisible({ timeout: 90_000 })
  await box.fill('€'.repeat(2000))
  const counter = issue.getByTestId('text-counter').first()
  await expect(counter).toHaveAttribute('data-over', 'true')
  await expect(counter).toContainText('6,000 bytes')
  await expect(issue.getByRole('button', { name: /^comment$/i })).toBeDisabled()
  await expect(issue.getByTestId('funds-pill')).toBeVisible()
  await shot(issue, `${SHOTS}-r5-comment-too-long`)
})
