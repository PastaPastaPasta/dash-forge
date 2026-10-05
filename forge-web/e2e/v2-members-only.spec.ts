/**
 * Members-only content in a public repo, as people see it (DESIGN §2.3, §10, D14; stream 1D),
 * read-only against a scratch repo seeded with `dg … --members` on the devnet:
 *
 * - an outsider and a member see exactly the public rows §2.3 promises: the members-only issue's
 *   row and "#N · members-only" page, a member's members-only comment as a placeholder, and no
 *   byte of the members-only text (the marker) anywhere;
 * - a member reads it, and their "View as public" renders the thread's text exactly as the
 *   outsider's capture (relative times aside);
 * - a public reply that quotes members-only text is blocked by a confirmation until confirmed
 *   (nothing is broadcast while it is open).
 *
 * The repo: a public issue E2E_MEMBERS_ISSUE with a public comment by someone other than the
 * outsider and a member's `--members` comment containing E2E_MEMBERS_MARKER on its own line,
 * and a members-only issue E2E_MEMBERS_SEALED. Identities (E2E_IDENTITY_DIR): `member` (a writer
 * whose identity file holds its encryption key) and `outsider`.
 *
 *   E2E_MEMBERS_OWNER=… E2E_MEMBERS_NAME=… E2E_MEMBERS_ISSUE=2 E2E_MEMBERS_SEALED=3 \
 *   E2E_MEMBERS_MARKER=QAMARK E2E_IDENTITY_DIR=… pnpm exec playwright test v2-members-only.spec.ts
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type Browser, type Page } from '@playwright/test'
import { DAPI_METHOD, PASSPHRASE, idFile, runAxe, stateFile, unlock, waitForRepoResolved } from './helpers'

const OWNER = process.env['E2E_MEMBERS_OWNER'] ?? ''
const NAME = process.env['E2E_MEMBERS_NAME'] ?? ''
const ISSUE = process.env['E2E_MEMBERS_ISSUE'] ?? ''
const SEALED = process.env['E2E_MEMBERS_SEALED'] ?? ''
const MARKER = process.env['E2E_MEMBERS_MARKER'] ?? ''
const MEMBER = process.env['E2E_MEMBERS_MEMBER'] ?? 'member'
const OUTSIDER = process.env['E2E_MEMBERS_OUTSIDER'] ?? 'outsider'

test.describe.configure({ mode: 'serial', timeout: 300_000 })
test.skip(!OWNER || !NAME || !ISSUE || !SEALED || !MARKER, 'needs the members-only scratch repo: E2E_MEMBERS_OWNER, _NAME, _ISSUE, _SEALED, _MARKER')
test.skip(!existsSync(idFile(MEMBER)) || !existsSync(idFile(OUTSIDER)), `needs the ${MEMBER} and ${OUTSIDER} identity files (E2E_IDENTITY_DIR)`)

const url = (path: string, extra = ''): string => `/repo${path}/?owner=${OWNER}&name=${NAME}${extra}`
const issueUrl = (n: string): string => url('/issue', `&number=${n}`)

/** The thread's text with relative times (which tick between captures) made equal. */
const steady = (text: string): string => text.replace(/\b(just now|\d+(m|h|d|mo|y) ago)\b/g, '·age·').replace(/\s+/g, ' ').trim()

