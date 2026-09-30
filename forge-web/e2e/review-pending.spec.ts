import { test, expect, type Page } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { idFile, idOf, runAxe, shot, signedIn, unlock, waitForRepoResolved } from './helpers'

/**
 * Pending reviews, ranges, resolution and comment edits in the browser (review-parity spec §7
 * PR 4), live on a devnet with the spec's own identities (about 0.01 DASH):
 *
 *   E2E_DEVNET=bonsia E2E_WRITE=1 E2E_IDENTITY_DIR=<dir with OWNER, CONTRIB, COLLAB> \
 *     E2E_BIN_DIR=<dir with dg + git-remote-dash> pnpm exec playwright test review-pending.spec.ts
 *
 * The CLI sets up a repo (COLLAB a writer), CONTRIB's fork and a PR from it. Then, in the web:
 *
 *   p1. COLLAB starts a review on the Files tab: a single line, a 3-line range (shift-click) and
 *       another line, all pending ("Pending" in place, nothing written, the count on the button).
 *   p2. The draft survives a reload (IndexedDB).
 *   p3. The submit fails after the review and one comment (the network is cut) → "recorded with
 *       1 of 3 comments" → Retry lands the rest; `dg pr view` shows ONE review with 3 of 3
 *       comments, none twice, the range as 3-5 (new).
 *   p4. CONTRIB (the author) replies to the range thread and resolves it → collapsed "Resolved
 *       conversation"; `dg pr view` agrees (resolved).
 *   p5. COLLAB edits a comment of the review ("edited"), then deletes another → gone.
 *   p6. The CLI's review shows in the web: OWNER `dg pr review --approve` with a line comment →
 *       the Reviewers card says Approved and the thread shows on the diff.
 *   p7. A single comment ("Add single comment") posts at once; axe is clean.
 */

test.skip(process.env['E2E_WRITE'] !== '1', 'live devnet writes: set E2E_WRITE=1')
test.skip(!process.env['E2E_IDENTITY_DIR'], "set E2E_IDENTITY_DIR to this spec's own identities (never the shared fixtures)")
test.skip(!process.env['E2E_BIN_DIR'], 'set E2E_BIN_DIR to a directory holding dg and git-remote-dash')
test.skip(!!process.env['E2E_IDENTITY_DIR'] && !existsSync(idFile('CONTRIB')), 'OWNER / CONTRIB / COLLAB identity files not found')
test.describe.configure({ mode: 'serial', timeout: 360_000 })

const BIN = process.env['E2E_BIN_DIR'] ?? ''
const ids = process.env['E2E_IDENTITY_DIR'] ? { owner: idOf('OWNER'), contrib: idOf('CONTRIB'), collab: idOf('COLLAB') } : { owner: '', contrib: '', collab: '' }
const RUN = process.env['E2E_RUN'] ?? Date.now().toString(36)
const REPO = `review-pending-${RUN}`
const FORK = `review-pending-fork-${RUN}`
const SLUG = `${ids.owner}/${REPO}`
const WORK = join(tmpdir(), `dash-forge-${REPO}`)
const FILE = 'src/greet.rs'
let prNumber = 0
// The reviewer's page from p1 on: a pending review lives in THIS browser's IndexedDB, so p2 and p3
// reload it rather than open a new context (which would start from the saved sign-in state).
let reviewer: Page | null = null

/** Reload the reviewer's page (a reload locks the vault: unlock it). */
async function reloadReviewer(): Promise<Page> {
  const page = reviewer as Page
  await page.reload({ waitUntil: 'domcontentloaded' })
  await unlock(page)
  await waitForRepoResolved(page)
  return page
}

function env(who: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DASH_FORGE_KEY: idFile(who),
    DASH_FORGE_NETWORK: 'devnet',
    DASH_FORGE_DEVNET_NAME: process.env['E2E_DEVNET'] || 'bonsia',
    RUST_LOG: 'error',
    NO_COLOR: '1',
    PATH: `${BIN}:${process.env['PATH'] ?? ''}`,
  }
}

function dg(who: string, ...args: string[]): Record<string, unknown> {
  const out = execFileSync(join(BIN, 'dg'), ['--yes', '--json', ...args], { env: env(who), cwd: WORK, encoding: 'utf8', timeout: 240_000 })
  return JSON.parse(out) as Record<string, unknown>
}

