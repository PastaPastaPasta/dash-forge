import { test, expect, type Page } from '@playwright/test'
import { atRoute, DEMO, ownerIs, repoUrl, waitForRepoResolved } from './helpers'
import { quorumGuardLong, quorumHeldMs } from './quorum-sync'

// Not inside bonsia's quorum-service lag (#212): these specs count requests or read Verification.
test.beforeEach(quorumGuardLong)

/**
 * FG-8 (the dash showcase QA ledger): the app shell's resilience and chrome, read-only against
 * the moutai read fixture (e2e/helpers.ts `DEMO`). Nothing is written.
 *
 *  - L-10: going offline in the middle of a repo's reads never reads as tampering: the
 *    Verification card never says an object failed its hash check, and once back online the
 *    page loads and the card returns to Verified without a reload.
 *  - L-56: a tab opened while offline shows a plain offline state (no gRPC text on its face)
 *    and loads by itself once the connection is back.
 *  - L-59 / L-60: per-page titles; the repo home has an h1.
 *  - L-61: `owner/name` that is not a Forge repo offers the repos with that name.
 *  - L-62: a signed-out Star opens "Sign in to star this repo" with its cost.
 *  - L-82: an owner written as a DPNS name in a short URL expands.
 *
 * The phone chrome (L-57 drawer, L-58 chips) is in `mobile-shell.mobile.spec.ts`.
 */

const README = (page: Page) => page.getByRole('link', { name: 'README.md' }).first()
const summary = (page: Page) => page.getByTestId('verification-summary')

