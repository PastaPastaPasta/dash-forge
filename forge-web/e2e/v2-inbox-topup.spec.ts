import { test, expect, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { E2E_DEVNET, SCREENSHOT_DIR, idFile, runAxe, shot, signedIn, unlock } from './helpers'

/**
 * Signed in as CI-RUNNER, live on a devnet (real spend, ~0.0003 DASH plus a key if the stored
 * one is gone):
 *
 *   E2E_DEVNET=moutai E2E_WRITE=1 E2E_PORT=4323 pnpm exec playwright test v2-inbox-topup.spec.ts
 *
 * t1. Explore's "my" sections render honest empty states or data.
 * t2. The inbox starts empty with the local-only copy; after CI-RUNNER stars a repo the write
 *     spec made (never the read fixture) and opts in to starred repos, the other identities'
 *     issues there show up, the header badge counts them, and mark read / mark all read work.
 * t3. Top up this browser's key by +0.01 DASH with the identity file; Node reads the identity
 *     from Platform and checks the same key id now has +0.01 DASH of budget and no key was added.
 *
 * CI-RUNNER only: the other test identities sign concurrently in other suites, and parallel
 * writers from one identity collide on nonces.
 */

test.skip(E2E_DEVNET === '' || process.env['E2E_WRITE'] !== '1', 'live devnet writes: set E2E_DEVNET=moutai E2E_WRITE=1')
test.skip(!existsSync(idFile('CI-RUNNER')), 'devnet test identities not found')
test.describe.configure({ mode: 'serial', timeout: 10 * 60_000 })

const ROOT = resolve(__dirname, '../..')
const OWNER = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const RUNNER = String(JSON.parse(readFileSync(idFile('CI-RUNNER'), 'utf8')).identityId)

interface NodeSdk {
  identities: {
    fetch(id: string): Promise<{ publicKeys: { keyId: number; totalBudget?: bigint }[] }>
    keysRemainingBudgets(id: string, ids: number[]): Promise<Map<number, bigint | null>>
  }
  documents: { query(q: unknown): Promise<Map<string, { toJSON(v: number): Record<string, unknown> } | undefined>> }
}

let sdkPromise: Promise<{ sdk: NodeSdk; collab: string; core: string }> | null = null
/** evo-sdk in Node, independent of the app (as v2-auth.spec.ts). */
function nodeSdk(): Promise<{ sdk: NodeSdk; collab: string; core: string }> {
  sdkPromise ??= (async () => {
    const evo = await import(pathToFileURL(join(ROOT, 'forge-web/node_modules/@dashevo/evo-sdk/dist/evo-sdk.module.js')).href)
    const dep = JSON.parse(readFileSync(join(ROOT, `forge-contracts/deployments/devnet-${E2E_DEVNET}.json`), 'utf8'))
    const sdk = new evo.EvoSDK({ network: 'devnet', trusted: true, devnetName: E2E_DEVNET, addresses: dep.dapiAddresses })
    await sdk.connect()
    return { sdk: sdk as NodeSdk, collab: String(dep.v2.forgeCollab.contractId), core: String(dep.v2.forgeCore.contractId) }
  })()
  return sdkPromise
}

async function docs(query: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const { sdk } = await nodeSdk()
  const r = await sdk.documents.query(query)
  return [...r.values()].filter((d): d is { toJSON(v: number): Record<string, unknown> } => d !== undefined).map((d) => d.toJSON(14))
}

/** A repo the write spec made (OWNER's `e2e-*`) with an issue by someone other than CI-RUNNER. */
async function writeSpecRepo(): Promise<string | null> {
  const { core, collab } = await nodeSdk()
  const repos = await docs({ dataContractId: core, documentTypeName: 'repo', where: [['$ownerId', '==', OWNER]], orderBy: [['name', 'asc']], limit: 100 })
  const candidates = repos.filter((r) => String(r['name']).startsWith('e2e-')).sort((a, b) => Number(b['$createdAt']) - Number(a['$createdAt']))
  for (const r of candidates) {
    const issues = await docs({ dataContractId: collab, documentTypeName: 'issue', where: [['repoId', '==', r['$id']]], orderBy: [['$createdAt', 'desc']], limit: 5 })
    if (issues.some((i) => i['$ownerId'] !== RUNNER)) return String(r['name'])
  }
  return null
}

async function budgets(): Promise<Map<number, bigint | null>> {
  const { sdk } = await nodeSdk()
  const identity = await sdk.identities.fetch(RUNNER)
  const out = new Map<number, bigint | null>()
  for (const k of identity.publicKeys) out.set(k.keyId, k.totalBudget ?? null)
  return out
}

async function inboxReady(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible()
  await expect(page.getByText(/Last checked/)).toBeVisible({ timeout: 120_000 })
}

test('t1. explore, signed in: my sections are honest', async ({ browser }) => {
  const page = await signedIn(browser, 'CI-RUNNER', '/explore/')
  const mine = page.getByTestId('explore-mine')
  await expect(mine).toBeVisible({ timeout: 60_000 })
  for (const id of ['explore-my-repos', 'explore-repos-i-maintain-or-write-to', 'explore-my-issues', 'explore-my-pull-requests', 'explore-starred', 'explore-assigned-to-me-or-mentioning-me']) {
    const section = page.getByTestId(id)
    // Either an honest empty line or data, never a spinner forever or an error.
    await expect(section.locator('[data-empty], a[href*="/repo"]').first()).toBeVisible({ timeout: 90_000 })
    await expect(section.getByText(/did not land/)).toHaveCount(0)
  }
  await expect(page.getByTestId('explore-assigned-to-me-or-mentioning-me')).toContainText('have no index')
  await shot(page, 'd-explore-signed-in')
  const serious = await runAxe(page, 'explore-signed-in')
  expect(serious, serious.map((v) => `${v.id}: ${v.help}`).join('\n')).toEqual([])
})

test('t2. inbox: empty first, then items from a starred repo, badge and mark read', async ({ browser }) => {
  const page = await signedIn(browser, 'CI-RUNNER', '/notifications/')
  await inboxReady(page)
  await expect(page.getByText(/no email, no push and no\s+sync/i)).toBeVisible()
  const empty = page.getByTestId('inbox-empty')
  if (await empty.isVisible()) {
    await expect(empty).toContainText('Notifications are computed in this browser from the chain. Nothing is sent to you; nothing leaves your device.')
    await shot(page, 'd-notifications-empty')
  }
  const serious = await runAxe(page, 'notifications')
  expect(serious, serious.map((v) => `${v.id}: ${v.help}`).join('\n')).toEqual([])

  const repo = await writeSpecRepo()
  test.skip(repo === null, 'no write-spec repo with an issue on this devnet; run v2-writes.spec.ts first')
  // A full navigation reloads the app, which locks the vault: unlock again after each.
  await page.goto(`/repo/?owner=${OWNER}&name=${repo}`, { waitUntil: 'domcontentloaded' })
  await unlock(page)
  const starred = page.getByRole('button', { name: /starred/i })
  const star = page.getByRole('button', { name: /^star/i })
  await expect(starred.or(star)).toBeEnabled({ timeout: 60_000 })
  if (!(await starred.isVisible())) {
    await star.click()
    await expect(starred).toBeVisible({ timeout: 90_000 })
  }

  await page.goto('/notifications/', { waitUntil: 'domcontentloaded' })
  await unlock(page)
  await inboxReady(page)
  const watchStars = page.getByLabel('Also watch repos I starred')
  if (!(await watchStars.isChecked())) await watchStars.check()
  const list = page.getByTestId('inbox-list')
  // A new watch set is read at once, then round-robin; items land within a couple of rounds.
  await expect(list.locator('li').first()).toBeVisible({ timeout: 180_000 })
  await expect(list).toContainText(repo ?? '')
  const bell = page.getByTestId('notifications-bell')
  await expect(bell).not.toHaveAttribute('data-unread', '0')
  await expect(bell).toHaveAccessibleName(/\d+ unread/)
  await shot(page, 'd-notifications-items')

  const before = Number(await bell.getAttribute('data-unread'))
  await list.getByRole('button', { name: /^Mark read/ }).first().click()
  await expect(bell).toHaveAttribute('data-unread', String(before - 1))
  if (before > 1) await page.getByRole('button', { name: 'Mark all read' }).click()
  await expect(bell).toHaveAttribute('data-unread', '0')
  await expect(page.getByTestId('inbox-empty')).toContainText('All caught up')
  await page.getByRole('button', { name: /^All/ }).click()
  await expect(list.locator('li[data-read="true"]').first()).toBeVisible()
  // Read state survives a reload (IndexedDB), and items link to their thread.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await unlock(page)
  await expect(page.getByTestId('notifications-bell')).toHaveAttribute('data-unread', '0')
  await page.getByRole('button', { name: /^All/ }).click()
  await expect(page.getByTestId('inbox-list').locator('li[data-read="true"]').first()).toBeVisible()
})

test('t3. top up this browser key by +0.01 DASH, same key on chain', async ({ browser }) => {
  const page = await signedIn(browser, 'CI-RUNNER', '/settings/')
  await expect(page.getByTestId('key-budget')).toBeVisible({ timeout: 60_000 })
  const before = await budgets()
  await page.getByRole('button', { name: 'Top up key budget' }).click()
  const dialog = page.getByRole('dialog', { name: "Top up this browser's key" })
  await expect(dialog).toContainText('signs this one update and is not stored')
  await dialog.getByLabel('Add to the budget (DASH)').fill('0.01')
  const extend = dialog.getByLabel(/Extend the expiry/)
  if (await extend.isChecked()) await extend.uncheck()
  await dialog.getByLabel('Identity file for the top-up').setInputFiles(idFile('CI-RUNNER'))
  await expect(dialog.getByTestId('cost-preview')).toContainText('DASH')
  // The dialog is a fixed overlay: a viewport screenshot, not a full-page one.
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'd-key-topup-dialog.png') })
  await dialog.getByRole('button', { name: /sign once & top up/i }).click()
  await expect(dialog.getByTestId('key-top-up-done')).toBeVisible({ timeout: 120_000 })
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'd-key-topup-result.png') })

  const after = await budgets()
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
  const changed = [...after].filter(([id, b]) => b !== before.get(id))
  expect(changed).toHaveLength(1)
  const [keyId, total] = changed[0] ?? [-1, null]
  expect((total ?? 0n) - (before.get(keyId) ?? 0n)).toBe(1_000_000_000n)
  test.info().annotations.push({ type: 'topped-up', description: `key ${keyId}: ${before.get(keyId)} → ${total}` })
  await dialog.getByRole('button', { name: 'Done' }).click()
  // The settings row shows the new total from the session's refreshed limits.
  await expect(page.getByTestId('key-budget')).toContainText(`of ${Number(total) / 1e11} DASH`)
})
