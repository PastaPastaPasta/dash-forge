import { test, expect, type Page, type Request } from '@playwright/test'
import { collectPageErrors, DAPI_METHOD, E2E_DEVNET, repoUrl, runAxe, shot, showcaseRepo } from './helpers'
import { quorumGuard } from './quorum-sync'

// Not inside a quorum-service lag (#212): these specs count requests.
test.beforeEach(quorumGuard)

/**
 * P1-3, in-repo code search: request budgets, counted at the network in a fresh browser context.
 *
 *   E2E_DEVNET=sakura pnpm exec playwright test code-search-budget.spec.ts
 *
 * - cs-1 (the read fixture): the search page cold, index built at once (a small repo), within S-1's
 *   page budget; then searches send no request of any kind; a reload opens the index this browser
 *   kept, with no blob read (within the warm budget).
 * - cs-2 (the dash mirror, read-only): the plan of a large repo is bounded (the tree walk, no blob
 *   read) and asks before reading; another ref is turned away (default branch only). The build
 *   itself reads ~25 MiB (sakura, 2026-10-02: 201 chunk queries, 35 s, 4,398 files, 45 MiB of text):
 *   opt in with E2E_CS_DASH_BUILD=1.
 */

/** S-1's cold page budget. */
const COLD_BUDGET = 25
/** S-1's warm budget. */
const WARM_BUDGET = 8
/** The dash plan: the page, the walk's trees and the object index (measured 35). */
const DASH_PLAN = Number(process.env['E2E_CS_DASH_PLAN'] ?? 60)
/** The dash build: one chunk query per ~100 chunks read (measured 201 for ~25 MiB). */
const DASH_BUILD = Number(process.env['E2E_CS_DASH_BUILD_DAPI'] ?? 320)
const DASH_BUILD_MS = Number(process.env['E2E_CS_DASH_BUILD_MS'] ?? 180_000)

/** DAPI requests, and requests to anywhere but the app itself, from now on. */
function record(page: Page): { dapi: () => string[]; elsewhere: () => string[] } {
  const dapi: string[] = []
  const elsewhere: string[] = []
  const own = new URL(page.url() === 'about:blank' ? 'http://127.0.0.1' : page.url()).host
  page.on('request', (r: Request) => {
    const m = DAPI_METHOD.exec(r.url())?.[1]
    if (m !== undefined) dapi.push(m)
    else if (!r.url().startsWith('data:') && new URL(r.url()).host !== own && !r.url().includes('127.0.0.1')) elsewhere.push(r.url())
  })
  return { dapi: () => dapi, elsewhere: () => elsewhere }
}

const searchUrl = (repo: { owner: string; name: string } | undefined, query: string, ref = ''): string =>
  repoUrl('search', `&query=${encodeURIComponent(query)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`, repo)

/** Type `query` and wait for its results (the search runs in the worker). */
async function searchFor(page: Page, query: string): Promise<string> {
  await page.getByTestId('code-search-input').fill(query)
  // The count names the query its results are for: the previous query's never answers this one.
  const count = page.locator(`[data-testid=code-search-count][data-query="${query.replace(/["\\]/g, '\\$&')}"]`)
  await expect(count).toBeVisible()
  return count.innerText()
}

test.describe('code search (P1-3)', () => {
  test('cs-1. the fixture: built cold within budget; searching sends nothing; a reload reads no blob', async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    const { errors } = collectPageErrors(page)
    const net = record(page)
    await page.goto(searchUrl(undefined, 'fn'))
    await expect(page.getByTestId('code-search-results')).toBeVisible({ timeout: 90_000 })
    await expect(page.getByTestId('code-search-hit').first()).toContainText('src/main.rs')
    await expect(page.getByTestId('code-search-hit').first().locator('mark').first()).toHaveText('fn')
    await page.waitForLoadState('networkidle').catch(() => undefined)
    const cold = net.dapi().length
    test.info().annotations.push({ type: 'dapi', description: `fixture search cold (build included): ${cold}` })
    expect(cold).toBeLessThanOrEqual(COLD_BUDGET)
    await shot(page, 'cs-01-fixture-results')
    expect(await runAxe(page, 'code-search results')).toEqual([])

    const before = net.dapi().length
    const away = net.elsewhere().length
    expect(await searchFor(page, 'hello')).toMatch(/^\d+ files?\b/)
    expect(await searchFor(page, 'path:*.md')).toMatch(/^\d+ files?\b/)
    expect(await searchFor(page, 'fn language:rust')).toMatch(/^1 file\b/)
    expect(await searchFor(page, '/print\\w+!/')).toMatch(/^1 file\b/)
    expect(net.dapi().length - before, 'searching a built index sends no DAPI request').toBe(0)
    expect(net.elsewhere().length - away, 'nor any other request').toBe(0)

    // A reload: the index this browser kept, no blob read.
    const r0 = net.dapi().length
    await page.reload()
    await expect(page.getByTestId('code-search-count')).toBeVisible({ timeout: 90_000 })
    await page.waitForLoadState('networkidle').catch(() => undefined)
    const warm = net.dapi().length - r0
    test.info().annotations.push({ type: 'dapi', description: `fixture search after a reload: ${warm}` })
    expect(warm).toBeLessThanOrEqual(WARM_BUDGET)
    expect(errors).toEqual([])
    await context.close()
  })

  test('cs-2. the dash mirror: a bounded plan that asks first; other refs default-branch only', async ({ browser }) => {
    test.skip(E2E_DEVNET !== 'sakura', 'the dash showcase mirror is imported on the live devnet')
    const dash = await showcaseRepo('DASHPAY', 'dash').catch(() => null)
    test.skip(dash === null, 'the dash mirror does not resolve on this devnet (set E2E_SHOWCASE_DASHPAY)')
    if (dash === null) return
    test.setTimeout(DASH_BUILD_MS + 180_000)
    const context = await browser.newContext()
    const page = await context.newPage()
    const net = record(page)
    await page.goto(searchUrl(dash, 'CDeterministicMNList'))
    const plan = page.getByTestId('code-search-plan')
    await expect(plan).toBeVisible({ timeout: 120_000 })
    await expect(plan).toContainText(/large repository/)
    const planned = net.dapi().length
    test.info().annotations.push({ type: 'dapi', description: `dash plan: ${planned}` })
    expect(planned).toBeLessThanOrEqual(DASH_PLAN)
    await shot(page, 'cs-02-dash-plan')

    if (process.env['E2E_CS_DASH_BUILD'] === '1') {
      const b0 = net.dapi().length
      const t0 = Date.now()
      await page.getByTestId('code-search-build').click()
      await expect(page.getByRole('progressbar')).toBeVisible()
      await expect(page.getByTestId('code-search-results')).toBeVisible({ timeout: DASH_BUILD_MS })
      const built = net.dapi().length - b0
      test.info().annotations.push({ type: 'dapi', description: `dash build: ${built} in ${Date.now() - t0} ms` })
      expect(built).toBeLessThanOrEqual(DASH_BUILD)
      const s0 = net.dapi().length
      expect(await searchFor(page, 'llmq')).toMatch(/^[\d,]+ files\b/)
      expect(net.dapi().length - s0).toBe(0)
      await shot(page, 'cs-03-dash-results')
    }

    // Another ref of a large repo: the default branch only.
    const tag = await page.goto(searchUrl(dash, 'CDeterministicMNList', 'v23.0.0'))
    expect(tag?.ok()).toBe(true)
    await expect(page.getByTestId('code-search-default')).toBeVisible({ timeout: 120_000 })
    await shot(page, 'cs-04-dash-tag-default-only')
    await context.close()
  })
})
