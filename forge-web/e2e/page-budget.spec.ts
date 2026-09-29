import { test, expect, type Page, type Request } from '@playwright/test'
import { collectPageErrors, DAPI_METHOD, decodeDocumentsRequest, E2E_DEVNET, repoUrl, shot, showcaseRepo, waitForRepoResolved } from './helpers'

/**
 * S-1 (`platform-parity-spec.md`): every page ≤ 25 DAPI requests cold and ≤ 8 warm, counted
 * per request at the network (every kind, the connect included), in a fresh browser context:
 *
 *   E2E_DEVNET=moutai pnpm exec playwright test page-budget.spec.ts
 *
 * - pb-1: the read fixture's cold home, issues list, and a warm file-and-back navigation.
 * - pb-2 (showcase repos): a mirrored repo's cold home. The file list's last-commit column is a
 *   history walk (its own agent is replacing it with a push-time index): its chunk reads are
 *   counted apart and budgeted on their own, so the rest of the home is held to S-1.
 *
 * The budget covers what the page shows on load. Below the fold the About card's LICENSE and
 * language bar, and the latest release, are read when scrolled into view (skeletons until then):
 * pb-1 checks that scrolling there reads them.
 */

/** S-1's cold page budget. */
const COLD_BUDGET = 25
/** S-1's warm budget: a page of a repo already open in the tab. */
const WARM_BUDGET = 8
/** The read fixture's cold home (measured 8: the chrome composite, counts, locator, objects). */
const DEMO_COLD_HOME = 12
/** The read fixture's issues list, cold (measured 7). */
const DEMO_COLD_ISSUES = 12
/**
 * The commit column's walk on a showcase repo: one chunk read per 256 KiB of pack history it
 * crosses (preact 12, dashpay/dash 20). Owned by the last-change index work; tracked, not S-1.
 */
const COLUMN_WALK_MAX = 30

type DapiRequest = { readonly method: string; readonly body: Buffer | null }

/** Requests `page` sends to DAPI from now on, each with its body (decoded where a check needs it). */
function recordDapi(page: Page): { readonly all: () => DapiRequest[] } {
  const seen: DapiRequest[] = []
  page.on('request', (r: Request) => {
    const method = DAPI_METHOD.exec(r.url())?.[1]
    if (method !== undefined) seen.push({ method, body: r.postDataBuffer() })
  })
  return { all: () => seen }
}

const summary = (rows: readonly { method: string }[]): string => {
  const by = new Map<string, number>()
  for (const r of rows) by.set(r.method, (by.get(r.method) ?? 0) + 1)
  return JSON.stringify(Object.fromEntries(by))
}

