import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { collectPageErrors, E2E_DEVNET, runAxe, shot } from './helpers'

/** The read fixture's owner (`forge-contracts/scripts/seed-v2-fixture.mjs`). */
const DEMO_OWNER = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'

/**
 * Explore, the header and the notifications page, signed out, on a devnet (reads only):
 *
 *   E2E_DEVNET=moutai E2E_PORT=4323 pnpm exec playwright test v2-explore.spec.ts
 *
 * The signed-in halves (my repos, the inbox, the key top-up) are in v2-inbox-topup.spec.ts,
 * gated on E2E_WRITE because signing in registers a key.
 */


test('x1. explore lists recent repos and says what it cannot know', async ({ page }) => {
  const { errors } = collectPageErrors(page)
  await page.goto('/explore/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Explore', level: 1 })).toBeVisible()
  const recent = page.getByTestId('explore-recent-repos')
  await expect(recent.locator('a[href*="/repo"]').first()).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('trending-note')).toHaveText("Trending needs an indexer. Forge doesn't run one; you can (docs).")
  const released = page.getByTestId('explore-recently-released')
  await expect(released).toContainText('no cross-repo index')
  await expect(released.locator('[data-empty], li').first()).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(/sign in to see your repos/i)).toBeVisible()
  await shot(page, 'd-explore-signed-out')
  const serious = await runAxe(page, 'explore')
  expect(serious, serious.map((v) => `${v.id}: ${v.help}`).join('\n')).toEqual([])
  expect(errors, errors.join('\n')).toEqual([])
})

