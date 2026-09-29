import { test, expect, type Page } from '@playwright/test'
import { collectPageErrors, countDapi, DAPI_METHOD, decodeDocumentsRequest, E2E_DEVNET, repoUrl, shot } from './helpers'

/**
 * The history index (packManifest kind 3, docs/design/history-index.md) on a live repo's home:
 *
 *   E2E_DEVNET=moutai E2E_HISTORY_REPO=<owner>/<name> pnpm exec playwright test history-index.spec.ts
 *
 * `E2E_HISTORY_REPO` must name a repo whose default branch's tip a history index covers (a push
 * with this build, or `dg repo reindex`); default: the dashpay/dash showcase mirror, backfilled
 * with `dg repo reindex`. `E2E_HISTORY_MAX_DAPI` sets the cold home's request budget (default
 * {@link MAX_DAPI}).
 *
 * Asserted, cold (a fresh browser context: no session cache, no stored index):
 *  - every row's commit cell shows a commit (subject linked, age), none "…", none "not changed
 *    since", and no "Search older history" control: the index answered every name;
 *  - the ref bar shows an exact count (`12,345 commits`, no `+`);
 *  - the page settles within the request budget, and the column's lookup read no commit history:
 *    the home's DAPI requests are the budget's, not the ~100 a 400-commit walk added (L-41).
 * Then a subdirectory's listing gets real commits the same way.
 *
 * v2 (per-path version lists; the repo's index must be v2: a push with this build, or
 * `dg repo reindex` over a v1 index):
 *  - hi-2: Blame of {@link BLAME_PATH} settles cold with no history walk blocks, within
 *    `E2E_BLAME_MAX_DAPI` requests. Offline on dashpay/dash 3ba0805c (history-replay.test.ts):
 *    357 chunk queries walking, 16 with the index; the live baseline was 121 s and 427 requests.
 *  - hi-3: the first History page of {@link HISTORY_PATH} comes from the index (no walk).
 */

const [OWNER, NAME] = (process.env['E2E_HISTORY_REPO'] ?? 'unofficial-dashpay-dash-mirror/dash').split('/') as [string, string]
const REPO = { owner: OWNER, name: NAME } as const
/**
 * DAPI requests one cold home may make with the history index (every kind, incl. the connect).
 * Measured with master 758df8b4's page-budget method (2026-09-29): dashpay/dash 50 on master (25
 * of them the column's and the count's history walk), 26 with the index; preact 31 → 19,
 * ripgrep 18 → 13.
 */
const MAX_DAPI = Number(process.env['E2E_HISTORY_MAX_DAPI'] ?? 30)
/** The file hi-2 blames and hi-3 lists (dashpay/dash's by default). */
const BLAME_PATH = process.env['E2E_HISTORY_BLAME_PATH'] ?? 'src/clientversion.h'
const HISTORY_PATH = process.env['E2E_HISTORY_PATH'] ?? 'src/validation.cpp'
/** A cold Blame page's requests: the page's own (~26, as the home) plus ~16 for Blame with the index. */
const MAX_BLAME_DAPI = Number(process.env['E2E_BLAME_MAX_DAPI'] ?? 50)
/** A cold History page's requests: the page's own plus ~3. */
const MAX_LOG_DAPI = Number(process.env['E2E_LOG_MAX_DAPI'] ?? 35)

/** Count the history walk's read-ahead blocks (a `chunk` read of 17-19 seqs): the index removes them. */
function walkBlocks(page: Page): { readonly n: number } {
  const seen = { n: 0 }
  page.on('request', (r) => {
    if (DAPI_METHOD.exec(r.url())?.[1] !== 'getDocuments') return
    const d = decodeDocumentsRequest(r.postDataBuffer() ?? null)
    const n = d?.documentType === 'chunk' ? d.where.find((w) => w.inCount !== null)?.inCount : undefined
    if (typeof n === 'number' && n >= 17 && n <= 19) seen.n++
  })
  return seen
}

const pendingCells = (page: Page) => page.getByTestId('commit-cell-pending')
const commitCells = (page: Page) => page.getByTestId('commit-cell')

async function settledColumn(page: Page): Promise<void> {
  await expect(page.locator('main a[href*="/repo/tree/"], main a[href*="/repo/blob/"]').first()).toBeVisible({ timeout: 45_000 })
  await expect(commitCells(page).first()).toBeVisible({ timeout: 45_000 })
  await expect(pendingCells(page).filter({ hasText: '…' })).toHaveCount(0, { timeout: 45_000 })
}

