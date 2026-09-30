import { test, expect, type Page } from '@playwright/test'
import { collectPageErrors, countDapi, E2E_DEVNET, repoUrl, shot, showcaseRepo, waitForRepoResolved } from './helpers'
import { quorumGuard } from './quorum-sync'

// Not inside bonsia's quorum-service lag (#212): these specs count requests or read Verification.
test.beforeEach(quorumGuard)

/**
 * FG-5 on the dashpay/dash showcase mirror, read-only, with request and time budgets:
 *
 *   E2E_DEVNET=bonsia pnpm exec playwright test fg5-dash.spec.ts
 *
 * - fg5-1: the 747-file merge f5979f7c5: whole-commit totals equal `git diff --shortstat`
 *   (+1331 −1906, L-25) once "Count lines" has read every file, and the Tree-SHA512 trailer wraps
 *   (L-68).
 * - fg5-2: f1be1b800 moved three completion scripts: 69 files, the moves as renames (L-24), with
 *   the author and committer (L-26).
 * - fg5-3: compare v22.0.0...develop (a tag with a branch, L-30): 6,308 commits and the diff from
 *   their merge base 7f28292.
 *
 * The expected numbers are git's on the mirrored history (see lib/view/dash-compare.local.test.ts,
 * which checks the same code against a local clone). Budgets are env-overridable: the mirror's
 * storage and the node set change between devnets.
 */

const F5979 = 'f5979f7c56da7bee6ce9bb0b7b21fd2c3d745b61'
const F1BE = 'f1be1b800cec7886973750a76b473542fa145347'
/** DAPI requests for the 747-file merge's first screen (measured before FG-5: 113). */
const MERGE_OPEN_DAPI = Number(process.env['E2E_FG5_MERGE_OPEN_DAPI'] ?? 140)
/** DAPI requests for counting every one of its 747 files (each file's two blobs are ranged reads). */
const MERGE_COUNT_DAPI = Number(process.env['E2E_FG5_MERGE_COUNT_DAPI'] ?? 900)
/** DAPI requests and time for compare v22.0.0...develop (New PR master...develop measured 124 requests, 18 s). */
const COMPARE_DAPI = Number(process.env['E2E_FG5_COMPARE_DAPI'] ?? 400)
const COMPARE_MS = Number(process.env['E2E_FG5_COMPARE_MS'] ?? 90_000)

const total = (counts: Map<string, number>): number => [...counts.values()].reduce((a, n) => a + n, 0)
const note = (label: string, counts: Map<string, number>, ms: number): void => {
  test.info().annotations.push({ type: 'budget', description: `${label}: ${total(counts)} DAPI requests in ${ms} ms ${JSON.stringify(Object.fromEntries(counts))}` })
}
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
}

test.describe('FG-5 on the dash mirror (read-only)', () => {
  test.skip(E2E_DEVNET !== 'moutai' && E2E_DEVNET !== 'bonsia', 'the dash showcase mirror is imported on the live devnet')
  let DASH: { readonly owner: string; readonly name: string }
  test.beforeAll(async () => {
    const dash = await showcaseRepo('DASHPAY', 'dash').catch((e: unknown) => {
      // helpers.ts `showcaseRepo`: the name does not resolve = no mirror here. Anything else fails.
      if (e instanceof Error && e.message.includes('does not resolve')) return null
      throw e
    })
    test.skip(dash === null, `the dash mirror is not imported on ${E2E_DEVNET}`)
    DASH = dash as NonNullable<typeof dash>
  })

  test('fg5-1. the 747-file merge: whole-commit totals equal git, within a request budget', async ({ browser }) => {
    test.setTimeout(600_000)
    const page = await (await browser.newContext()).newPage()
    const { errors } = collectPageErrors(page)
    const counts = countDapi(page)
    const t0 = Date.now()
    await page.goto(repoUrl('commit', `&oid=${F5979}`, DASH), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(page.getByText('747 files changed')).toBeVisible({ timeout: 120_000 })
    // No partial totals: a 747-file change is counted on request.
    await expect(page.getByTestId('diff-totals')).toHaveCount(0)
    const body = page.getByTestId('commit-body')
    expect(await body.evaluate((el) => el.scrollWidth - el.clientWidth), 'Tree-SHA512 overflow (L-68)').toBeLessThanOrEqual(0)
    await settle(page)
    note('open', counts, Date.now() - t0)
    expect(total(counts), JSON.stringify(Object.fromEntries(counts))).toBeLessThanOrEqual(MERGE_OPEN_DAPI)
    await shot(page, 'fg5-01-merge-open')

    const before = total(counts)
    const t1 = Date.now()
    await page.getByTestId('count-lines').click()
    await expect(page.getByTestId('diff-totals')).toContainText(/\+1331\s*−1906/, { timeout: 480_000 })
    note('count all 747', counts, Date.now() - t1)
    expect(total(counts) - before).toBeLessThanOrEqual(MERGE_COUNT_DAPI)
    await shot(page, 'fg5-01-merge-totals')
    expect(errors, errors.join('\n')).toEqual([])
  })

  test('fg5-2. a commit that moves files lists them as renames; author and committer', async ({ page }) => {
    const { errors } = collectPageErrors(page)
    await page.goto(repoUrl('commit', `&oid=${F1BE}`, DASH), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(page.getByText('69 files changed')).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText('contrib/completions/bash/dash-cli.bash-completion').first()).toBeVisible()
    await expect(page.locator('span[title="renamed (100% similar)"]')).toHaveCount(6) // 3 in the list, 3 headers
    await expect(page.getByTestId('diff-totals')).toContainText(/\+1264\s*−789/, { timeout: 240_000 })
    await expect(page.getByTestId('commit-byline').locator('time')).not.toHaveCount(0)
    await shot(page, 'fg5-02-renames')
    expect(errors, errors.join('\n')).toEqual([])
  })

  test('fg5-3. compare v22.0.0...develop: commits and diff from the merge base, within budget', async ({ browser }) => {
    test.setTimeout(300_000)
    const page = await (await browser.newContext()).newPage()
    const { errors } = collectPageErrors(page)
    const counts = countDapi(page)
    const t0 = Date.now()
    await page.goto(repoUrl('compare', '&base=v22.0.0&head=develop', DASH), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    const summary = page.getByTestId('compare-summary')
    await expect(summary).toContainText('6,308 commits', { timeout: COMPARE_MS })
    await expect(summary).toContainText('7f28292')
    const ms = Date.now() - t0
    await settle(page)
    note('compare v22.0.0...develop', counts, ms)
    expect(ms).toBeLessThan(COMPARE_MS)
    expect(total(counts), JSON.stringify(Object.fromEntries(counts))).toBeLessThanOrEqual(COMPARE_DAPI)
    // A tag is not a branch: no "Create pull request" (base and head must be branches).
    await expect(page.getByTestId('compare-create-pr')).toHaveCount(0)
    await shot(page, 'fg5-03-compare-v22-develop')
    expect(errors, errors.join('\n')).toEqual([])
  })
})