/** Wait for the page's trailing reads (counts, rail) to go out and settle. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined)
  await page.waitForTimeout(2_500)
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
}

const fileRows = (page: Page) => page.locator('main a[href*="/repo/tree/"], main a[href*="/repo/blob/"]')

test.describe('page request budget (S-1)', () => {
  test('pb-1. the fixture: cold home ≤ budget, the issues list ≤ budget, warm file-and-back ≤ 8', async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    const { errors } = collectPageErrors(page)
    const dapi = recordDapi(page)

    await page.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(fileRows(page).first()).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('section[aria-label=README]')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('commit-count')).toContainText(/\d/, { timeout: 30_000 })
    await settle(page)
    const cold = dapi.all().length
    test.info().annotations.push({ type: 'dapi', description: `fixture cold home: ${cold} ${summary(dapi.all())}` })
    expect(cold, summary(dapi.all())).toBeLessThanOrEqual(DEMO_COLD_HOME)
    // Nothing the home shows went missing: counts, stars, members, the owner's name.
    const about = page.getByRole('complementary', { name: 'About this repository' })
    await expect(about.getByRole('link', { name: /Stars/ })).toContainText(/\d/)
    await expect(about.getByTestId('rail-members')).toBeVisible()
    await shot(page, 'pb-01-fixture-home-cold')

    // Below the fold: read on scroll, with skeletons until then.
    const release = about.getByRole('region', { name: 'Latest release' })
    await release.scrollIntoViewIfNeeded()
    await expect(release).toContainText(/No releases yet|v\d/, { timeout: 45_000 })
    await settle(page)
    const scrolled = dapi.all().length - cold
    test.info().annotations.push({ type: 'dapi', description: `below the fold, on scroll: ${scrolled}` })
    expect(scrolled, 'the deferred cards read on scroll').toBeGreaterThan(0)
    await shot(page, 'pb-02-fixture-home-scrolled')

    // Warm: a file, then back. The repo is open in the tab: no page re-reads what it has.
    await page.evaluate(() => window.scrollTo(0, 0))
    const beforeWarm = dapi.all().length
    await page.getByRole('link', { name: 'README.md', exact: true }).first().click()
    await expect(page).toHaveURL(/\/repo\/blob\//)
    await expect(page.locator('main').getByText(/forge|README/i).first()).toBeVisible({ timeout: 30_000 })
    await page.goBack()
    await expect(fileRows(page).first()).toBeVisible({ timeout: 30_000 })
    await settle(page)
    const warm = dapi.all().slice(beforeWarm)
    test.info().annotations.push({ type: 'dapi', description: `warm file and back: ${warm.length} ${summary(warm)}` })
    expect(warm.length, summary(warm)).toBeLessThanOrEqual(WARM_BUDGET)
    expect(errors, errors.join('\n')).toEqual([])
    await context.close()

    // The issues list, cold, in a context of its own.
    const issuesContext = await browser.newContext()
    const issues = await issuesContext.newPage()
    const issueDapi = recordDapi(issues)
    await issues.goto(repoUrl('issues'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(issues)
    await expect(issues.locator('main a[href*="/repo/issue"]').first()).toBeVisible({ timeout: 60_000 })
    await settle(issues)
    const list = issueDapi.all()
    test.info().annotations.push({ type: 'dapi', description: `fixture cold issues: ${list.length} ${summary(list)}` })
    expect(list.length, summary(list)).toBeLessThanOrEqual(DEMO_COLD_ISSUES)
    await shot(issues, 'pb-03-fixture-issues-cold')
    await issuesContext.close()
  })

  test.describe('showcase repos', () => {
    test.skip(E2E_DEVNET !== 'moutai', 'the showcase repos are imported on moutai')

    test('pb-2. a mirrored repo, cold: the home ≤ 25 besides the commit column walk', async ({ browser }) => {
      const repo = await showcaseRepo('PREACTJS', 'preact')
      const context = await browser.newContext()
      const page = await context.newPage()
      const dapi = recordDapi(page)
      await page.goto(repoUrl('', '', repo), { waitUntil: 'domcontentloaded' })
      await waitForRepoResolved(page)
      await expect(fileRows(page).first()).toBeVisible({ timeout: 60_000 })
      await expect(page.getByTestId('commit-cell-pending').filter({ hasText: '…' })).toHaveCount(0, { timeout: 60_000 })
      await settle(page)
      const all = dapi.all()
      // The column walk's reads: chunk reads of the git pack whose seq window is 18-19 chunks (one
      // 256 KiB read-ahead block). The locator, root tree and README are read as other shapes.
      const columnish = all.filter((r) => r.method === 'getDocuments' && blockSized(r.body))
      const rest = all.length - columnish.length
      test.info().annotations.push({
        type: 'dapi',
        description: `preact cold home: ${all.length} in all, ${columnish.length} read-ahead blocks (commit walks), ${rest} the rest ${summary(all)}`,
      })
      expect(rest, summary(all)).toBeLessThanOrEqual(COLD_BUDGET)
      expect(columnish.length).toBeLessThanOrEqual(COLUMN_WALK_MAX)
      await shot(page, 'pb-04-preact-home-cold')
      await context.close()
    })
  })
})

/**
 * Whether a request is one read-ahead block of a history walk: a `chunk` read of 17-19 seqs
 * (256 KiB / 14,700 B per chunk). The locator is read 100 seqs at a time, an object alone 1-2.
 */
function blockSized(body: Buffer | null): boolean {
  const q = decodeDocumentsRequest(body)
  if (q?.documentType !== 'chunk') return false
  const seqs = q.where.find((w) => w.field === 'seq')?.inCount ?? 0
  return seqs >= 17 && seqs <= 19
}