/** A context signed in as `name` (an identity import, with its encryption key for a member). */
async function signedInAs(browser: Browser, name: string, encryption: boolean): Promise<Page> {
  const saved = stateFile(name)
  const context = await browser.newContext(existsSync(saved) ? { storageState: saved } : {})
  const page = await context.newPage()
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  if (existsSync(saved)) {
    await unlock(page)
    return page
  }
  await page.getByRole('banner').getByRole('button', { name: /^sign in$/i }).first().click()
  await page.getByTestId('tile-import').click()
  await page.setInputFiles('input[type="file"]', idFile(name))
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
  await page.getByLabel('Repeat passphrase').fill(PASSPHRASE)
  if (encryption) await page.getByTestId('enable-private-repos').check()
  await page.getByRole('button', { name: /create this browser's key/i }).click()
  await expect(page.getByTestId('funds-pill')).toBeVisible({ timeout: 120_000 })
  mkdirSync(join(__dirname, '.playwright', 'auth'), { recursive: true, mode: 0o700 })
  await context.storageState({ path: saved, indexedDB: true })
  return page
}

/**
 * Open `path` in `page` and wait for the issue page to settle. A member's tab that resumed with
 * the signing key only unlocks its encryption key inline first ("Unlock to read members-only
 * content"), as a reload asks.
 */
async function openIssue(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page, 120_000)
  await expect(page.getByTestId('thread-conversation').or(page.getByTestId('members-only-target'))).toBeVisible({ timeout: 120_000 })
}

/** A member's in-tab unlock of the encryption key, where the page offers one. */
async function unlockMembers(page: Page): Promise<void> {
  const offer = page.getByTestId('members-only-unlock')
  if (!(await offer.isVisible().catch(() => false))) return
  await offer.click()
  const panel = page.getByTestId('members-only-unlock-panel')
  await panel.getByLabel('Passphrase').fill(PASSPHRASE)
  await panel.getByRole('button', { name: /^unlock$/i }).click()
  await expect(page.getByTestId('members-only-locked')).toBeHidden({ timeout: 120_000 })
}

let outsiderThread = ''

test('anon: the members-only issue is a row, and its number a "#N · members-only" page', async ({ page }) => {
  await page.goto(url('/issues', '&state=all'), { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page, 120_000)
  const row = page.locator(`[data-testid="issue-row"][data-number="${SEALED}"]`)
  await expect(row).toBeVisible({ timeout: 120_000 })
  await expect(row.getByTestId('members-only-title')).toHaveText(/Members-only issue/)
  expect(await page.locator('main').innerText()).not.toContain(MARKER)
  for (const path of [issueUrl(SEALED), url('/number', `&number=${SEALED}`)]) {
    await page.goto(path, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('members-only-target')).toBeVisible({ timeout: 120_000 })
    await expect(page.getByTestId('members-only-target').locator('h1')).toHaveText(`#${SEALED} · members-only`)
    await expect(page.getByText(/not found/i)).toHaveCount(0)
    expect(await page.locator('main').innerText()).not.toContain(MARKER)
  }
  expect(await runAxe(page, 'members-only target (anon)')).toEqual([])
})

test("outsider: the member's members-only comment is a placeholder, and nothing of its text is anywhere", async ({ browser }) => {
  const page = await signedInAs(browser, OUTSIDER, false)
  await openIssue(page, issueUrl(ISSUE))
  await expect(page.getByTestId('members-only-placeholder').first()).toBeVisible({ timeout: 120_000 })
  await expect(page.getByTestId('members-only-placeholder').first()).toContainText('Members-only comment')
  const html = await page.content()
  expect(html).not.toContain(MARKER)
  await expect(page.getByText(/encrypted by someone who is not a member/)).toHaveCount(0)
  // The outsider's composer is public, with no picker.
  await expect(page.getByTestId('audience-chip')).toHaveText(/Public/)
  await expect(page.getByTestId('audience-chip')).toHaveJSProperty('tagName', 'SPAN')
  outsiderThread = steady(await page.getByTestId('thread-conversation').innerText())
  expect(await runAxe(page, 'issue with placeholders (outsider)')).toEqual([])
  await page.context().close()
})

test('member: reads it, and "View as public" shows exactly what the outsider saw', async ({ browser }) => {
  const page = await signedInAs(browser, MEMBER, true)
  await openIssue(page, issueUrl(ISSUE))
  await unlockMembers(page)
  await expect(page.getByTestId('timeline-comment').filter({ hasText: MARKER })).toBeVisible({ timeout: 120_000 })
  await expect(page.getByTestId('timeline-comment').filter({ hasText: MARKER }).getByTestId('visible-to-members')).toHaveText(/Visible to members/)
  await page.getByTestId('view-as-public').click()
  await expect(page.getByTestId('public-view-banner')).toContainText('Viewing as the public sees it.')
  await expect(page.getByTestId('members-only-placeholder').first()).toBeVisible({ timeout: 120_000 })
  expect(await page.content()).not.toContain(MARKER)
  expect(steady(await page.getByTestId('thread-conversation').innerText())).toBe(outsiderThread)
  await page.getByTestId('exit-public-view').click()
  await expect(page.getByTestId('timeline-comment').filter({ hasText: MARKER })).toBeVisible({ timeout: 120_000 })
  await page.context().close()
})

test('member: a public reply quoting members-only text is blocked until confirmed', async ({ browser }) => {
  const page = await signedInAs(browser, MEMBER, true)
  await openIssue(page, issueUrl(ISSUE))
  await unlockMembers(page)
  const quoted = page.getByTestId('timeline-comment').filter({ hasText: MARKER })
  await expect(quoted).toBeVisible({ timeout: 120_000 })
  // Nothing may be broadcast while the confirmation is open.
  const broadcasts: string[] = []
  page.on('request', (r) => {
    const m = DAPI_METHOD.exec(r.url())
    if (m && /broadcast/i.test(m[1] ?? '')) broadcasts.push(m[1] ?? '')
  })
  await expect(page.getByTestId('audience-chip')).toContainText('Public')
  await page.locator('#comment-body').fill(`> ${MARKER}\n\nquoting it`)
  await page.getByTestId('issue-composer').getByRole('button', { name: /^comment$/i }).click()
  const dialog = page.getByRole('dialog', { name: 'Post members-only text publicly?' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText("You're quoting a members-only comment into a public reply. Everyone will be able to read the quoted text.")
  await page.waitForTimeout(3_000)
  expect(broadcasts).toEqual([])
  await dialog.getByTestId('quote-cancel').click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('#comment-body')).toHaveValue(`> ${MARKER}\n\nquoting it`)
  expect(broadcasts).toEqual([])
  await page.locator('#comment-body').fill('')
  await page.context().close()
})
