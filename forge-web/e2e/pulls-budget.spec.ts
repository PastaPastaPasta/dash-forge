import { test, expect, type Browser, type Page, type Request } from '@playwright/test'
import { collectPageErrors, DAPI_METHOD, decodeDocumentsRequest, E2E_DEVNET, loadSeedPulls, repoUrl, shot, showcaseRepo, waitForRepoResolved } from './helpers'
import { quorumGuard } from './quorum-sync'

// Not inside bonsia's quorum-service lag (#212): these specs count requests or read Verification.
test.beforeEach(quorumGuard)

/**
 * L-44 / L-77: the PR list and PR detail, cold, within S-1's page budget (≤ 25 DAPI requests,
 * every kind counted at the network, in a fresh browser context), on the read fixture and on the
 * dashpay/dash mirror (the largest PR list on the chain, 100+ PRs):
 *
 *   E2E_DEVNET=bonsia pnpm exec playwright test pulls-budget.spec.ts
 *
 * Each test annotates its count and a per-type breakdown, so a regression names its reads
 * (`E2E_TRACE=1` adds the request order).
 *
 * Measured before the pull index, on moutai beta.6 (2026-09-29): fixture list 10, PR #2 17;
 * dash list 21, PR #7762 31. moutai then moved to beta.7, which master's JS cannot read: the
 * after-counts run on bonsia once the fixtures and the dash mirror are there (the showcase block
 * skips itself on a devnet where the mirror's name does not resolve).
 */

/** S-1's cold page budget. */
const COLD_BUDGET = 25
/**
 * QW3-002: what the dash Open tab adds to find every open PR its count reports, by the state scan:
 * one light `transition` read per 100 state changes above the oldest open PR, and a read by number
 * every few of them. Like the commit column's walk (`page-budget.spec.ts` COLUMN_WALK_MAX) it grows
 * with how deep that PR sits, not with the repo; tracked apart from S-1. bonsia, 2026-09-30: the
 * oldest open PR (#4604) sat 1,011 numbers below the newest, 12 scan reads and 3 by number.
 */
const OPEN_SCAN_MAX = 20

type Row = { readonly method: string; readonly type: string }

/** Requests `page` sends to DAPI from now on, each with its method and (documents) type. */
function recordDapi(page: Page): { readonly all: () => Row[] } {
  const seen: Row[] = []
  page.on('request', (r: Request) => {
    const method = DAPI_METHOD.exec(r.url())?.[1]
    if (method === undefined) return
    const q = method === 'getDocuments' ? decodeDocumentsRequest(r.postDataBuffer()) : null
    const where = q?.where.map((w) => (w.inCount === null ? w.field : `${w.field}[${w.inCount}]`)).join(',') ?? ''
    seen.push({ method, type: method === 'getDocuments' ? `${q?.documentType ?? '?'}${where === '' ? '' : `(${where})`}` : '' })
  })
  return { all: () => seen }
}

const summary = (rows: readonly Row[]): string => {
  const by = new Map<string, number>()
  for (const r of rows) {
    const k = r.type === '' ? r.method : `${r.method}:${r.type}`
    by.set(k, (by.get(k) ?? 0) + 1)
  }
  return JSON.stringify(Object.fromEntries([...by].sort((a, b) => b[1] - a[1])))
}

/** Wait for the page's trailing reads (counts, rail, tabs) to go out and settle. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined)
  await page.waitForTimeout(2_500)
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
}

const prRows = (page: Page) => page.locator('main a[href*="/repo/pull/"][href*="number="]')

/** Open `path` cold in a fresh context, wait for `ready`, settle, and return the requests. */
async function cold(
  browser: Browser,
  label: string,
  url: string,
  ready: (page: Page) => Promise<void>,
): Promise<{ rows: Row[]; page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext()
  const page = await context.newPage()
  const { errors } = collectPageErrors(page)
  const dapi = recordDapi(page)
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page)
  await ready(page)
  await settle(page)
  const rows = dapi.all()
  test.info().annotations.push({ type: 'dapi', description: `${label}: ${rows.length} ${summary(rows)}` })
  if (process.env['E2E_TRACE']) test.info().annotations.push({ type: 'order', description: rows.map((r) => r.type || r.method).join(' > ') })
  expect(errors, errors.join('\n')).toEqual([])
  return { rows, page, close: () => context.close() }
}

const listReady = async (page: Page): Promise<void> => {
  await expect(prRows(page).first()).toBeVisible({ timeout: 90_000 })
}
/** The Open tab once it has found every open PR (its state scan's note gone). */
const openSettled = async (page: Page): Promise<void> => {
  await listReady(page)
  await expect(page.getByRole('status').filter({ hasText: 'Finding the older' })).toHaveCount(0, { timeout: 180_000 })
}
const detailReady = async (page: Page): Promise<void> => {
  await expect(page.locator('main h1').first()).toBeVisible({ timeout: 90_000 })
}

