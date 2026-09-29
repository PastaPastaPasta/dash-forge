import { test, expect, type Page } from '@playwright/test'
import { collectPageErrors, countDapi, E2E_DEVNET, repoUrl, shot } from './helpers'

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
 */

const [OWNER, NAME] = (process.env['E2E_HISTORY_REPO'] ?? 'unofficial-dashpay-dash-mirror/dash').split('/') as [string, string]
const REPO = { owner: OWNER, name: NAME } as const
/**
 * DAPI requests one cold home may make with the history index (every kind, incl. the connect).
 * dashpay/dash measured 100 before the index (the column's 400-commit walk) and 75 with it on
 * 2026-09-29; the rest is the repo chrome, which S-1 cuts separately.
 */
const MAX_DAPI = Number(process.env['E2E_HISTORY_MAX_DAPI'] ?? 80)

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
    const context = await browser.newContext()
    const page = await context.newPage()
    const { errors } = collectPageErrors(page)
    const counts = countDapi(page)

    await page.goto(repoUrl('', '', REPO), { waitUntil: 'domcontentloaded' })
    await settledColumn(page)
    const count = page.getByTestId('commit-count')
    await expect(count).toContainText(/^\s*[\d,]+ commits?\s*$/, { timeout: 30_000 })
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)

    const rows = await page.locator('main div.group.flex.h-9').count()
    expect(await commitCells(page).count(), 'every row has a commit').toBe(rows)
    await expect(pendingCells(page)).toHaveCount(0)
    await expect(page.getByTestId('search-older-history')).toHaveCount(0)
    await expect(count).toHaveAttribute('title', /history index/)
    const total = [...counts.values()].reduce((a, n) => a + n, 0)
    const budget = JSON.stringify(Object.fromEntries(counts))
    test.info().annotations.push({ type: 'dapi', description: `${total} DAPI requests ${budget}; ${await count.innerText()}` })
    await shot(page, 'hi-01-home-from-history-index')
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
})
