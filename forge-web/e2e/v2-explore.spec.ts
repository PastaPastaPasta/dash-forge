import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { collectPageErrors, DEMO, E2E_DEVNET, runAxe, shot } from './helpers'

/** The read fixture's owner (`forge-contracts/scripts/seed-v2-fixture.mjs`). */
const DEMO_OWNER = DEMO.owner

/**
 * Explore, the header and the notifications page, signed out, on a devnet (reads only):
 *
 *   E2E_DEVNET=sakura E2E_PORT=4323 pnpm exec playwright test v2-explore.spec.ts
 *
 * The signed-in halves (my repos, the inbox, the key top-up) are in v2-inbox-topup.spec.ts,
 * gated on E2E_WRITE because signing in registers a key.
 */


test('x1. explore lists recent repos, trending, most starred and most forked, and says what it cannot know', async ({ page }) => {
  const { errors } = collectPageErrors(page)
  await page.goto('/explore/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Explore', level: 1 })).toBeVisible()
  const recent = page.getByTestId('explore-recent-repos')
  await expect(recent.locator('a[href*="/repo"]').first()).toBeVisible({ timeout: 60_000 })
  // Trending and Most starred are proved ranked reads (C-1); no "needs an indexer" note.
  await expect(page.getByTestId('trending-note')).toHaveCount(0)
  await expect(page.getByTestId('explore-trending').getByRole('heading', { name: /Trending (this week|today)/ })).toBeVisible()
  await expect(page.getByTestId('explore-most-starred').getByRole('heading', { name: 'Most starred' })).toBeVisible()
  // Most forked (ranked repo.forkOf, fresh core): the repos that are not forks form the index's
  // null group, which is never shown as a row.
  const forked = page.getByTestId('explore-most-forked')
  await expect(forked.getByRole('heading', { name: 'Most forked' })).toBeVisible()
  await expect(forked.getByTestId('ranked-row').first().or(forked.getByText('No repo on this network has been forked yet.'))).toBeVisible({ timeout: 60_000 })
  expect(await forked.getByTestId('ranked-row').evaluateAll((els) => els.filter((el) => !el.getAttribute('data-repo-id')).length)).toBe(0)
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
  await expect(menu.getByRole('link', { name: /Mirror a GitHub repo/ })).toHaveAttribute('href', /\/mirror\/?$/)
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
  await expect(page).toHaveURL(new RegExp(`/repo/?\\?owner=${DEMO_OWNER}`))
})

/**
 * Which numbers the demo repo has as issues and as PRs, read from Platform in Node. Issues and
 * PRs share one dense, per-repo number sequence (forge-v2.md §6.2: `tk` 0 for issues, 1 for
 * PRs) — a number can only ever be one or the other — and other suites keep opening PRs on this
 * repo, so the spec picks its cases from what is on chain instead of hard-coding them.
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

test('x3. #n in a repo opens the issue or the PR', async ({ page }) => {
  const { issues, pulls } = await demoNumbers()
  // Dense, shared numbering (forge-v2.md §6.2): a number is an issue XOR a PR, never both, so
  // the two sets are disjoint by construction. The old "both" chooser (app-header.tsx `goNumber`)
  // is defensive/unreachable code for this repo's own numbers now; nothing here exercises it.
  const overlap = [...issues].filter((n) => pulls.has(n))
  expect(overlap, 'issue and PR numbers must be disjoint under dense shared numbering').toEqual([])
  const issueOnly = [...issues][0]
  const pullOnly = [...pulls][0]
  const absent = Math.max(0, ...issues, ...pulls) + 1000
  test.info().annotations.push({ type: 'numbers', description: `issues ${[...issues]} · PRs ${[...pulls]}` })

  await page.goto(`/repo/?owner=${DEMO_OWNER}&name=forge-v2-demo`, { waitUntil: 'domcontentloaded' })
  const jump = page.getByLabel(/jump to a repo/i).first()
  const go = async (n: number): Promise<void> => {
    await jump.fill(`#${n}`)
    await jump.press('Enter')
  }

  // An issue number: straight to the issue.
  if (issueOnly !== undefined) {
    await go(issueOnly)
    await expect(page).toHaveURL(new RegExp(`/repo/issue/?\\?.*number=${issueOnly}(&|$)`), { timeout: 60_000 })
  }
  // A PR number: straight to the PR.
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