function git(who: string, dir: string, args: string[]): void {
  const r = spawnSync('git', ['-c', 'dash.confirm=never', '-c', 'dash.prAutoSync=false', ...args], { env: env(who), cwd: dir, encoding: 'utf8', timeout: 240_000 })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.stdout}${r.stderr}`)
}

const files = (): string => `/repo/pull/?owner=${ids.owner}&name=${REPO}&number=${prNumber}&tab=files`

async function confirmWrite(page: Page, label: RegExp): Promise<void> {
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('cost-preview')).toBeVisible()
  await dialog.getByRole('button', { name: label }).click()
  await expect(dialog).toBeHidden({ timeout: 180_000 })
}

/** The line-number button of `line` on the new side of the file. */
const lineButton = (page: Page, line: number) => page.getByRole('button', { name: `Comment on new line ${line} of ${FILE}` }).first()

interface View {
  reviews: { id: string; commentCount: number | null; commentsLanded: number }[]
  threads: { id: string; location: string; resolved: boolean; comments: { id: string; body: string }[] }[]
  comments: { id: string; reviewId: string | null; body: string }[]
  reviewers: { identity: string; state: string }[]
}

test.beforeAll(() => {
  if (!process.env['E2E_IDENTITY_DIR'] || !BIN) return
  rmSync(WORK, { recursive: true, force: true })
  const src = join(WORK, 'src')
  mkdirSync(join(src, 'src'), { recursive: true })
  const g = (...a: string[]): void => void execFileSync('git', a, { cwd: src })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'owner@e2e.forge.invalid')
  g('config', 'user.name', 'E2E Owner')
  g('config', 'commit.gpgsign', 'false')
  writeFileSync(join(src, FILE), Array.from({ length: 12 }, (_, i) => `let v${i + 1} = ${i + 1};`).join('\n') + '\n')
  g('add', '.')
  g('commit', '-q', '-m', 'base')
  dg('OWNER', 'repo', 'create', REPO, '--storage', 'platform')
  git('OWNER', src, ['push', '-q', `dash://${SLUG}`, 'main:refs/heads/main'])
  // RC1 consent (R-06): the member accepts before the owner can add them (--wait rides out a
  // node that has not seen the consent yet).
  dg('COLLAB', 'collab', 'accept', SLUG)
  dg('OWNER', 'collab', 'add', SLUG, ids.collab, '--role', 'writer', '--wait', '60')
  dg('CONTRIB', 'repo', 'fork', SLUG, '--name', FORK)
  const w = join(WORK, 'fork')
  git('CONTRIB', WORK, ['clone', '-q', `dash://${ids.contrib}/${FORK}`, w])
  const gw = (...a: string[]): void => void execFileSync('git', a, { cwd: w })
  gw('config', 'user.email', 'contrib@e2e.forge.invalid')
  gw('config', 'user.name', 'E2E Contrib')
  gw('config', 'commit.gpgsign', 'false')
  gw('checkout', '-q', '-b', 'feature/values', 'origin/main')
  writeFileSync(join(w, FILE), Array.from({ length: 12 }, (_, i) => `let v${i + 1} = ${(i + 1) * 10};`).join('\n') + '\n')
  gw('commit', '-qam', 'Scale the values')
  git('CONTRIB', w, ['push', '-q', `dash://${ids.contrib}/${FORK}`, 'feature/values:refs/heads/feature/values'])
  const pr = dg('CONTRIB', 'pr', 'create', SLUG, '--base', 'main', '--head', 'feature/values', '--head-repo', `${ids.contrib}/${FORK}`, '--title', 'Scale the values')
  prNumber = Number(pr['number'])
})

test.afterAll(() => rmSync(WORK, { recursive: true, force: true }))

test('p1. a pending review: a line, a 3-line range and another line, nothing written', async ({ browser }) => {
  const page = await signedIn(browser, 'COLLAB', files())
  reviewer = page
  await waitForRepoResolved(page)
  await expect(lineButton(page, 2)).toBeVisible({ timeout: 180_000 })
  await lineButton(page, 2).click()
  await page.getByRole('textbox', { name: `Your comment on ${FILE} line 2 (new)` }).fill('Why ten times?')
  await page.getByRole('button', { name: 'Start a review' }).click()
  await lineButton(page, 3).click()
  await lineButton(page, 5).click({ modifiers: ['Shift'] })
  await page.getByRole('textbox', { name: `Your comment on ${FILE} lines 3–5 (new)` }).fill('These three could be a loop.')
  await page.getByRole('button', { name: 'Add review comment' }).click()
  await lineButton(page, 9).click()
  await page.getByRole('textbox', { name: `Your comment on ${FILE} line 9 (new)` }).fill('Nit: spacing.')
  await page.getByRole('button', { name: 'Add review comment' }).click()
  await expect(page.getByTestId('pending-comment')).toHaveCount(3)
  await expect(page.getByTestId('pending-count')).toHaveText('3')
  const view = dg('OWNER', 'pr', 'view', SLUG, String(prNumber), '--comments') as unknown as View
  expect(view.comments).toHaveLength(0)
  await shot(page, 'review-pending-01-drafts')
})

