import { test, expect, type Browser, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'

import { expectLanded, idFile, idOrEmpty, loadSeedPulls, repoUrl, shot, signedIn, waitForRepoResolved } from './helpers'

/**
 * G17 (L-36, L-37, L-38): plurals, the follower / following lists, PR and issue copy, and the
 * inline cost hints, live on a devnet.
 *
 *   E2E_DEVNET=sakura E2E_SKIP_BUILD=1 E2E_PORT=<p> pnpm exec playwright test collab-copy.spec.ts
 *
 * The read checks use the shared read fixture (`DEMO`) and write nothing. The follow checks need
 * two identities of the spec's own (E2E_IDENTITY_DIR holding FOLLOWER and FOLLOWED; never the
 * shared fixtures): FOLLOWER follows FOLLOWED once (a set-up write, skipped when the follow
 * already stands), then the lists are read. Signed in as FOLLOWER, the star and inline-comment
 * costs are checked without signing anything.
 */

const FOLLOWER = idOrEmpty('FOLLOWER')
const FOLLOWED = idOrEmpty('FOLLOWED')
const followIds = !!process.env['E2E_IDENTITY_DIR'] && existsSync(idFile('FOLLOWER')) && existsSync(idFile('FOLLOWED'))

test.describe.configure({ mode: 'serial', timeout: 180_000 })

test('g17-1. a merged PR says what happened, with short branch names (L-37, D-104)', async ({ page }) => {
  await page.goto(repoUrl('pull', `&number=${loadSeedPulls().merged}`), { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page)
  await expectLanded(page, page.getByRole('heading', { name: /Document the fold rules/ }))
  await expect(page.getByTestId('pr-state')).toHaveText(/Merged/)
  const header = page.getByTestId('pr-state').locator('xpath=following-sibling::span[1]')
  await expect(header).toContainText(/merged into main/i, { timeout: 60_000 })
  await expect(header).not.toContainText('wants to merge')
  await expect(header).not.toContainText('refs/heads/')
  // A count only from a real comparison ("1 commit" / "2 commits", never "1 commits"); when the
  // diff fell back to the head's first parent (this fixture: source and base are both main) the
  // header claims none. Its time is the opening, not the merge.
  await expect(header).toContainText(/^(Merged|(1 commit|[02-9]\d* commits|\d{2,} commits) merged) into main/, { timeout: 90_000 })
  await expect(header).not.toContainText(/\b1 commits\b/)
  await expect(header).toContainText(/opened (just now|\d+(m|h|d|mo|y) ago)/)
  await expect(page.locator('main')).not.toContainText(/\b0m ago\b/)
  await shot(page, 'g17-01-merged-pr')

  // The list names the base branch the same way.
  await page.goto(repoUrl('pulls'), { waitUntil: 'domcontentloaded' })
  await expectLanded(page, page.getByText(/Greet by name/).first())
  await page.getByRole('tab', { name: 'All', exact: true }).click()
  await expect(page.getByText(/Document the fold rules/).first()).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('main')).not.toContainText('into refs/heads/')
  await expect(page.locator('main')).toContainText('into main')
})

test('g17-2. the ref bar counts commits with the plural helper (L-36)', async ({ page }) => {
  await page.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page)
  const count = page.getByTestId('commit-count')
  await expect(count).toHaveText(/^(1 commit|\d+\+? commits)$/, { timeout: 90_000 })
  await expect(count).not.toHaveText(/^1 commits$/)
})

/** On `target`'s profile, signed in: follow it, unless the follow already stands. */
async function ensureFollowing(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: /^(Follow|Following)\b/ })
  await expect(button).toBeEnabled({ timeout: 90_000 })
  await expect(page.getByTestId('follow-cost')).toBeVisible()
  if (/^Following/.test((await button.innerText()).trim())) return
  await button.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('cost-preview')).toBeVisible()
  await dialog.getByRole('button', { name: /sign & follow/i }).click()
  await expect(dialog).toBeHidden({ timeout: 90_000 })
  await expect(page.getByRole('button', { name: /^Following\b/ })).toBeVisible({ timeout: 60_000 })
}

/** A page signed in as FOLLOWER at `path` (a hard navigation later locks the vault again). */
function followerPage(browser: Browser, path: string): Promise<Page> {
  return signedIn(browser, 'FOLLOWER', path)
}

