import { test, expect } from '@playwright/test'
import { atRoute, E2E_DEVNET, repoUrl, shot, showcaseRepo, waitForRepoResolved } from './helpers'

/**
 * FG-2 (dash showcase QA ledger): GitHub-fidelity Markdown on the dash mirror imported on
 * moutai. Read-only.
 *
 *   E2E_DEVNET=moutai pnpm exec playwright test markdown-fidelity.spec.ts
 */

let DASH: { readonly owner: string; readonly name: string }

test.describe('markdown fidelity (dash showcase mirror)', () => {
  test.skip(E2E_DEVNET !== 'moutai', 'the dash showcase mirror is imported on moutai')

  test.beforeAll(async () => {
    DASH = await showcaseRepo('DASHPAY', 'dash')
  })

  test('fg2-1. the dash README: setext headings, and root-relative links stay in the repo (L-03, L-12)', async ({ page }) => {
    await page.goto(repoUrl('', '', DASH), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    const readme = page.locator('section[aria-label="README"]')
    await expect(readme).toBeVisible({ timeout: 60_000 })
    await expect(readme.locator('#user-content-dash-core-staging-tree')).toHaveText('Dash Core staging tree')
    await expect(readme.locator('#user-content-what-is-dash')).toBeVisible()
    await expect(readme.locator('#user-content-license')).toBeVisible()
    await expect(readme).not.toContainText('=====')
    await expect(readme.locator('hr')).toHaveCount(0)
    // `/doc` is the doc/ tree and `/doc/build-unix.md` its blob; nothing links to a bare site path.
    const doc = readme.getByRole('link', { name: 'doc folder' })
    await expect(doc).toHaveAttribute('href', /\/repo\/tree\/\?.*path=doc(&|$)/, { timeout: 30_000 })
    await expect(readme.getByRole('link', { name: './doc/build-unix.md' })).toHaveAttribute('href', /\/repo\/blob\/\?.*path=doc%2Fbuild-unix\.md/)
    for (const href of await readme.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''))) {
      expect(href, href).not.toMatch(/^\/(doc|src|test|contrib)\b/)
    }
    await shot(page, 'fg2-01-dash-readme')
    await doc.click()
    await expect(page).toHaveURL(atRoute(/\/repo\/tree\/.*path=doc/))
    await expect(page.getByText('build-unix.md').first()).toBeVisible({ timeout: 60_000 })
  })

  test('fg2-2. imported issue #6935: comment-mode breaks, GitHub mentions (L-41, L-38)', async ({ page }) => {
    await page.goto(repoUrl('issue', '&number=6935', DASH), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    const body = page.locator('[data-tap-exempt="prose"]', { hasText: 'Backup freezes' }).first()
    await expect(body).toContainText('Backup freezes', { timeout: 60_000 })
    // "…export / Backup freezes… / Force close needed." are three lines, as on GitHub.
    const para = body.locator('p', { hasText: 'Exporting of transactions' })
    await expect(para.locator('br')).toHaveCount(2)
    // The imported author links to GitHub, never to a Forge profile of the same name.
    const mention = body.getByRole('link', { name: /^@coffseducation$/i }).first()
    await expect(mention).toHaveAttribute('href', /^https:\/\/github\.com\/coffseducation$/i)
    await expect(page.locator('a[href^="/u/?name=coffseducation"]')).toHaveCount(0)
    await shot(page, 'fg2-02-issue-6935')
  })

  test('fg2-3. imported issue #7512: cross-repo refs and #N (L-40, L-39)', async ({ page }) => {
    await page.goto(repoUrl('issue', '&number=7512', DASH), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    const body = page.locator('[data-tap-exempt="prose"]', { hasText: 'dashpay/platform' }).first()
    await expect(body).toContainText('dashpay/platform', { timeout: 60_000 })
    await expect(body.getByRole('link', { name: 'dashpay/platform#4344' }).first()).toHaveAttribute('href', 'https://github.com/dashpay/platform/issues/4344')
    const own = body.getByRole('link', { name: /^dashpay\/dash#\d+$/ }).first()
    await expect(own).toHaveAttribute('href', /\/repo\/number\/\?.*upstream=1/)
    await shot(page, 'fg2-03-issue-7512')
    // #N resolves to whichever of issue or PR exists, or to the source when not mirrored.
    await own.click()
    await expect(page).toHaveURL(atRoute(/\/repo\/(issue|pull|number)\//), { timeout: 60_000 })
    await expect(page.getByText(/not in this repo|Open #\d+ on github\.com|#\d+/).first()).toBeVisible({ timeout: 60_000 })
    await shot(page, 'fg2-03b-number-resolved')
  })

  test('fg2-4. release notes: headings, bullets, refs and magnet links that wrap (L-03, L-41, L-51, L-52)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(repoUrl('release', '&tag=v22.1.2', DASH), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    const release = page.getByTestId('release').first()
    await expect(release).toContainText('magnet:', { timeout: 60_000 })
    await expect(release).not.toContainText('=====')
    const width = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(width).toBeLessThanOrEqual(390)
    await shot(page, 'fg2-04-release-v22.1.2-mobile')
  })
})