test.describe('history index (live)', () => {
  test.skip(E2E_DEVNET !== 'moutai', 'the history-indexed repo lives on moutai')

  test('hi-1. the home column and count come from the index: real commits on every row, an exact count, no walk', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const { errors } = collectPageErrors(page)
    const counts = countDapi(page)
    const blocks = walkBlocks(page)

    await page.goto(repoUrl('', '', REPO), { waitUntil: 'domcontentloaded' })
    await settledColumn(page)
    const count = page.getByTestId('commit-count')
    await expect(count).toContainText(/^\s*[\d,]+ commits?\s*$/, { timeout: 30_000 })
    // Settle as page-budget.spec.ts does, so the numbers compare.
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined)
    await page.waitForTimeout(2_500)
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)

    const rows = await page.locator('main div.group.flex.h-9').count()
    expect(await commitCells(page).count(), 'every row has a commit').toBe(rows)
    await expect(pendingCells(page)).toHaveCount(0)
    await expect(page.getByTestId('search-older-history')).toHaveCount(0)
    await expect(count).toHaveAttribute('title', /history index/)
    const total = [...counts.values()].reduce((a, n) => a + n, 0)
    const budget = JSON.stringify(Object.fromEntries(counts))
    test.info().annotations.push({ type: 'dapi', description: `${total} DAPI requests ${budget}; ${await count.innerText()}` })
    await shot(page, 'hi-01-home-from-history-index')
    expect(blocks.n, 'history walk read-ahead blocks').toBe(0)
    expect(total, budget).toBeLessThanOrEqual(MAX_DAPI)
    expect(errors, errors.join('\n')).toEqual([])

    // A subdirectory: the same index answers its entries (full paths).
    const dir = page.locator('main a[href*="/repo/tree/"]').first()
    await dir.click()
    await expect(page).toHaveURL(/\/repo\/tree\//)
    await settledColumn(page)
    await expect(pendingCells(page)).toHaveCount(0)
    await shot(page, 'hi-02-subdirectory-from-history-index')
    await context.close()
  })

  test('hi-2. Blame of a long-lived file reads its versions from the index: no history walk, within the request budget', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const { errors } = collectPageErrors(page)
    const counts = countDapi(page)
    const blocks = walkBlocks(page)
    const started = Date.now()
    await page.goto(repoUrl('blame', `&path=${encodeURIComponent(BLAME_PATH)}`, REPO), { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('blame-table')).toBeVisible({ timeout: 90_000 })
    await expect(page.getByTestId('blame-progress')).toHaveCount(0, { timeout: 90_000 })
    const ms = Date.now() - started
    const total = [...counts.values()].reduce((a, n) => a + n, 0)
    const budget = JSON.stringify(Object.fromEntries(counts))
    test.info().annotations.push({ type: 'dapi', description: `${total} DAPI requests in ${ms} ms ${budget}` })
    await shot(page, 'hi-03-blame-from-history-index')
    expect(blocks.n, 'history walk read-ahead blocks').toBe(0)
    expect(total, budget).toBeLessThanOrEqual(MAX_BLAME_DAPI)
    expect(errors, errors.join('\n')).toEqual([])
    await context.close()
  })

  test('hi-3. a file’s History lists its first page from the index', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const { errors } = collectPageErrors(page)
    const counts = countDapi(page)
    const blocks = walkBlocks(page)
    await page.goto(repoUrl('commits', `&path=${encodeURIComponent(HISTORY_PATH)}`, REPO), { waitUntil: 'domcontentloaded' })
    const log = page.getByTestId('commit-log')
    await expect(log).toBeVisible({ timeout: 90_000 })
    await expect(log).toHaveAttribute('data-source', 'index')
    await expect(page.getByTestId('commit-row')).toHaveCount(40)
    await expect(page.getByTestId('log-from-index')).toBeVisible()
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined)
    const total = [...counts.values()].reduce((a, n) => a + n, 0)
    const budget = JSON.stringify(Object.fromEntries(counts))
    test.info().annotations.push({ type: 'dapi', description: `${total} DAPI requests ${budget}` })
    await shot(page, 'hi-04-history-from-history-index')
    expect(blocks.n, 'history walk read-ahead blocks').toBe(0)
    expect(total, budget).toBeLessThanOrEqual(MAX_LOG_DAPI)
    expect(errors, errors.join('\n')).toEqual([])
    await context.close()
  })
})