test.describe('shell resilience (L-10, L-56)', () => {
  test('offline mid-load: no false hash failure, and the page recovers by itself once online', async ({ page, context }) => {
    test.setTimeout(4 * 60_000 + quorumHeldMs())
    await page.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    // Drop the connection while the home's reads are in flight (the file list, README, commit
    // column), as the QA pass did 2.5 s into the load.
    await page.waitForTimeout(1_500)
    await context.setOffline(true)
    await page.waitForTimeout(8_000)
    const offlineText = await page.locator('main').innerText()
    expect(offlineText).not.toMatch(/did not match their git hash/)
    await context.setOffline(false)

    // Back online: the page finishes loading with no reload, and the card is Verified.
    await expect(README(page)).toBeVisible({ timeout: 90_000 })
    await expect(summary(page)).toContainText('Verified', { timeout: 60_000 })
    await expect(summary(page)).not.toContainText('Failed')
    await expect(summary(page)).toContainText('checked this session')
    await page.getByRole('button', { name: /Verification/ }).click()
    await expect(page.getByText(/did not match their git hash/)).toHaveCount(0)
  })

  test('a tab opened offline: a plain offline state, then it loads by itself', async ({ page, context }) => {
    test.setTimeout(4 * 60_000 + quorumHeldMs())
    await page.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await context.setOffline(true)
    await page.getByRole('navigation', { name: 'Repository' }).getByRole('link', { name: /^Pull requests/ }).click()
    // Whatever happens first, it says so plainly: the click held with a toast (a page this tab
    // has no data for), or the page's offline state (the list's read, the repo resolve, its
    // code). Never a blank "Application error" or raw gRPC text.
    const offline = page
      .getByText("You're offline")
      .or(page.getByTestId('read-unreachable'))
      .or(page.getByTestId('platform-unreachable'))
      .first()
    await expect(offline).toBeVisible({ timeout: 60_000 })
    // The raw error is only behind the collapsed Details: nothing visible reads as gRPC internals.
    await expect(page.getByText(/grpc error|That read did not land|Application error/i).filter({ visible: true })).toHaveCount(0)
    await context.setOffline(false)
    await expect(page).toHaveURL(atRoute(/\/repo\/pulls\//), { timeout: 60_000 })
    await expect(page.getByTestId('read-unreachable').or(page.getByTestId('app-offline'))).toHaveCount(0, { timeout: 90_000 })
    await expect(page.getByRole('heading', { name: /pull requests/i }).or(page.getByText(/No pull requests|open/i)).first()).toBeVisible({ timeout: 60_000 })
  })
  test('a list read that fails offline (its code already loaded): the offline state, then it loads', async ({ page, context }) => {
    test.setTimeout(4 * 60_000 + quorumHeldMs())
    await page.goto(repoUrl('pulls'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(page.getByRole('link', { name: 'New pull request' })).toBeVisible({ timeout: 60_000 })
    // Issues' code loads now (the tab link prefetches it); only its data read will fail.
    await page.goto(repoUrl('issues'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await page.goto(repoUrl('pulls'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await page.waitForTimeout(2_000)
    await context.setOffline(true)
    await page.getByRole('navigation', { name: 'Repository' }).getByRole('link', { name: /^Issues/ }).click()
    await page.waitForTimeout(10_000)
    // Never the browser's own "no internet" page: the app is still there, saying it is offline.
    await expect(page.getByRole('heading', { level: 1 }).or(page.getByTestId('read-unreachable')).first()).toBeVisible()
    // The raw error is only behind the collapsed Details: nothing visible reads as gRPC internals.
    await expect(page.getByText(/grpc error|That read did not land|Application error/i).filter({ visible: true })).toHaveCount(0)
    await context.setOffline(false)
    // The list this tab already read is shown from the session cache, or read again once back.
    await expect(page.getByText('README should explain the event split').first()).toBeVisible({ timeout: 90_000 })
    await expect(page.getByTestId('read-unreachable')).toHaveCount(0)
  })
})

test.describe('titles, headings and short links', () => {
  test('per-page <title>s and a repo h1 (L-59, L-60)', async ({ page }) => {
    await page.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    const h1 = page.getByRole('heading', { level: 1 })
    await expect(h1).toHaveCount(1)
    await expect(h1).toContainText(DEMO.name)
    await expect(page).toHaveTitle(new RegExp(`/${DEMO.name} · Dash Forge$`))
    await page.getByRole('navigation', { name: 'Repository' }).getByRole('link', { name: /^Issues/ }).click()
    await expect(page).toHaveTitle(new RegExp(`^Issues · .*/${DEMO.name} · Dash Forge$`))
    await page.goto('/explore/', { waitUntil: 'domcontentloaded' })
    await expect(page).toHaveTitle('Explore · Dash Forge')
  })

  test('"dashpay/dash" style addresses offer the repos with that name (L-61)', async ({ page }) => {
    await page.goto(`/repo/?owner=nobody-here-${Date.now()}&name=${DEMO.name}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('Repo not found')).toBeVisible({ timeout: 90_000 })
    const list = page.getByTestId('repo-suggestions')
    await expect(list).toBeVisible({ timeout: 60_000 })
    await expect(list.getByRole('link', { name: DEMO.name }).first()).toBeVisible()
  })

  test('Copy link and DPNS-form short URLs land on the repo (L-55, L-82)', async ({ page }) => {
    await page.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    const href = String(await page.getByTestId('copy-link').first().getAttribute('data-href'))
    await page.goto(new URL(href).pathname + new URL(href).search, { waitUntil: 'domcontentloaded' })
    await expect(page).toHaveURL(atRoute(new RegExp(`/repo/\\?${await ownerIs(DEMO.owner)}&name=${DEMO.name}`)))
    await expect(README(page)).toBeVisible({ timeout: 90_000 })
  })
})

test.describe('signed-out writes (L-62)', () => {
  test('Star names the action and its cost', async ({ page }) => {
    await page.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await page.getByRole('button', { name: /^Star/ }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Sign in to star this repo' })).toBeVisible({ timeout: 30_000 })
    await expect(dialog.getByTestId('signin-intent')).toContainText(/about 0\.000\d+ DASH/)
    // The create tile quotes what the New issue form previews, not the stale 0.00062.
    await expect(dialog.getByTestId('tile-create')).not.toContainText('0.00062')
  })
})
