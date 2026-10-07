import { test, expect, type Locator, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { atRoute, DEMO, E2E_DEVNET, expectPlatformPreAllowed, fixtureWriteBlocked, idFile, routeOf, runAxe, shot, signedIn, unlock, waitForRepoResolved } from './helpers'

/**
 * Pull requests, forks and the browser merge engine, live on a devnet (real spend, about
 * 0.01 DASH per run):
 *
 *   E2E_PORT=4324 E2E_DEVNET=sakura E2E_WRITE=1 pnpm exec playwright test v2-pulls.spec.ts
 *
 * OWNER creates a repo; CONTRIB forks the read fixture `forge-v2-demo` (the fork browses
 * through the parent's packs) and opens a PR on it from the fork's `feature/greeting`, the
 * diff shown before submit; COLLAB (a writer of the fixture) comments inline and requests
 * changes; OWNER approves. The header shows the fold exactly, and the merge button states come
 * from the merge worker. Nothing is merged: refs are never pushed to the fixture.
 */

// E2E_C_RUN reuses an earlier run's repos (a resumed fork writes nothing twice).
const RUN = process.env['E2E_C_RUN'] ?? Date.now().toString(36)
const REPO = `e2e-c-${RUN}`
const FORK = `e2e-c-fork-${RUN}`
const PR_TITLE = 'Greet by name'

test.skip(E2E_DEVNET === '' || process.env['E2E_WRITE'] !== '1', 'live devnet writes: set E2E_DEVNET=sakura E2E_WRITE=1')
test.skip(!['OWNER', 'COLLAB', 'CONTRIB'].every((n) => existsSync(idFile(n))), 'devnet test identities not found')
test.skip(fixtureWriteBlocked('demo') !== null, fixtureWriteBlocked('demo') ?? '')
test.describe.configure({ mode: 'serial', timeout: 300_000 })

let prNumber = 0

function demo(path: string, extra = ''): string {
  return `/repo/${path}${path ? '/' : ''}?owner=${DEMO.owner}&name=${DEMO.name}${extra}`
}

/**
 * Reload until `check` holds (a node one block behind may not have the new documents yet). A
 * reload locks the vault, so a signed-in page is unlocked again.
 */
async function eventually(page: Page, check: () => Promise<void>, signed = true, tries = 6): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await check()
      return
    } catch (e) {
      if (i >= tries) throw e
      await page.reload({ waitUntil: 'domcontentloaded' })
      if (signed) await unlock(page)
      await waitForRepoResolved(page)
    }
  }
}

const visible = (l: Locator) => () => expect(l).toBeVisible({ timeout: 30_000 })

async function confirmWrite(page: Page, label: RegExp): Promise<void> {
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('cost-preview')).toBeVisible()
  await dialog.getByRole('button', { name: label }).click()
  await expect(dialog).toBeHidden({ timeout: 240_000 })
}

test('c1. owner creates a repo', async ({ browser }) => {
  const page = await signedIn(browser, 'OWNER', '/new/')
  await page.getByLabel('Repository name').fill(REPO)
  await page.getByRole('button', { name: 'Create repository' }).click()
  await confirmWrite(page, /sign & create/i)
  await expect(page.getByRole('region', { name: 'Empty repository' })).toBeVisible({ timeout: 90_000 })
})

