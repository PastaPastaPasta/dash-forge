import { test, expect, type Page } from '@playwright/test'
import { collectPageErrors, countDapi, DAPI_RESEND_SLACK, idOrEmpty, shot, signedIn } from './helpers'
import { quorumGuard } from './quorum-sync'

/**
 * CI re-runs from a pull request's Checks tab (P1-8; event kind 26, forge-v2.md §3.3), on a repo
 * of the spec's own whose PR head forge-runner already reported (docs/guides/self-host-runner.md):
 *
 *   E2E_RERUN_OWNER=<owner id> E2E_RERUN_REPO=<name> E2E_RERUN_PR=<n> \
 *   E2E_RERUN_CHECK='CI / flaky (pull_request)' E2E_IDENTITY_DIR=<dir> E2E_DEVNET=sakura \
 *   pnpm exec playwright test ci-rerun.spec.ts
 *
 * `E2E_IDENTITY_DIR` holds `WRITER` (a role-1 writer of the repo) and `TRIAGE` (a triage member).
 * Writes one event: the writer's re-run request for `E2E_RERUN_CHECK`. Signed out, the tab must
 * load within S-1's cold budget: the requests ride the PR's target log, which it reads anyway.
 */

const OWNER = process.env['E2E_RERUN_OWNER'] ?? ''
const REPO = process.env['E2E_RERUN_REPO'] ?? ''
const PR = process.env['E2E_RERUN_PR'] ?? ''
const CHECK = process.env['E2E_RERUN_CHECK'] ?? ''
const WRITER = idOrEmpty('WRITER')
const TRIAGE = idOrEmpty('TRIAGE')

/** S-1's cold page budget (pulls-budget.spec.ts `COLD_BUDGET`). */
const COLD_BUDGET = 25

test.skip(OWNER === '' || REPO === '' || PR === '' || CHECK === '', 'set E2E_RERUN_OWNER, E2E_RERUN_REPO, E2E_RERUN_PR and E2E_RERUN_CHECK')
test.beforeEach(quorumGuard)

const checksUrl = (): string => `/repo/pull/?owner=${OWNER}&name=${REPO}&number=${PR}&tab=checks`
const row = (page: Page, name: string) => page.getByTestId('pr-checks').locator(`[data-testid=check-run][data-name="${name}"]`)

test('rerun. signed out: the checks are listed, nothing to re-run, within the cold budget', async ({ page }) => {
  test.setTimeout(180_000)
  const { errors } = collectPageErrors(page)
  const dapi = countDapi(page)
  await page.goto(checksUrl(), { waitUntil: 'domcontentloaded' })
  await expect(row(page, CHECK)).toBeVisible({ timeout: 90_000 })
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined)
  await expect(page.getByTestId('check-rerun')).toHaveCount(0)
  await expect(page.getByTestId('checks-rerun-all')).toHaveCount(0)
  const total = [...dapi.values()].reduce((a, b) => a + b, 0)
  test.info().annotations.push({ type: 'dapi', description: `${total} ${JSON.stringify(Object.fromEntries(dapi))}` })
  expect(total).toBeLessThanOrEqual(COLD_BUDGET + DAPI_RESEND_SLACK)
  expect(errors).toEqual([])
})

test('rerun. a triage member is offered no re-run', async ({ browser }) => {
  test.skip(TRIAGE === '', 'E2E_IDENTITY_DIR has no TRIAGE identity')
  test.setTimeout(300_000)
  const page = await signedIn(browser, 'TRIAGE', checksUrl())
  await expect(row(page, CHECK)).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId('check-rerun')).toHaveCount(0)
  await expect(page.getByTestId('checks-rerun-all')).toHaveCount(0)
  await page.context().close()
})

test('rerun. a writer asks for one check again; the tab shows it requested', async ({ browser }) => {
  test.skip(WRITER === '', 'E2E_IDENTITY_DIR has no WRITER identity')
  test.setTimeout(420_000)
  const page = await signedIn(browser, 'WRITER', checksUrl())
  const { errors } = collectPageErrors(page)
  await expect(row(page, CHECK)).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId('checks-rerun-all')).toBeVisible()
  await row(page, CHECK).getByRole('button', { name: `Re-run ${CHECK}` }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(`Re-run ${CHECK}`)
  await expect(dialog.getByTestId('cost-preview')).toBeVisible()
  await shot(page, 'rerun-confirm')
  await dialog.getByRole('button', { name: /sign & request re-run/i }).click()
  await expect(dialog).toBeHidden({ timeout: 180_000 })
  await expect(row(page, CHECK).getByTestId('check-rerun-pending')).toContainText('Re-run requested', { timeout: 120_000 })
  await expect(row(page, CHECK).getByTestId('check-rerun')).toHaveCount(0)
  await shot(page, 'rerun-requested-desktop-light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(row(page, CHECK).getByTestId('check-rerun-pending')).toBeVisible()
  await shot(page, 'rerun-requested-390-dark')
  expect(errors).toEqual([])
  await page.context().close()
})
