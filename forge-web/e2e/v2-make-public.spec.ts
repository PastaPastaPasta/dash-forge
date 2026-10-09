/**
 * An author makes their own members-only posts public (DESIGN §4.6, §10, §12 item 15; stream R5),
 * against a scratch repo seeded on the devnet with `dg … --members`. It writes, so it runs only
 * when pointed at that repo:
 *
 * - the make-public dialog warns when the text quotes someone else's members-only words, and
 *   nothing is broadcast while it is open;
 * - a reader-role author makes their own members-only comment public, and a logged-out visitor
 *   reads it;
 * - a review's author makes its text public (a public comment attached to the review), and a
 *   logged-out visitor sees that text in place of the review's placeholder.
 *
 * The repo: a public issue E2E_MP_ISSUE with the author's members-only comment holding
 * E2E_MP_MARKER, the author's members-only comment holding E2E_MP_QUOTING (which quotes another
 * member's members-only comment), and a public PR E2E_MP_PULL with the reviewer's members-only
 * review holding E2E_MP_REVIEW_MARKER. Identities (E2E_IDENTITY_DIR): E2E_MP_AUTHOR (default
 * `reader`) and E2E_MP_REVIEWER (default `writer`), each file with its encryption key.
 *
 *   E2E_MP_OWNER=… E2E_MP_NAME=… E2E_MP_ISSUE=1 E2E_MP_PULL=2 E2E_MP_MARKER=… E2E_MP_QUOTING=… \
 *   E2E_MP_REVIEW_MARKER=… E2E_IDENTITY_DIR=… pnpm exec playwright test v2-make-public.spec.ts
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type Browser, type Page } from '@playwright/test'
import { DAPI_METHOD, PASSPHRASE, idFile, runAxe, stateFile, unlock, waitForRepoResolved } from './helpers'

const OWNER = process.env['E2E_MP_OWNER'] ?? ''
const NAME = process.env['E2E_MP_NAME'] ?? ''
const ISSUE = process.env['E2E_MP_ISSUE'] ?? ''
const PULL = process.env['E2E_MP_PULL'] ?? ''
const MARKER = process.env['E2E_MP_MARKER'] ?? ''
const QUOTING = process.env['E2E_MP_QUOTING'] ?? ''
const REVIEW_MARKER = process.env['E2E_MP_REVIEW_MARKER'] ?? ''
const AUTHOR = process.env['E2E_MP_AUTHOR'] ?? 'reader'
const REVIEWER = process.env['E2E_MP_REVIEWER'] ?? 'writer'
const SHOTS = process.env['E2E_MP_SHOTS'] ?? join(__dirname, 'test-results', 'make-public')

test.describe.configure({ mode: 'serial', timeout: 400_000 })
test.skip(!OWNER || !NAME || !ISSUE || !PULL || !MARKER || !QUOTING || !REVIEW_MARKER, 'needs the make-public scratch repo: E2E_MP_OWNER, _NAME, _ISSUE, _PULL, _MARKER, _QUOTING, _REVIEW_MARKER')
test.skip(!existsSync(idFile(AUTHOR)) || !existsSync(idFile(REVIEWER)), `needs the ${AUTHOR} and ${REVIEWER} identity files (E2E_IDENTITY_DIR)`)

const url = (path: string, n: string): string => `/repo${path}/?owner=${OWNER}&name=${NAME}&number=${n}`

/** A context signed in as `name`, its identity file's encryption key in this browser. */
async function signedInAs(browser: Browser, name: string): Promise<Page> {
  const saved = stateFile(name)
  const context = await browser.newContext(existsSync(saved) ? { storageState: saved } : {})
  const page = await context.newPage()
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  if (existsSync(saved)) {
    await unlock(page)
  } else {
    await page.getByRole('banner').getByRole('button', { name: /^sign in$/i }).first().click()
    await page.getByTestId('tile-import').click()
    await page.setInputFiles('input[type="file"]', idFile(name))
    await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
    await page.getByLabel('Repeat passphrase').fill(PASSPHRASE)
    await page.getByTestId('enable-private-repos').check()
    await page.getByRole('button', { name: /create this browser's key/i }).click()
    await expect(page.getByTestId('funds-pill')).toBeVisible({ timeout: 120_000 })
    mkdirSync(join(__dirname, '.playwright', 'auth'), { recursive: true, mode: 0o700 })
    await context.storageState({ path: saved, indexedDB: true })
  }
  return page
}

/** Open a thread and, for a member whose tab holds the key locked, unlock it inline. */
async function openThread(page: Page, path: string, readable: string): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page, 120_000)
  const offer = page.getByTestId('members-only-unlock')
  const text = page.getByText(readable).first()
  await expect(offer.or(text).first()).toBeVisible({ timeout: 120_000 })
  if (await offer.isVisible()) {
    await offer.click()
    const panel = page.getByTestId('members-only-unlock-panel')
    await panel.getByLabel('Passphrase').fill(PASSPHRASE)
    await panel.getByRole('button', { name: /^unlock$/i }).click()
  }
  await expect(text).toBeVisible({ timeout: 120_000 })
}

