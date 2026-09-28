import { test, expect, type Page } from '@playwright/test'
import { collectPageErrors, countDapi, countDocumentQueries, E2E_DEVNET, repoUrl, shot } from './helpers'

/**
 * G16 (L-15, L-41): a large repo's home, cold, against a live showcase mirror on moutai:
 *
 *   E2E_DEVNET=moutai pnpm exec playwright test repo-home-latency.spec.ts
 *
 * The owner is addressed by DPNS name (the showcase identities are re-minted when moutai is
 * reset; the names are re-registered). `E2E_LARGE_REPO=owner/name` points it at another repo
 * (dashpay/dash once its re-import lands: `unofficial-dashpay-dash-mirror/dash`).
 *
 * Asserted, per cold load (a fresh browser context: no session cache, no stored index):
 *  - the root file list is on screen within {@link COLD_LIST_MS}, the page settled (README, commit
 *    count, commit column) within {@link COLD_SETTLED_MS};
 *  - the DAPI request budget: at most {@link MAX_DAPI} requests, one `packManifest` listing, no
 *    `getDataContract`;
 *  - the last-commit column never shows a bare blank: every cell has a commit or says why not.
 * A warm load (same context, the repo visited once) must settle within {@link WARM_MS}.
 */

const [LARGE_OWNER, LARGE_NAME] = (process.env['E2E_LARGE_REPO'] ?? 'unofficial-preactjs-mirror/preact').split('/') as [string, string]
const LARGE = { owner: LARGE_OWNER, name: LARGE_NAME } as const

/** The root list, on a cold load (target: under 6 s for dashpay/dash). */
const COLD_LIST_MS = 6000
/** README, commit count and the commit column, on a cold load. */
const COLD_SETTLED_MS = 9000
/** The same page again in the same tab (session caches warm). */
const WARM_MS = 2000
/** DAPI requests one cold home may make (every kind, incl. the connect). */
const MAX_DAPI = 120

const fileRows = (page: Page) => page.locator('main a[href*="/repo/tree/"], main a[href*="/repo/blob/"]')
const commitCells = (page: Page) => page.locator('main a[href*="/repo/commit/"]')

/** Every row's commit cell holds a commit link or a labelled state, never nothing. */
async function blankCommitCells(page: Page): Promise<number> {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('main div.group.flex.h-9')]
    return rows.filter((row) => {
      const cell = row.querySelector(':scope > span.hidden')
      return cell !== null && (cell.textContent ?? '').trim() === ''
    }).length
  })
}

test.describe('repo home latency (showcase repos)', () => {
  test.skip(E2E_DEVNET !== 'moutai', 'the showcase repos are imported on moutai')

  test('rhl-1. a large repo home, cold: the list within 6 s, a bounded request budget, no blank commit cells', async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    const { errors } = collectPageErrors(page)
    const counts = countDapi(page)
    const manifests = countDocumentQueries(page, 'packManifest')

    const t0 = Date.now()
    await page.goto(repoUrl('', '', LARGE), { waitUntil: 'domcontentloaded' })
    await expect(fileRows(page).first()).toBeVisible({ timeout: 30_000 })
    const listMs = Date.now() - t0
    await expect(page.getByTestId('commit-count')).toContainText(/\d/, { timeout: 30_000 })
    // The commit column settles: nothing is still being walked.
    await expect(page.getByTestId('commit-cell-pending').filter({ hasText: '…' })).toHaveCount(0, { timeout: 30_000 })
    const settledMs = Date.now() - t0
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
    await shot(page, 'rhl-01-large-repo-home-cold')

    const total = [...counts.values()].reduce((a, n) => a + n, 0)
    const budget = JSON.stringify(Object.fromEntries(counts))
    test.info().annotations.push({ type: 'timing', description: `list ${listMs} ms, settled ${settledMs} ms, ${total} DAPI requests ${budget}` })

    expect(listMs, `root list after ${listMs} ms`).toBeLessThan(COLD_LIST_MS)
    expect(settledMs, `settled after ${settledMs} ms`).toBeLessThan(COLD_SETTLED_MS)
    expect(total, budget).toBeLessThanOrEqual(MAX_DAPI)
    expect(counts.get('getDataContract') ?? 0, budget).toBe(0)
    // The browse context resolves once, even though the home prefetches it alongside the refs.
    expect(manifests.count(), 'packManifest listings').toBeLessThanOrEqual(2)

    expect(await commitCells(page).count()).toBeGreaterThan(0)
    expect(await blankCommitCells(page)).toBe(0)
    expect(errors, errors.join('\n')).toEqual([])

    // Warm: the same page again in this tab.
    await page.getByRole('link', { name: /^Issues/ }).first().click()
    await expect(page).toHaveURL(/\/repo\/issues\//)
    const t1 = Date.now()
    await page.getByRole('link', { name: /^Code$/ }).first().click()
    await expect(fileRows(page).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('section[aria-label=README]')).toBeVisible({ timeout: 10_000 })
    const warmMs = Date.now() - t1
    test.info().annotations.push({ type: 'timing', description: `warm ${warmMs} ms (issues → code)` })
    expect(warmMs, `warm home after ${warmMs} ms`).toBeLessThan(WARM_MS)
    await context.close()
  })

  test('rhl-2. a slow node does not hold the home: the read is re-asked of another node', async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    // The first node to be asked for a `refUpdate` page stalls for 20 s (the J5 outliers: one
    // node answering in 4–15 s while the others idled).
    let stalled: string | null = null
    let stalls = 0
    await page.route(/\/org\.dash\.platform\.dapi\.v0\.Platform\/getDocuments$/, async (route) => {
      const node = new URL(route.request().url()).origin
      const body = route.request().postDataBuffer()
      if (stalled === null && body?.includes(Buffer.from('refUpdate'))) stalled = node
      if (node === stalled && stalls < 3) {
        stalls++
        await new Promise((r) => setTimeout(r, 20_000))
      }
      await route.continue().catch(() => undefined)
    })
    const t0 = Date.now()
    await page.goto(repoUrl('', '', LARGE), { waitUntil: 'domcontentloaded' })
    await expect(fileRows(page).first()).toBeVisible({ timeout: 30_000 })
    const listMs = Date.now() - t0
    test.info().annotations.push({ type: 'timing', description: `list ${listMs} ms with ${stalls} stalled requests` })
    expect(stalls).toBeGreaterThan(0)
    // Without the hedge this waits out the SDK's 15 s request timeout.
    expect(listMs, `root list after ${listMs} ms`).toBeLessThan(12_000)
    await context.close()
  })
})
