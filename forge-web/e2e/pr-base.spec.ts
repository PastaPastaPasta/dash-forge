import { test, expect } from '@playwright/test'
import { EMPTY, repoUrl, shot, waitForRepoResolved } from './helpers'

/**
 * D-501: a pull request can only be opened against a branch the repo has. Read-only against
 * the devnet fixture (nothing is signed or written):
 *
 *   E2E_DEVNET=bonsia pnpm exec playwright test pr-base.spec.ts
 *
 * A `?base=` link (or a kept draft) naming a branch that does not exist used to leave the
 * create button live, and the resulting PR could later be "merged" by creating the branch.
 */

test.describe('new PR: the base must be an existing branch (D-501)', () => {
  test('pr-base-1. a base that is not a branch is refused before signing', async ({ page }) => {
    await page.goto(repoUrl('pulls/new', '&base=refs/heads/does-not-exist'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await page.getByLabel('Title', { exact: true }).fill('bad base')
    const alert = page.getByRole('alert').filter({ hasText: 'does-not-exist is not a branch of' })
    await expect(alert).toBeVisible()
    await expect(page.getByLabel('Base')).toHaveValue('refs/heads/does-not-exist')
    await expect(page.getByRole('button', { name: /create pull request|sign in to create/i })).toBeDisabled()
    await shot(page, 'pr-base-missing')

    // Picking a real branch clears it.
    await page.getByLabel('Base').selectOption('refs/heads/main')
    await expect(alert).toBeHidden()
    await expect(page.getByLabel('Base')).toHaveValue('refs/heads/main')
  })

  test('pr-base-2. a repo with no branches has nothing to open a PR against', async ({ page }) => {
    await page.goto(repoUrl('pulls/new', '', EMPTY), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await page.getByLabel('Title', { exact: true }).fill('nothing to merge into')
    await expect(page.getByRole('alert').filter({ hasText: 'has no branches yet' })).toBeVisible()
    await expect(page.getByRole('button', { name: /create pull request|sign in to create/i })).toBeDisabled()
    await shot(page, 'pr-base-empty-repo')
  })
})