/** Count broadcasts the page sends from now on. */
function broadcasts(page: Page): string[] {
  const out: string[] = []
  page.on('request', (r) => {
    const m = DAPI_METHOD.exec(r.url())
    if (m && /broadcast/i.test(m[1] ?? '')) out.push(m[1] ?? '')
  })
  return out
}

test('author: the dialog warns when the text quotes someone else’s members-only words', async ({ browser }) => {
  const page = await signedInAs(browser, AUTHOR)
  await openThread(page, url('/issue', ISSUE), QUOTING)
  const sent = broadcasts(page)
  const card = page.getByTestId('timeline-comment').filter({ hasText: QUOTING })
  await expect(card).toHaveAttribute('data-audience', 'members')
  await card.getByTestId('make-public').click()
  const dialog = page.getByRole('dialog', { name: 'Make your comment public?' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText("Everyone will be able to read it as you save it now. Earlier versions stay members-only. This can't be undone.")
  await expect(dialog).toContainText(/Your comment quotes @\S+'s members-only comment\. Everyone will be able to read the quoted text\./)
  await expect(dialog.getByRole('button', { name: 'Make public anyway' })).toBeVisible()
  mkdirSync(SHOTS, { recursive: true })
  await page.waitForTimeout(500) // the dialog's open animation
  await page.screenshot({ path: join(SHOTS, 'quote-check-dialog.png') })
  await page.waitForTimeout(3_000)
  expect(sent).toEqual([])
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  expect(sent).toEqual([])
  await page.context().close()
})

test('author: makes their own members-only comment public', async ({ browser }) => {
  const page = await signedInAs(browser, AUTHOR)
  await openThread(page, url('/issue', ISSUE), MARKER)
  const card = page.getByTestId('timeline-comment').filter({ hasText: MARKER })
  await card.getByTestId('make-public').click()
  const dialog = page.getByRole('dialog', { name: 'Make your comment public?' })
  await expect(dialog).not.toContainText('quotes')
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(SHOTS, 'make-public-dialog.png') })
  await dialog.getByRole('button', { name: 'Make public' }).click()
  await expect(page.getByTestId('timeline-comment').filter({ hasText: MARKER })).toHaveAttribute('data-audience', 'public', { timeout: 240_000 })
  await page.screenshot({ path: join(SHOTS, 'author-after.png'), fullPage: true })
  await page.context().close()
})

test('anon: reads the comment made public', async ({ page }) => {
  await page.goto(url('/issue', ISSUE), { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page, 120_000)
  const card = page.getByTestId('timeline-comment').filter({ hasText: MARKER })
  await expect(card).toBeVisible({ timeout: 240_000 })
  await expect(card).toHaveAttribute('data-audience', 'public')
  // the other, still members-only, comment stays a placeholder
  expect(await page.content()).not.toContain(QUOTING)
  await page.screenshot({ path: join(SHOTS, 'anon-issue.png'), fullPage: true })
  expect(await runAxe(page, 'issue with a made-public comment (anon)')).toEqual([])
})

test("reviewer: makes their members-only review's text public", async ({ browser }) => {
  const page = await signedInAs(browser, REVIEWER)
  await openThread(page, url('/pull', PULL), REVIEW_MARKER)
  const card = page.getByTestId('timeline-review').filter({ hasText: REVIEW_MARKER })
  await expect(card).toHaveAttribute('data-audience', 'members')
  await card.getByTestId('make-public').click()
  const dialog = page.getByRole('dialog', { name: "Make your review's text public?" })
  await expect(dialog).toContainText("It's added as a public comment on your review. This can't be undone.")
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(SHOTS, 'review-dialog.png') })
  await dialog.getByRole('button', { name: 'Make public' }).click()
  await expect(page.getByTestId('review-text-made-public')).toBeVisible({ timeout: 240_000 })
  await page.context().close()
})

test('anon: the review’s text shows in place of its placeholder', async ({ page }) => {
  await page.goto(url('/pull', PULL), { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page, 120_000)
  const card = page.getByTestId('timeline-review').filter({ hasText: REVIEW_MARKER })
  await expect(card).toBeVisible({ timeout: 240_000 })
  await expect(card.getByTestId('review-text-made-public')).toContainText('Review text made public by')
  await expect(page.getByTestId('members-only-placeholder').filter({ hasText: /review/i })).toHaveCount(0)
  // the carrying comment is not shown again on its own
  await expect(page.getByTestId('timeline-comment').filter({ hasText: REVIEW_MARKER })).toHaveCount(0)
  await page.screenshot({ path: join(SHOTS, 'anon-pull.png'), fullPage: true })
  expect(await runAxe(page, 'PR with a made-public review text (anon)')).toEqual([])
})