test('p2. the draft survives a reload and a sign-out and sign-in in the same browser, and says where it lives', async () => {
  // The same browser context: a pending review is kept in this browser (IndexedDB), not on the
  // account, so this is where it must survive.
  let page = await reloadReviewer()
  await expect(page.getByTestId('pending-count')).toHaveText('3', { timeout: 120_000 })
  await expect(page.getByTestId('pending-comment')).toHaveCount(3, { timeout: 120_000 })
  await expect(page.getByTestId('pending-review-banner')).toContainText('Pending comments are saved in this browser only')
  // Sign out and in again: the draft is keyed by identity and PR, not by the session.
  await page.getByRole('button', { name: 'Account menu' }).click()
  await page.getByRole('button', { name: /lock & sign out/i }).click()
  await expect(page.getByTestId('funds-pill')).toBeHidden({ timeout: 30_000 })
  await expect(page.getByTestId('pending-review-banner')).toBeHidden()
  await unlock(page)
  await expect(page.getByTestId('pending-count')).toHaveText('3', { timeout: 120_000 })
  await expect(page.getByTestId('pending-comment')).toHaveCount(3)
  await page.getByRole('button', { name: /review changes/i }).click()
  await expect(page.getByTestId('draft-whereabouts')).toContainText('saved in this browser only')
  await page.getByRole('button', { name: /review changes/i }).click()
  page = reviewer as Page
  await shot(page, 'review-pending-01b-browser-only')
})

test('p3. a submit cut off after 2 documents resumes with Retry; nothing twice', async () => {
  const page = reviewer as Page
  await expect(page.getByTestId('pending-count')).toHaveText('3', { timeout: 120_000 })
  await page.getByRole('button', { name: /review changes/i }).click()
  let panel = page.getByRole('region', { name: 'Finish your review' })
  await panel.getByLabel('Review summary').fill('A few things before this lands.')
  await panel.getByLabel(/^Request changes/).check()
  // The summary and verdict are part of the draft: a reload keeps them.
  await page.waitForTimeout(600)
  await reloadReviewer()
  await expect(page.getByTestId('pending-count')).toHaveText('3', { timeout: 120_000 })
  await page.getByRole('button', { name: /review changes/i }).click()
  panel = page.getByRole('region', { name: 'Finish your review' })
  await expect(panel.getByLabel('Review summary')).toHaveValue('A few things before this lands.')
  await expect(panel.getByLabel(/^Request changes/)).toBeChecked()
  await expect(panel.getByTestId('review-documents')).toContainText('4 documents')
  await shot(page, 'review-pending-02-drawer')
  // Cut the network after the second document is broadcast (the review and one comment).
  let broadcasts = 0
  await page.route(/:1443\/.*broadcastStateTransition/, async (route) => {
    broadcasts += 1
    if (broadcasts > 2) await route.abort()
    else await route.continue()
  })
  await panel.getByRole('button', { name: 'Submit review' }).click()
  await expect(panel.getByTestId('review-error')).toContainText(/recorded with 1 of 3 comments/, { timeout: 240_000 })
  await shot(page, 'review-pending-03-partial')
  await page.unroute(/:1443\/.*broadcastStateTransition/)
  await panel.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByTestId('pending-count')).toHaveCount(0, { timeout: 240_000 })
  const view = dg('OWNER', 'pr', 'view', SLUG, String(prNumber), '--comments') as unknown as View
  expect(view.reviews).toHaveLength(1)
  expect(view.reviews[0]).toMatchObject({ commentCount: 3, commentsLanded: 3 })
  expect(view.comments.filter((c) => c.reviewId === view.reviews[0]?.id)).toHaveLength(3)
  expect(view.threads.map((t) => t.location).sort()).toEqual([`${FILE}:2`, `${FILE}:3-5`, `${FILE}:9`].sort())
  await expect(page.getByTestId('thread')).toHaveCount(3, { timeout: 120_000 })
  await expect(page.locator('td[data-mark=range]').first()).toBeVisible()
  await shot(page, 'review-pending-04-submitted')
})