test('c2. contributor forks the fixture; the fork browses through the parent packs', async ({ browser }) => {
  const page = await signedIn(browser, 'CONTRIB', demo(''))
  await waitForRepoResolved(page)
  await page.getByRole('button', { name: /^fork$/i }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Fork name').fill(FORK)
  await expect(dialog.getByTestId('fork-plan')).toContainText(/pack manifest/, { timeout: 60_000 })
  // GitHub's default copies the default branch alone (QW3-010); c3 proposes feature/greeting.
  await expect(dialog.getByTestId('fork-default-only')).toBeChecked()
  await dialog.getByTestId('fork-default-only').uncheck()
  await expect(dialog.getByTestId('cost-preview')).toContainText('DASH')
  expect(await runAxe(page, 'fork dialog')).toEqual([])
  await shot(page, 'c-fork-dialog')
  await dialog.getByRole('button', { name: /sign & fork|finish the fork/i }).click()
  await page.waitForURL(atRoute(new RegExp(`name=${FORK}`)), { timeout: 240_000 })
  await waitForRepoResolved(page)
  await expect(page.getByTestId('forked-from')).toContainText(DEMO.name, { timeout: 60_000 })
  // README from the parent's Platform chunks, through the fork's platform:// manifests.
  await eventually(page, visible(page.getByText(/The forge-v2 read fixture/).first()))
  await shot(page, 'c-fork-page')
})

test('c3. contributor opens a PR from the fork, diff shown before submit', async ({ browser }) => {
  const page = await signedIn(browser, 'CONTRIB', demo('pulls'))
  await waitForRepoResolved(page)
  await page.getByRole('link', { name: /new pull request/i }).click()
  await page.waitForURL(atRoute(/\/repo\/pulls\/new/))
  const head = page.getByLabel('Compare (your branch)')
  await eventually(page, () => expect(page.locator('#pr-head optgroup[label="Your forks"] option', { hasText: FORK }).first()).toBeAttached({ timeout: 45_000 }))
  // Labelled owner-first, `<owner>/<fork>:<branch>` (QW4-030).
  await head.selectOption((await page.locator('#pr-head option', { hasText: `${FORK}:feature/greeting` }).first().getAttribute('value')) ?? '')
  await expect(page.getByLabel('Base')).toHaveValue('refs/heads/main')
  // The diff renders before anything is signed, and the title is the head commit's subject.
  await expect(page.getByText('src/main.rs').first()).toBeVisible({ timeout: 90_000 })
  await expect(page.getByText(/hello, \{name\}/).first()).toBeVisible({ timeout: 90_000 })
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(PR_TITLE)
  await page.getByLabel('Description', { exact: true }).fill(`Opened from the browser by v2-pulls (${RUN}).`)
  await expect(page.getByTestId('cost-preview').first()).toContainText('DASH')
  await expect(page.getByText(/git push dash:\/\//)).toBeVisible()
  expect(await runAxe(page, 'new PR')).toEqual([])
  await shot(page, 'c-new-pr')
  await page.getByRole('button', { name: /create pull request/i }).click()
  await page.waitForURL(atRoute(/\/repo\/pull\/\?.*number=\d+/), { timeout: 120_000 })
  prNumber = Number(routeOf(page.url()).searchParams.get('number'))
  expect(prNumber).toBeGreaterThan(0)
  await expect(page.getByRole('heading', { name: new RegExp(PR_TITLE) })).toBeVisible({ timeout: 90_000 })
  await expect(page.getByText(/Objects live in repo/)).toBeVisible()
})

test('c4. a signed-out visitor keeps the draft through the sign-in sheet', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(demo('pulls/new'), { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page)
  await page.getByLabel('Title', { exact: true }).fill('Draft kept across sign-in')
  // Nothing can be created until a branch to propose is picked (the button stays disabled).
  const head = page.locator('#pr-head')
  await expect(head.locator('option', { hasText: 'feature/greeting' })).toBeAttached({ timeout: 90_000 })
  await head.selectOption({ label: 'feature/greeting' })
  await page.getByRole('button', { name: /sign in to create/i }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page)
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Draft kept across sign-in')
  await context.close()
})

test('c5. a writer comments inline and requests changes; merge is maintainers-only on main', async ({ browser }) => {
  test.skip(prNumber === 0, 'needs the PR from c3')
  const page = await signedIn(browser, 'COLLAB', demo('pull', `&number=${prNumber}&tab=files`))
  await waitForRepoResolved(page)
  const line = page.getByRole('button', { name: 'Comment on new line 2 of src/main.rs' }).first()
  await expect(line).toBeVisible({ timeout: 120_000 })
  await line.click()
  await page.getByRole('textbox', { name: 'Your comment on src/main.rs line 2 (new)' }).fill('Should this fall back to the user name?')
  // A member can review, so the composer offers GitHub's two buttons: this one posts now.
  await page.getByRole('button', { name: 'Add single comment' }).click()
  await eventually(page, visible(page.getByTestId('inline-thread').getByText('Should this fall back to the user name?')))

  // main is protected in the fixture: a writer cannot move it. Since #66 (repo settings) the
  // writer gets no merge panel at all; Branch rules says why.
  await page.getByTestId('pr-tab-conversation').click()
  await expect(page.getByTestId('protected-base')).toContainText('Only maintainers can merge into it', { timeout: 60_000 })
  await expect(page.getByTestId('merge-button-state')).toHaveCount(0)

  await page.getByRole('button', { name: /^request changes$/i }).click()
  await confirmWrite(page, /submit review/i)
  await eventually(page, visible(page.getByTestId('fold-changes')))
})

test('c6. the owner approves; the fold, the palette and the merge button states', async ({ browser }) => {
  test.skip(prNumber === 0, 'needs the PR from c3')
  const page = await signedIn(browser, 'OWNER', demo('pull', `&number=${prNumber}`))
  await waitForRepoResolved(page)
  await expect(page.getByRole('heading', { name: new RegExp(PR_TITLE) })).toBeVisible({ timeout: 90_000 })
  await page.getByRole('button', { name: /^approve$/i }).click()
  await confirmWrite(page, /submit review/i)
  await eventually(page, visible(page.getByTestId('fold-approved')))
  const head = (await page.getByTestId('fold-approved').innerText()).match(/on\s+([0-9a-f]{7})/)?.[1] ?? ''
  expect(head).toMatch(/^[0-9a-f]{7}$/)
  await expect(page.getByTestId('fold-approved')).toHaveText(new RegExp(`^\\s*Approved by 1 maintainer on ${head}\\s*$`))
  await expect(page.getByTestId('fold-changes')).toContainText('Changes requested by')
  await shot(page, 'c-pr-fold')

  // The worker decides: the fork's head descends from main, so this is a fast-forward.
  await expect(page.getByTestId('merge-button-state')).toHaveAttribute('data-state', 'fast-forward', { timeout: 120_000 })
  await expect(page.getByRole('button', { name: 'Merge (fast-forward)' })).toBeVisible()
  await page.getByTestId('merge-panel').scrollIntoViewIfNeeded()
  await shot(page, 'c-merge-fast-forward')

  // Side by side at desktop width, the inline thread under its line.
  await page.getByTestId('pr-tab-files').click()
  await expect(page.locator('table[data-layout="split"]').first()).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('inline-thread').first()).toBeVisible()
  await page.getByTestId('inline-thread').first().scrollIntoViewIfNeeded()
  await shot(page, 'c-split-inline-thread')
  expect(await runAxe(page, 'PR page')).toEqual([])

  await page.getByRole('button', { name: 'Blue/orange' }).click()
  await expect(page.getByRole('button', { name: 'Blue/orange' })).toHaveAttribute('aria-pressed', 'true')
  await shot(page, 'c-colorblind-palette')
  expect(await runAxe(page, 'PR page, blue/orange')).toEqual([])
  await page.getByRole('button', { name: 'Blue/orange' }).click()

  // A phone: unified diff, and the merge says to use a desktop browser.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByTestId('pr-tab-conversation').click()
  await expect(page.getByTestId('merge-button-state')).toHaveAttribute('data-state', 'mobile')
  await expect(page.getByRole('button', { name: 'Use a desktop browser for this step' })).toBeDisabled()
  await page.getByTestId('pr-tab-files').click()
  await expect(page.locator('table[data-layout="unified"]').first()).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
  await shot(page, 'c-pr-mobile')
})

/**
 * The live browser merge. `lib/merge/merge-seed.live.test.ts` seeds an OWNER repo whose `main`
 * and `feature` diverge, with PR #1; set E2E_C_MERGE_SEED to the JSON it wrote. OWNER merges
 * with a merge commit, stores the pack on Platform after the priced question, and the PR folds
 * as merged; the new tip browses with both sides' edits.
 */
const SEED = process.env['E2E_C_MERGE_SEED'] ?? ''

test('c7. the owner merges a divergent PR in the browser (merge commit, Platform storage)', async ({ browser }) => {
  test.skip(SEED === '' || !existsSync(SEED), 'set E2E_C_MERGE_SEED (lib/merge/merge-seed.live.test.ts)')
  const seed = JSON.parse(readFileSync(SEED, 'utf8')) as { owner: string; name: string; number: number }
  const pr = `/repo/pull/?owner=${seed.owner}&name=${seed.name}&number=${seed.number}`

  const page = await signedIn(browser, 'OWNER', '/settings/')
  await page.getByLabel('Commit author name').fill('Forge E2E Owner')
  await page.getByLabel('Commit author email').fill('owner@e2e.forge.invalid')
  await page.goto(pr, { waitUntil: 'domcontentloaded' })
  await unlock(page)
  await waitForRepoResolved(page)

  await expect(page.getByTestId('merge-button-state')).toHaveAttribute('data-state', 'merge-commit', { timeout: 120_000 })
  await page.getByTestId('merge-panel').scrollIntoViewIfNeeded()
  // Where the pack goes, and its Platform price, are answered before the merge starts.
  await expectPlatformPreAllowed(page.getByTestId('merge-panel'))
  await shot(page, 'c-merge-commit-button')
  await page.getByRole('button', { name: 'Create merge commit and merge' }).click()

  const steps = page.getByRole('list', { name: 'Merge steps' })
  await expect(steps.locator('[data-step="event"]')).toHaveAttribute('data-state', 'done', { timeout: 300_000 })
  for (const s of ['fetch', 'merge', 'pack', 'upload', 'manifest', 'index', 'ref']) {
    await expect(steps.locator(`[data-step="${s}"]`)).toHaveAttribute('data-state', 'done')
  }
  // Pre-allowed before the merge: the run never stopped to ask.
  await expect(page.getByTestId('storage-question')).toHaveCount(0)
  await page.getByTestId('merge-panel').scrollIntoViewIfNeeded()
  await shot(page, 'c-merge-steps-done')

  // "Merged" only once the fold reads the merge event and the new tip back.
  await eventually(page, visible(page.getByText('Merged', { exact: true }).first()))
  await shot(page, 'c-merged')
  for (const [path, text] of [
    ['a.txt', 'alpha, on main'],
    ['b.txt', 'beta, from the feature branch'],
  ] as const) {
    await page.goto(`/repo/blob/?owner=${seed.owner}&name=${seed.name}&path=${path}`, { waitUntil: 'domcontentloaded' })
    await unlock(page)
    await waitForRepoResolved(page)
    await eventually(page, visible(page.getByText(text).first()))
  }
})