test('x2. the header: New menu, jump box, and the landing links Explore', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('link', { name: 'Explore' }).first()).toBeVisible()
  await page.getByRole('button', { name: 'New', exact: true }).click()
  const menu = page.getByRole('navigation', { name: 'New' })
  await expect(menu.getByRole('link', { name: /Repository/ })).toHaveAttribute('href', /\/new/)
  await expect(menu.getByRole('link', { name: /Mirror a GitHub repo/ })).toHaveAttribute('href', /mirror-a-github-repo\.md$/)
  await page.waitForTimeout(300)
  await shot(page, 'd-header-new-menu')
  await expect(page.getByRole('button', { name: 'New', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(page.getByRole('button', { name: 'New', exact: true })).toBeFocused()

  // #n outside a repo explains itself; owner/name jumps.
  const jump = page.getByLabel(/jump to a repo/i).first()
  await jump.fill('#1')
  await jump.press('Enter')
  await expect(page.getByRole('status').filter({ hasText: /inside a repo/ })).toBeVisible()
  await jump.fill(`${DEMO_OWNER}/forge-v2-demo`)
  await jump.press('Enter')
  await expect(page).toHaveURL(/\/repo\/?\?owner=9r27/)
})

/**
 * Which numbers the demo repo has as issues and as PRs, read from Platform in Node. Issues and
 * PRs number independently (forge-v2.md §6), and other suites keep opening PRs on this repo,
 * so the spec picks its cases from what is on chain instead of hard-coding them.
 */
async function demoNumbers(): Promise<{ issues: Set<number>; pulls: Set<number> }> {
  const root = resolve(__dirname, '../..')
  const evo = await import(pathToFileURL(join(root, 'forge-web/node_modules/@dashevo/evo-sdk/dist/evo-sdk.module.js')).href)
  const dep = JSON.parse(readFileSync(join(root, `forge-contracts/deployments/devnet-${E2E_DEVNET}.json`), 'utf8'))
  const sdk = new evo.EvoSDK({ network: 'devnet', trusted: true, devnetName: E2E_DEVNET, addresses: dep.dapiAddresses })
  await sdk.connect()
  const docs = async (dataContractId: string, documentTypeName: string, where: unknown[]): Promise<Record<string, unknown>[]> => {
    const r: Map<string, { toJSON(v: number): Record<string, unknown> } | undefined> = await sdk.documents.query({ dataContractId, documentTypeName, where, limit: 100 })
    return [...r.values()].filter((d): d is { toJSON(v: number): Record<string, unknown> } => d !== undefined).map((d) => d.toJSON(14))
  }
  const [repo] = await docs(dep.v2.forgeCore.contractId, 'repo', [['$ownerId', '==', DEMO_OWNER], ['name', '==', 'forge-v2-demo']])
  const numbers = async (type: string): Promise<Set<number>> =>
    new Set((await docs(dep.v2.forgeCollab.contractId, type, [['repoId', '==', repo?.['$id']]])).map((d) => Number(d['number'])))
  return { issues: await numbers('issue'), pulls: await numbers('patch') }
}

test('x3. #n in a repo opens the issue or PR, and offers both when both exist', async ({ page }) => {
  const { issues, pulls } = await demoNumbers()
  const both = [...issues].find((n) => pulls.has(n))
  const issueOnly = [...issues].find((n) => !pulls.has(n))
  const pullOnly = [...pulls].find((n) => !issues.has(n))
  const absent = Math.max(0, ...issues, ...pulls) + 1000
  test.info().annotations.push({ type: 'numbers', description: `issues ${[...issues]} · PRs ${[...pulls]}` })
  expect(both, 'the fixture has an issue and a PR with the same number').toBeDefined()

  await page.goto(`/repo/?owner=${DEMO_OWNER}&name=forge-v2-demo`, { waitUntil: 'domcontentloaded' })
  const jump = page.getByLabel(/jump to a repo/i).first()
  const go = async (n: number): Promise<void> => {
    await jump.fill(`#${n}`)
    await jump.press('Enter')
  }

  // Both exist: the chooser offers each, and the issue link opens the issue.
  await go(both ?? 1)
  const note = page.getByRole('status').filter({ hasText: new RegExp(`#${both} is both`) })
  await expect(note).toBeVisible({ timeout: 60_000 })
  await expect(note.getByRole('link', { name: `PR #${both}` })).toHaveAttribute('href', new RegExp(`/repo/pull/?\\?.*number=${both}`))
  await note.getByRole('link', { name: `issue #${both}` }).click()
  await expect(page).toHaveURL(new RegExp(`/repo/issue/?\\?.*number=${both}`))

  // Only one exists: straight there.
  if (issueOnly !== undefined) {
    await go(issueOnly)
    await expect(page).toHaveURL(new RegExp(`/repo/issue/?\\?.*number=${issueOnly}(&|$)`), { timeout: 60_000 })
  }
  if (pullOnly !== undefined) {
    await go(pullOnly)
    await expect(page).toHaveURL(new RegExp(`/repo/pull/?\\?.*number=${pullOnly}(&|$)`), { timeout: 60_000 })
  }

  // Neither: say so, stay put.
  const url = page.url()
  await go(absent)
  await expect(page.getByRole('status').filter({ hasText: `No issue or PR #${absent}` })).toBeVisible({ timeout: 60_000 })
  expect(page.url()).toBe(url)
})

test('x4. notifications, signed out, say what they are', async ({ page }) => {
  await page.goto('/notifications/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Notifications are computed in this browser from the chain. Nothing is sent to you; nothing leaves your device.', { exact: false })).toBeVisible()
  const serious = await runAxe(page, 'notifications-signed-out')
  expect(serious, serious.map((v) => `${v.id}: ${v.help}`).join('\n')).toEqual([])
})

test('x5. the header fits a 390 px phone', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  await page.goto('/explore/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Explore', level: 1 })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await expect(page.getByLabel(/jump to a repo/i).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'New', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^sign in$/i }).first()).toBeVisible()
  await page.getByRole('button', { name: 'New', exact: true }).click()
  await expect(page.getByRole('link', { name: /Mirror a GitHub repo/ })).toBeVisible()
  // The menu paints above the jump-box row: the point under its last item is the item.
  const item = page.getByRole('link', { name: /Mirror a GitHub repo/ })
  const box = await item.boundingBox()
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x ?? 0, y ?? 0)?.closest('a')?.textContent ?? '', [(box?.x ?? 0) + 20, (box?.y ?? 0) + 10])
  expect(hit).toContain('Mirror a GitHub repo')
  await page.getByTestId('explore-recent-repos').locator('a[href*="/repo"]').first().waitFor({ timeout: 60_000 })
  await page.waitForTimeout(300)
  await shot(page, 'd-header-mobile-390')
  const serious = await runAxe(page, 'header-mobile')
  expect(serious, serious.map((v) => `${v.id}: ${v.help}`).join('\n')).toEqual([])
  await context.close()
})