test.describe('follow lists and cost hints (own identities)', () => {
  test.skip(!followIds, "set E2E_IDENTITY_DIR to a directory with this spec's FOLLOWER and FOLLOWED identities")
  test.skip(process.env['E2E_WRITE'] !== '1', 'the follow set-up is a live devnet write: set E2E_WRITE=1')

  test('g17-3. profile counts link to the follower and following lists (L-36)', async ({ browser }) => {
    const page = await followerPage(browser, `/u/?name=${FOLLOWED}`)
    await ensureFollowing(page)

    // FOLLOWED's profile: "1 follower" (singular), and it links to the list naming FOLLOWER.
    const followers = page.getByRole('link', { name: /^\d+ followers?$/ })
    await expect(followers).toBeVisible({ timeout: 90_000 })
    await expect(page.getByRole('link', { name: /^\d+ following$/ })).toBeVisible()
    await expect(page.locator('main')).not.toContainText(/\b1 followers\b/)
    await followers.click()
    await page.waitForURL(/\/u\/followers\/?\?name=/)
    await expect(page.getByRole('heading', { name: 'Followers' })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('follow-list').locator(`[data-identity="${FOLLOWER}"]`)).toBeVisible({ timeout: 60_000 })
    await shot(page, 'g17-03-followers')

    // FOLLOWER's following list names FOLLOWED; the pill links back to its profile.
    await page.goto(`/u/following/?name=${FOLLOWER}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Following' })).toBeVisible({ timeout: 90_000 })
    const row = page.getByTestId('follow-list').locator(`[data-identity="${FOLLOWED}"]`)
    await expect(row).toBeVisible({ timeout: 60_000 })
    await expect(row.locator('a')).toHaveAttribute('href', new RegExp(`/u/?\\?name=${FOLLOWED}`))
    await shot(page, 'g17-03-following')

    // FOLLOWED follows nobody: the empty state, not an error.
    await page.goto(`/u/following/?name=${FOLLOWED}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('Not following anyone yet')).toBeVisible({ timeout: 90_000 })
  })

  test('g17-4. Star shows its cost beside the button (L-38, D-098)', async ({ browser }) => {
    const page = await followerPage(browser, repoUrl('pull', `&number=${loadSeedPulls().approved}`))
    await waitForRepoResolved(page)
    await expectLanded(page, page.getByRole('heading', { name: /Greet by name/ }))

    // The star's price is visible text next to the button, not only its tooltip (D-098).
    // Starred already, it names the refund: "unstar +0.00012 DASH" (QW2-034).
    await expect(page.getByTestId('star-cost')).toHaveText(/^(~|unstar \+)\d[\d.]* DASH$/, { timeout: 60_000 })
    await expect(page.getByTestId('star-cost')).toBeVisible()
    await shot(page, 'g17-04-star-cost')
  })

  test('g17-6. the verdict row offers every verdict and its confirm reads well (L-37, L-38)', async ({ browser }) => {
    const page = await followerPage(browser, repoUrl('pull', `&number=${loadSeedPulls().approved}`))
    await waitForRepoResolved(page)
    await expectLanded(page, page.getByRole('heading', { name: /Greet by name/ }))

    // The verdict row offers all three verdicts, and the confirm reads "Records an approval".
    for (const name of ['Approve', 'Request changes', 'Comment only']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 60_000 })
    }
    await page.getByRole('button', { name: 'Approve', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText(/Records an approval on [0-9a-f]{9}/)
    await expect(dialog).not.toContainText('Records a approve')
    await shot(page, 'g17-06-approve-dialog')
    await dialog.getByRole('button', { name: /cancel/i }).click()
    await expect(dialog).toBeHidden()
  })

  test('g17-7. after an issue is created the Issues tab counts it; closed, the list does not invite the first (L-37)', async ({ browser }) => {
    const repo = `g17-${Date.now().toString(36)}`
    const page = await followerPage(browser, '/new/')
    await page.getByLabel('Repository name').fill(repo)
    // Not about members-only content: create without it (on by default where the browser holds a key).
    await page.getByTestId('repo-members-only').uncheck()
    await page.getByRole('button', { name: 'Create repository' }).click()
    const create = page.getByRole('dialog')
    await expect(create.getByTestId('cost-preview')).toBeVisible()
    await create.getByRole('button', { name: /sign & create/i }).click()
    await expect(page.getByRole('region', { name: 'Empty repository' })).toBeVisible({ timeout: 120_000 })

    await page.getByRole('link', { name: /^Issues/ }).first().click()
    await page.getByRole('button', { name: /new issue/i }).first().click()
    await page.getByLabel('Title', { exact: true }).fill('A G17 issue')
    await page.getByRole('button', { name: /submit issue/i }).click()
    await expect(page.getByRole('heading', { name: /A G17 issue/ })).toBeVisible({ timeout: 120_000 })
    // The header's Issues tab shows the new open issue, not a blank badge.
    const tab = page.getByRole('link', { name: /^Issues\s*\d*$/ }).first()
    await expect(tab).toHaveText(/Issues\s*1$/, { timeout: 60_000 })
    await shot(page, 'g17-07-issue-tab-count')

    await page.getByRole('button', { name: /close issue/i }).click()
    const close = page.getByRole('dialog')
    await close.getByRole('button', { name: /close issue/i }).click()
    await expect(close).toBeHidden({ timeout: 90_000 })
    await page.getByRole('link', { name: /^Issues/ }).first().click()
    await expect(page.getByText('No open issues')).toBeVisible({ timeout: 90_000 })
    await expect(page.locator('main')).not.toContainText('Open the first issue')
    await expect(page.locator('main')).toContainText(/1 issue is closed|No issue is open right now/)
    await shot(page, 'g17-07-issues-empty-closed')
  })

  test('g17-5. the inline composer shows its cost before Add comment (L-38)', async ({ browser }) => {
    const page = await followerPage(browser, repoUrl('pull', `&number=${loadSeedPulls().approved}&tab=files`))
    await waitForRepoResolved(page)
    const line = page.getByRole('button', { name: 'Comment on new line 2 of src/main.rs' }).first()
    await expect(line).toBeVisible({ timeout: 90_000 })
    await line.click()
    const box = page.getByRole('textbox', { name: /Your comment on src\/main\.rs/ })
    await box.fill('A cost check (never posted).')
    const composer = box.locator('xpath=ancestor::div[contains(@class, "space-y-2")][1]')
    await expect(composer.getByTestId('cost-preview')).toContainText(/~\d[\d.]* DASH/)
    // The cost sits before the submit button, as in the conversation composer.
    const costBox = await composer.getByTestId('cost-preview').boundingBox()
    const submitBox = await composer.getByRole('button', { name: /Add (single )?comment/ }).boundingBox()
    expect(costBox && submitBox && costBox.x < submitBox.x).toBeTruthy()
    await shot(page, 'g17-05-inline-cost')
    await composer.getByRole('button', { name: 'Cancel' }).click()
  })
})