test.describe('PR request budget (L-77)', () => {
  test('prb-1. the fixture: the PR list and a PR, cold, ≤ 25 each', async ({ browser }) => {
    const list = await cold(browser, 'fixture PR list', repoUrl('pulls'), listReady)
    expect(list.rows.length, summary(list.rows)).toBeLessThanOrEqual(COLD_BUDGET)
    await shot(list.page, 'prb-01-fixture-pulls-cold')
    await list.close()

    // The merged PR (#2 before numbering became dense; the seed summary names it now).
    const merged = loadSeedPulls().merged
    const detail = await cold(browser, `fixture PR #${merged}`, repoUrl('pull', `&number=${merged}`), detailReady)
    expect(detail.rows.length, summary(detail.rows)).toBeLessThanOrEqual(COLD_BUDGET)
    await shot(detail.page, 'prb-02-fixture-pull-cold')
    await detail.close()
  })

  test.describe('showcase repos', () => {
    /**
     * QW2-002: every tab of the largest PR list on the chain, cold, within the budget however many
     * PRs the mirror holds (bonsia, 2026-09-30: 1,766 PRs, 1 open; the list read all of them on
     * every load, 55 requests for Open and 66–75 for Merged). The list reads the newest chunks
     * until the page is full or the tab's proved count is reached, at most three per load.
     */
    test('prb-2. the dash mirror: every PR tab and PR #7762, cold, ≤ 25 each', async ({ browser }) => {
      const dash = await showcaseRepo('DASHPAY', 'dash').catch(() => null)
      test.skip(dash === null, `the dash mirror is not imported on ${E2E_DEVNET}`)
      if (dash === null) return
      const list = await cold(browser, 'dash PR list', repoUrl('pulls', '', dash), openSettled)
      // QW3-002: the Open tab lists every open PR its count reports (dash's few open PRs sit
      // anywhere in thousands of merged ones), with no "Look through older" to press.
      const open = Number((await list.page.getByRole('tab', { name: /^[\d,]+ Open$/ }).textContent())?.replace(/[^\d]/g, ''))
      if (open <= 25) await expect(prRows(list.page)).toHaveCount(open)
      await expect(list.page.getByRole('button', { name: /Look through older/ })).toHaveCount(0)
      // The scan's reads: `transition` by repo, newest first (`$createdAt <=` its watermark after the first).
      const scan = list.rows.filter((r) => r.type === 'transition(repoId)' || r.type === 'transition(repoId,$createdAt)').length
      expect(list.rows.length - scan, summary(list.rows)).toBeLessThanOrEqual(COLD_BUDGET)
      expect(scan, summary(list.rows)).toBeLessThanOrEqual(OPEN_SCAN_MAX)
      // L-44: the list pages past 100 and counts every tab (digit-grouped, QW3-058), instead of stopping at 100 silently.
      await expect(list.page.getByRole('tab', { name: /^[\d,]+ Merged$/ })).toBeVisible()
      await expect(list.page.getByRole('tab', { name: /^[\d,]+ Closed$/ })).toBeVisible()
      await expect(list.page.getByRole('tab', { name: /^\d{1,3}(,\d{3})+ Merged$/ })).toBeVisible()
      await list.page.getByRole('tab', { name: 'All', exact: true }).click()
      await expect(list.page.getByTestId('page-indicator')).toContainText(/Page 1 of ([5-9]|\d{2,})/, { timeout: 60_000 })
      await shot(list.page, 'prb-03-dash-pulls-cold')
      await list.close()

      // The other tabs, each cold in a context of its own: the same budget, and the proved page count.
      for (const state of ['merged', 'closed', 'all'] as const) {
        const tab = await cold(browser, `dash PR list, ${state}`, repoUrl('pulls', `&state=${state}`, dash), listReady)
        expect(tab.rows.length, summary(tab.rows)).toBeLessThanOrEqual(COLD_BUDGET)
        await expect(tab.page.getByTestId('page-indicator')).toContainText(/Page 1 of \d+/, { timeout: 60_000 })
        await shot(tab.page, `prb-03-dash-pulls-${state}-cold`)
        await tab.close()
      }

      // QW3-004 / QW3-019: a sort by comments and a search read one load's worth, show it, and say
      // how far they read ("Look through older" reads on), rather than reading thousands of PRs first.
      for (const [label, extra] of [
        ['most commented', '&state=all&sort=comments'],
        ['search', '&q=is%3Apr+is%3Amerged+masternode'],
      ] as const) {
        const tab = await cold(browser, `dash PR list, ${label}`, repoUrl('pulls', extra, dash), listReady)
        expect(tab.rows.length, summary(tab.rows)).toBeLessThanOrEqual(COLD_BUDGET)
        await expect(tab.page.getByTestId('list-read-budget').or(tab.page.getByText(/^Searched the newest/))).toBeVisible()
        await shot(tab.page, `prb-03-dash-pulls-${label.replace(/ /g, '-')}-cold`)
        await tab.close()
      }

      const detail = await cold(browser, 'dash PR #7762', repoUrl('pull', '&number=7762', dash), detailReady)
      expect(detail.rows.length, summary(detail.rows)).toBeLessThanOrEqual(COLD_BUDGET)
      await shot(detail.page, 'prb-04-dash-pull-cold')
      await detail.close()
    })
  })
})