test('p4. the author replies to the range thread and resolves it; dg agrees', async ({ browser }) => {
  const page = await signedIn(browser, 'CONTRIB', files())
  await waitForRepoResolved(page)
  const view = dg('OWNER', 'pr', 'view', SLUG, String(prNumber), '--comments') as unknown as View
  const range = view.threads.find((t) => t.location === `${FILE}:3-5`)
  expect(range).toBeDefined()
  const thread = page.locator(`[data-testid=thread][data-root="${range!.id}"]`)
  await expect(thread).toBeVisible({ timeout: 180_000 })
  await thread.getByRole('button', { name: 'Reply' }).click()
  await thread.getByRole('textbox', { name: 'Reply' }).fill('Done in the next commit.')
  await thread.getByRole('button', { name: 'Reply' }).last().click()
  await expect(thread.getByTestId('thread-comment')).toHaveCount(2, { timeout: 120_000 })
  await thread.getByRole('button', { name: 'Resolve conversation' }).click()
  await confirmWrite(page, /sign & resolve/i)
  await expect(page.locator(`[data-testid=thread-collapsed][data-root="${range!.id}"]`)).toBeVisible({ timeout: 120_000 })
  const after = dg('OWNER', 'pr', 'view', SLUG, String(prNumber), '--comments') as unknown as View
  expect(after.threads.find((t) => t.id === range!.id)?.resolved).toBe(true)
  await shot(page, 'review-pending-05-resolved')
})

test('p5. the reviewer edits one comment ("edited") and deletes another', async ({ browser }) => {
  const page = await signedIn(browser, 'COLLAB', files())
  await waitForRepoResolved(page)
  const view = dg('OWNER', 'pr', 'view', SLUG, String(prNumber), '--comments') as unknown as View
  const two = view.threads.find((t) => t.location === `${FILE}:2`)!
  const nine = view.threads.find((t) => t.location === `${FILE}:9`)!
  const edit = page.locator(`[data-testid=thread-comment][data-id="${two.id}"]`)
  await expect(edit).toBeVisible({ timeout: 180_000 })
  await edit.getByRole('button', { name: 'Edit comment' }).click()
  await edit.getByRole('textbox', { name: 'Edit comment' }).fill('Why ten times? (edited)')
  await edit.getByRole('button', { name: 'Save' }).click()
  await confirmWrite(page, /sign & save/i)
  await expect(edit).toContainText('(edited)', { timeout: 120_000 })
  await expect(edit.getByTestId('edited-marker')).toBeVisible()
  const del = page.locator(`[data-testid=thread-comment][data-id="${nine.id}"]`)
  await del.getByRole('button', { name: 'Delete comment' }).click()
  await confirmWrite(page, /sign & delete/i)
  await expect(del).toHaveCount(0, { timeout: 120_000 })
  const after = dg('OWNER', 'pr', 'view', SLUG, String(prNumber), '--comments') as unknown as View
  expect(after.comments.some((c) => c.id === nine.id)).toBe(false)
  expect(after.comments.find((c) => c.id === two.id)?.body).toBe('Why ten times? (edited)')
})

test('p6. a review made with dg shows in the web', async ({ browser }) => {
  dg('OWNER', 'pr', 'review', SLUG, String(prNumber), '--approve', '--body', 'LGTM from the CLI', '--file', FILE, '--line', '11', '--body', 'CLI line comment')
  const page = await signedIn(browser, 'OWNER', `/repo/pull/?owner=${ids.owner}&name=${REPO}&number=${prNumber}`)
  await waitForRepoResolved(page)
  await expect(page.getByTestId('reviewers-card').locator(`[data-testid=reviewer-row][data-identity="${ids.owner}"]`)).toHaveAttribute('data-state', 'approved', { timeout: 180_000 })
  await expect(page.getByText('LGTM from the CLI')).toBeVisible()
  await page.getByTestId('pr-tab-files').click()
  await expect(page.getByTestId('thread').filter({ hasText: 'CLI line comment' })).toBeVisible({ timeout: 180_000 })
})

test('p7. a single comment posts at once; axe clean on the Files tab', async ({ browser }) => {
  const page = await signedIn(browser, 'OWNER', files())
  await waitForRepoResolved(page)
  await expect(lineButton(page, 12)).toBeVisible({ timeout: 180_000 })
  await lineButton(page, 12).click()
  await page.getByRole('textbox', { name: `Your comment on ${FILE} line 12 (new)` }).fill('A single comment.')
  await page.getByRole('button', { name: 'Add single comment' }).click()
  await expect(page.getByTestId('thread').filter({ hasText: 'A single comment.' })).toBeVisible({ timeout: 180_000 })
  expect(await runAxe(page, 'PR files with threads')).toEqual([])
})
