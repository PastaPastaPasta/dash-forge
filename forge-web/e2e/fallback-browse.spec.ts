import { test, expect } from '@playwright/test'
import { collectPageErrors, readErrorBanner, repoUrl, shot, waitForRepoResolved } from './helpers'

/**
 * In-browser fallback clone (no objectLocator). The M1 fixture repo has never published a
 * browse plane, so the repo home must engage the fallback: download the live kind-0 packs
 * from platform `chunk` documents, index them client-side, and serve the root tree/README
 * from the locally built index. Small repos (≤ 2 MB of live packs) auto-load; larger ones
 * surface an explicit "Load repo in browser (~X MB)" action — the spec handles both.
 * In-app navigation afterwards must reuse the session-cached context (no second prompt).
 */

test.describe('in-browser fallback clone (no objectLocator)', () => {
  test('repo home clones + indexes in-browser, then navigation reuses the cache', async ({
    page,
  }) => {
    const { errors } = collectPageErrors(page)
    await page.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)

    // The fallback must engage: auto-load progress, the explicit load action, or (already
    // done) the local-index notice. The app's read-error state is a meaningful failure.
    const loadButton = page.getByRole('button', { name: /load repo in browser/i })
    const engaged = page
      .getByText(/preparing in-browser clone|downloading packs|indexing objects|copy loaded into your browser/i)
      .first()
    await expect(loadButton.or(engaged).or(readErrorBanner(page))).toBeVisible({ timeout: 45_000 })
    if (await readErrorBanner(page).isVisible()) {
      throw new Error(
        'Repo home is in the read-error state before the fallback could engage — ' +
          'manifest/chunk reads are failing against testnet.',
      )
    }
    if (await loadButton.isVisible().catch(() => false)) {
      await loadButton.click() // > 2 MB of live packs: the explicit opt-in path
    }

    // The fallback completes: quiet notice + a real root tree (file links) rendered from
    // the locally built index.
    await expect(page.getByText(/copy loaded into your browser/i)).toBeVisible({ timeout: 60_000 })
    const fileLink = page.locator('a[href*="/repo/blob"], a[href*="/repo/tree"]').first()
    await expect(fileLink).toBeVisible({ timeout: 30_000 })
    await shot(page, '08-fallback-home')

    // In-app navigation (SPA route change) reuses the module-level session cache: content
    // renders again with no re-download prompt.
    await fileLink.click()
    await expect(page.getByText(/copy loaded into your browser/i)).toBeVisible({ timeout: 30_000 })
    await expect(loadButton).toHaveCount(0)
    await shot(page, '09-fallback-blob')

    expect(errors, `uncaught page errors:\n${errors.join('\n')}`).toEqual([])
  })
})
