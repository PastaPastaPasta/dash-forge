import { test, expect } from '@playwright/test'
import {
  M1,
  repoUrl,
  shot,
  collectPageErrors,
  waitForRepoResolved,
  readErrorBanner,
} from './helpers'

/**
 * Logged-out read-path scenarios (no keys required). These exercise the deployed foundry
 * design against real Dash Platform testnet data via the lazily-loaded WASM SDK.
 *
 * NOTE (observed 2026-07): the app connects to testnet and the DAPI `getDocuments` HTTP calls
 * return 200, but the proof-verified read (`queryWithProof`) currently rejects with a
 * wasm-bindgen error object, so data does NOT render — the app shows its "That read did not
 * land" state. Scenarios that require live data therefore fail *by design*, documenting the
 * bug; they will pass once the read path is fixed. See the run report for the root cause.
 */

test.describe('logged-out read paths', () => {
  test('1. landing renders the foundry hero, header, and testnet badge', async ({ page }) => {
    const { errors } = collectPageErrors(page)
    await page.goto('/', { waitUntil: 'domcontentloaded' })

    // Foundry hero headline.
    await expect(page.getByRole('heading', { name: /no server to trust/i })).toBeVisible()

    // Header chrome: wordmark link, network badge, sign-in affordance, search.
    await expect(page.locator('header a[href="/"]').first()).toBeVisible()
    await expect(page.getByText('testnet', { exact: false }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible()
    await expect(page.getByPlaceholder(/Jump to owner/i)).toBeVisible()

    // The signature verification chip is present on the landing hero.
    await expect(page.getByRole('group', { name: /verification status/i })).toBeVisible()

    // Give the SDK a moment to attempt connecting (discovery feed), then snapshot.
    await page.waitForTimeout(6000)
    await shot(page, '01-landing')

    // No fatal page errors (uncaught exceptions that break rendering).
    expect(errors, `uncaught page errors:\n${errors.join('\n')}`).toEqual([])
  })

  test('2. repo home hydrates real testnet data with trust panel + clone box', async ({ page }) => {
    await page.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)

    // Race the success signal (repo name in the header) against the app's read-error state so
    // the test fails fast with a meaningful message instead of a 30s timeout.
    const nameLoc = page.getByText(M1.name, { exact: false }).first()
    await expect(nameLoc.or(readErrorBanner(page))).toBeVisible({ timeout: 30_000 })
    await shot(page, '02-repo-home')

    if (await readErrorBanner(page).isVisible()) {
      throw new Error(
        'Repo home did not render real testnet data — the app is showing its read-error state ' +
          '("That read did not land"). DAPI returns 200 but the proof-verified read rejects with a ' +
          'wasm-bindgen error object. Real data / branches / trust panel could not be asserted.',
      )
    }

    // Real data rendered — assert the required surfaces.
    await expect(nameLoc).toBeVisible()
    await expect(page.getByText(/\bmain\b/).first()).toBeVisible()
    await expect(page.getByText(`dash://${M1.owner}/${M1.name}`)).toBeVisible()
    await expect(page.getByText(/assay|proof|sha256|verif|trust/i).first()).toBeVisible()
  })

  test('3. issues list renders folded open/closed state', async ({ page }) => {
    await page.goto(repoUrl('issues'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)

    const openClosed = page.getByText(/\bOpen\b|\bClosed\b/i).first()
    const emptyState = page.getByText(/no (open )?issues/i).first()
    await expect(openClosed.or(emptyState).or(readErrorBanner(page))).toBeVisible({
      timeout: 30_000,
    })
    await shot(page, '03-issues')

    if (await readErrorBanner(page).isVisible()) {
      throw new Error(
        'Issues list did not render — app is in the read-error state (proof-verified read ' +
          'rejects with a wasm-bindgen error). Open/closed issue folding could not be asserted.',
      )
    }
    await expect(openClosed.or(emptyState)).toBeVisible()
  })

  test('4. tree browse reaches an honest terminal state (best-effort)', async ({ page }) => {
    // Best-effort: a real file listing, an honest "not indexed for browsing" degradation, OR the
    // app's honest read-error state (retry offered, no crash) all count as a non-crashing pass.
    const { errors } = collectPageErrors(page)
    await page.goto(repoUrl('tree'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)

    const fileListing = page.getByRole('link').filter({ hasText: /\.\w+$|src|lib|README/i })
    const degraded = page.getByText(
      /not indexed|no browse|degrad|object walk|browse artifact|cannot browse|unavailable/i,
    )
    await expect(
      fileListing.first().or(degraded.first()).or(readErrorBanner(page)),
    ).toBeVisible({ timeout: 30_000 })
    await shot(page, '04-tree')

    // Annotate which terminal state we actually observed (visibility into the real behavior).
    const state = (await fileListing.first().isVisible().catch(() => false))
      ? 'file-listing'
      : (await degraded.first().isVisible().catch(() => false))
        ? 'graceful-degradation'
        : 'read-error (honest, retryable)'
    test.info().annotations.push({ type: 'observed-state', description: state })

    // The one hard requirement: the page must not have crashed with an uncaught exception.
    expect(errors, `uncaught page errors:\n${errors.join('\n')}`).toEqual([])
  })

  test('7. landing is usable at a 375px mobile viewport with no horizontal overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/', { waitUntil: 'domcontentloaded' })

    await expect(page.getByRole('heading', { name: /no server to trust/i })).toBeVisible()
    // Header stays usable at mobile width: the icon-only home link and sign-in are reachable
    // (the "Dash Forge" wordmark text is intentionally hidden below the sm breakpoint).
    await expect(page.locator('header a[href="/"]').first()).toBeVisible()
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible()

    // Let the layout settle (feed skeleton → terminal state) before measuring.
    await page.waitForTimeout(5000)

    // No horizontal overflow: the document is not wider than the viewport.
    const overflow = await page.evaluate(() => {
      const de = document.documentElement
      return { scrollW: de.scrollWidth, clientW: de.clientWidth }
    })
    expect(
      overflow.scrollW,
      `horizontal overflow: scrollWidth ${overflow.scrollW} > clientWidth ${overflow.clientW}`,
    ).toBeLessThanOrEqual(overflow.clientW + 1)

    await shot(page, '07-landing-mobile')
  })
})
