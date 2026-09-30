import { test, expect, type Page } from '@playwright/test'
import { collectPageErrors, E2E_DEVNET, repoUrl, shot, showcaseRepo, waitForRepoResolved } from './helpers'

/**
 * Ref resolution on the dash showcase mirror (FG-1: L-01, L-02, L-28, L-32, L-63), read-only:
 *
 *   E2E_DEVNET=moutai pnpm exec playwright test tag-refs.spec.ts
 *
 * v23.1.8 is an annotated tag (tag object 79b6c521…) naming commit 728f505…; before the fix every
 * view of it said "79b6c521 is not a commit". The mirror's code is stable.
 */

const TAG = 'v23.1.8'
const TAG_OBJECT = '79b6c521'
const TAG_COMMIT = '728f505'
/** A 2017 commit whose file links opened develop, where the file no longer exists (L-28). */
const OLD_COMMIT = 'f8a7a2c88d7aafba739bb753a06c6eb8c3ce9e57'
const OLD_FILE = 'src/qt/res/icons/bitcoin_testnet.ico'
/** A develop commit, for a short-id `?ref=` (L-32). */
const SHORT = '1deab35186f9c'

let DASH: { readonly owner: string; readonly name: string }

/** No read-error card, and none of the pre-fix messages. */
async function expectNoReadError(page: Page): Promise<void> {
  await expect(page.getByText(/is not a commit|is a tag, not a commit|That read did not land/)).toHaveCount(0)
}

test.describe('ref resolution (dash showcase mirror)', () => {
  test.skip(E2E_DEVNET !== 'moutai', 'the dash mirror is imported on moutai')
  test.describe.configure({ timeout: 180_000 })

  test.beforeAll(async () => {
    DASH = await showcaseRepo('DASHPAY', 'dash')
  })

  test('tr-1. an annotated release tag browses on code, blob, commits, history and blame (L-01)', async ({ page }) => {
    const errors = collectPageErrors(page)
    await page.goto(repoUrl('', `&ref=${TAG}`, DASH), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(page.getByRole('link', { name: 'README.md' }).first()).toBeVisible({ timeout: 90_000 })
    await expect(page.getByTestId('commit-count')).toContainText(/commit/, { timeout: 60_000 })
    await expectNoReadError(page)
    await shot(page, 'tr-01-home-annotated-tag')

    await page.goto(repoUrl('blob', `&ref=${TAG}&path=README.md`, DASH), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    // A Markdown file opens rendered (QW-025); its source is a click away.
    await expect(page.getByTestId('blob-markdown')).toBeVisible({ timeout: 90_000 })
    await page.getByTestId('blob-code').click()
    await expect(page.locator('#L1')).toBeVisible()
    await expectNoReadError(page)

    await page.goto(repoUrl('commits', `&ref=tags%2F${TAG}`, DASH), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    const first = page.getByTestId('commit-row').first()
    await expect(first).toBeVisible({ timeout: 90_000 })
    await expect(first).toContainText(TAG_COMMIT)
    await expectNoReadError(page)

    // A rarely changed file's History can take a minute (L-08, FG-4): walking from the tag's
    // commit is the proof here, where it used to fail at once with "is not a commit".
    await page.goto(repoUrl('commits', `&ref=${TAG}&path=.python-version`, DASH), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(page.getByText(/Walking the history of/).or(page.getByTestId('commit-row')).first()).toBeVisible({ timeout: 90_000 })
    await expectNoReadError(page)

    await page.goto(repoUrl('blame', `&ref=${TAG}&path=.python-version`, DASH), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    // Blame finishes (a 1-line file), or is still walking: either way it is not an error card.
    await expect(page.getByTestId('blame-progress').or(page.locator('table')).first()).toBeVisible({ timeout: 90_000 })
    await expectNoReadError(page)
    await shot(page, 'tr-01-blame-annotated-tag')
    expect(errors.errors).toEqual([])
  })

  test('tr-2. the zip of an annotated tag starts listing files instead of failing (L-01)', async ({ page }) => {
    await page.goto(repoUrl('', `&ref=${TAG}`, DASH), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    const zip = page.getByTestId('zip-download')
    await expect(zip).toBeEnabled({ timeout: 90_000 })
    await zip.click()
    // The whole tag is ~23 MB and 460 requests: only the listing is waited for, then cancelled.
    await expect(page.getByText(/Reading \d+ of|Compressing/)).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText(/could not be built/)).toHaveCount(0)
    await page.getByRole('button', { name: 'Cancel' }).click()
  })

  test('tr-3. the tags list shows the commit a tag names, and its commit page opens (L-02)', async ({ page }) => {
    await page.goto(repoUrl('commit', `&oid=${TAG_OBJECT}`, DASH), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(page.getByTestId('commit-via-tag')).toContainText(TAG, { timeout: 90_000 })
    await expect(page.getByText(/names a file or directory/)).toHaveCount(0)
    await shot(page, 'tr-03-commit-via-tag')

    await page.goto(repoUrl('tags', '', DASH), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    const row = page.getByRole('link', { name: TAG, exact: true }).locator('xpath=..')
    await row.scrollIntoViewIfNeeded({ timeout: 90_000 })
    await expect(row.getByTestId('tag-commit')).toContainText(TAG_COMMIT, { timeout: 60_000 })
  })

  test('tr-4. a short commit id in ?ref= resolves (L-32)', async ({ page }) => {
    await page.goto(repoUrl('commits', `&ref=${SHORT}`, DASH), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(page.getByTestId('commit-row').first()).toContainText(SHORT.slice(0, 7), { timeout: 90_000 })
    await expect(page.getByText(/Ref not found|No branch/)).toHaveCount(0)
  })

  test('tr-5. a commit page links its files at that commit (L-28)', async ({ page }) => {
    await page.goto(repoUrl('commit', `&oid=${OLD_COMMIT}`, DASH), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    const link = page.getByRole('link', { name: OLD_FILE })
    await expect(link).toBeVisible({ timeout: 90_000 })
    expect(await link.getAttribute('href')).toContain(`ref=${OLD_COMMIT}`)
    await link.click()
    await expect(page.getByText('File not found on this ref')).toHaveCount(0, { timeout: 60_000 })
    await expect(page.getByText(/Binary file|bitcoin_testnet/).first()).toBeVisible({ timeout: 90_000 })
  })

  test('tr-6. a directory path in /repo/blob opens the directory (L-63)', async ({ page }) => {
    await page.goto(repoUrl('blob', '&path=src', DASH), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(page).toHaveURL(/\/repo\/tree\/\?.*path=src/, { timeout: 90_000 })
    await expect(page.getByText(/is not a blob|is a tree, not a blob/)).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'init.cpp' })).toBeVisible({ timeout: 60_000 })
  })
})
