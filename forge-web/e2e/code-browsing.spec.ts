import { test, expect } from '@playwright/test'
import { collectPageErrors, repoUrl, shot, waitForRepoResolved } from './helpers'

/**
 * Code browsing on the showcase repos (preact, ripgrep, requests, dips) imported on moutai:
 *
 *   E2E_DEVNET=moutai pnpm exec playwright test code-browsing.spec.ts
 *
 * Their code and releases are stable; their collaboration data (issues, PRs) is re-imported
 * from time to time, so nothing here depends on a PR number.
 */

const PREACT = { owner: 'qrUbjpBNDWpFscytpp8w9Uw87DV7hSzH5CW7ux9ERCz', name: 'preact' } as const

/** A 7-file preact commit that hung on 4 of 4 loads before D-005 was fixed. */
const MULTI_FILE_COMMIT = '8101ff821690817c7786739c317af215c62a0cff'

test.describe('code browsing (showcase repos)', () => {
  test('cb-1. a multi-file commit diff finishes loading every file (D-005)', async ({ page }) => {
    const errors = collectPageErrors(page)
    // Several fresh loads: the lost-patch race did not fire on every one.
    for (let i = 0; i < 3; i++) {
      await page.goto(repoUrl('commit', `&oid=${MULTI_FILE_COMMIT}`, PREACT), { waitUntil: 'domcontentloaded' })
      await waitForRepoResolved(page)
      await expect(page.getByText(/7 files changed/)).toBeVisible({ timeout: 60_000 })
      await expect(page.getByText('Reading file', { exact: true })).toHaveCount(0, { timeout: 20_000 })
      await expect(page.getByText(/line counts cover/)).toHaveCount(0)
    }
    await shot(page, 'cb-01-commit-all-files')
    expect(errors.errors).toEqual([])
  })

  test('cb-2. a commit URL with a 7-character id resolves by prefix (D-057)', async ({ page }) => {
    await page.goto(repoUrl('commit', `&oid=${MULTI_FILE_COMMIT.slice(0, 7)}`, PREACT), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(page.getByText(/7 files changed/)).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText(/even length/)).toHaveCount(0)
  })

  test('cb-3. bad commit ids say what is wrong instead of a raw hex error (D-057)', async ({ page }) => {
    await page.goto(repoUrl('commit', '&oid=zzzz', PREACT), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(page.getByRole('heading', { name: 'Not a commit id' })).toBeVisible({ timeout: 60_000 })
    await page.goto(repoUrl('commit', '&oid=0000000', PREACT), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(page.getByRole('heading', { name: 'Commit not found' })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText(/even length|not in locator/)).toHaveCount(0)
  })
})
