/**
 * Messages to specific people, as people see them (DESIGN §4.2, §10, D14; stream 2A), read-only
 * against a scratch repo seeded with `dg … --to` on the devnet:
 *
 * - an anonymous visitor sees how many people each message went to ("Comment to 3 people",
 *   "Issue to 2 people"), its author and time, and no byte of its text (the marker);
 * - a recipient reads both, with who they went to ("Visible to … (maintainers when sent)");
 * - a member who is not a recipient sees the placeholders only;
 * - the composer's picker offers the §10 options ("Who can read this?": Public, Members,
 *   Maintainers, Writers and maintainers, Specific people…), and, in a repo with more than 16
 *   writers, disables Writers and maintainers with its size.
 *
 * The repo: a public issue E2E_LETTERS_ISSUE with a comment sent to Maintainers
 * (`dg issue comment --to maintainers`), and an issue E2E_LETTERS_LETTER sent to specific people
 * (`dg issue create --to @a,@b`), both containing E2E_LETTERS_MARKER on a line of their own.
 * Identities (E2E_IDENTITY_DIR): E2E_LETTERS_RECIPIENT (default `member`: a maintainer named in
 * the issue too, whose identity file holds its encryption key) and E2E_LETTERS_OTHER (default
 * `reader`: a member who is in neither). Optional: E2E_LETTERS_COMMENT_TO / E2E_LETTERS_ISSUE_TO
 * (the recipient counts, checked exactly when set), and E2E_LETTERS_BIG_OWNER / _BIG_NAME /
 * _BIG_ISSUE (a repo with more than 16 writers and maintainers, and an issue in it).
 *
 *   E2E_LETTERS_OWNER=… E2E_LETTERS_NAME=… E2E_LETTERS_ISSUE=2 E2E_LETTERS_LETTER=3 \
 *   E2E_LETTERS_MARKER=QAMARK E2E_IDENTITY_DIR=… pnpm exec playwright test v2-letters.spec.ts
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test'
import { PASSPHRASE, idFile, runAxe, stateFile, unlock, waitForRepoResolved } from './helpers'

const OWNER = process.env['E2E_LETTERS_OWNER'] ?? ''
const NAME = process.env['E2E_LETTERS_NAME'] ?? ''
const ISSUE = process.env['E2E_LETTERS_ISSUE'] ?? ''
const LETTER = process.env['E2E_LETTERS_LETTER'] ?? ''
const MARKER = process.env['E2E_LETTERS_MARKER'] ?? ''
const RECIPIENT = process.env['E2E_LETTERS_RECIPIENT'] ?? 'member'
const OTHER = process.env['E2E_LETTERS_OTHER'] ?? 'reader'
const COMMENT_TO = process.env['E2E_LETTERS_COMMENT_TO'] ?? ''
const ISSUE_TO = process.env['E2E_LETTERS_ISSUE_TO'] ?? ''
const BIG_OWNER = process.env['E2E_LETTERS_BIG_OWNER'] ?? ''
const BIG_NAME = process.env['E2E_LETTERS_BIG_NAME'] ?? ''
const BIG_ISSUE = process.env['E2E_LETTERS_BIG_ISSUE'] ?? ''

test.describe.configure({ mode: 'serial', timeout: 300_000 })
test.skip(!OWNER || !NAME || !ISSUE || !LETTER || !MARKER, 'needs the letters scratch repo: E2E_LETTERS_OWNER, _NAME, _ISSUE, _LETTER, _MARKER')
test.skip(!existsSync(idFile(RECIPIENT)) || !existsSync(idFile(OTHER)), `needs the ${RECIPIENT} and ${OTHER} identity files (E2E_IDENTITY_DIR)`)

const url = (path: string, extra = '', owner = OWNER, name = NAME): string => `/repo${path}/?owner=${owner}&name=${name}${extra}`
const issueUrl = (n: string): string => url('/issue', `&number=${n}`)

/** "Comment to 3 people" with the count the env gives, else any count. */
const to = (noun: string, count: string): RegExp => new RegExp(`${noun} to ${count === '' ? '\\d+' : count} (person|people)`)

async function snap(page: Page, info: TestInfo, name: string): Promise<void> {
  await info.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
}

/** A context signed in as `name` (an identity import, with its encryption key in this browser). */
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
  await ensureEncryptionKey(page, name)
  return page
}

/** Settings → Private repos: this browser holds the identity's encryption key (added from its file once). */
async function ensureEncryptionKey(page: Page, name: string): Promise<void> {
  await page.goto('/settings/', { waitUntil: 'domcontentloaded' })
  await unlock(page)
  await expect(page.getByTestId('encryption-key-panel')).toBeVisible({ timeout: 60_000 })
  const stored = page.getByTestId('encryption-key-stored')
  const file = page.locator('#enc-file')
  const prompt = page.getByTestId('encryption-unlock')
  await expect(stored.or(file).or(prompt).first()).toBeVisible({ timeout: 60_000 })
  if (await prompt.isVisible()) {
    await prompt.getByLabel('Passphrase').fill(PASSPHRASE)
    await prompt.getByRole('button', { name: /^unlock$/i }).click()
    await expect(stored.or(file).first()).toBeVisible({ timeout: 60_000 })
  }
  if (!(await stored.isVisible())) {
    await file.setInputFiles(idFile(name))
    await expect(stored).toBeVisible({ timeout: 60_000 })
  }
}

/** Open an issue page and wait for it to settle (its thread, or the "#N" page of one this reader can't open). */
async function openIssue(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page, 120_000)
  await expect(page.getByTestId('thread-conversation').or(page.getByTestId('members-only-target'))).toBeVisible({ timeout: 120_000 })
}

/** A tab that resumed with the signing key only: unlock the encryption key where a message offers it. */
async function unlockLetters(page: Page, readable: ReturnType<Page['getByTestId']>): Promise<void> {
  const offer = page.getByTestId('letter-unlock').first()
  const target = page.getByTestId('letter-target-unlock')
  await expect(offer.or(target).or(readable).first()).toBeVisible({ timeout: 120_000 })
  if (await readable.first().isVisible()) return
  if (await offer.isVisible()) await offer.click()
  const panel = page.getByTestId('letter-unlock-panel').or(target).first()
  await panel.getByLabel('Passphrase').fill(PASSPHRASE)
  await panel.getByRole('button', { name: /^unlock$/i }).click()
  await expect(readable.first()).toBeVisible({ timeout: 120_000 })
}

test('anon: each message says how many people it went to, and nothing of its text', async ({ page }, info) => {
  await openIssue(page, issueUrl(ISSUE))
  const placeholder = page.locator('[data-testid="members-only-placeholder"][data-audience="specificPeople"]').first()
  await expect(placeholder).toBeVisible({ timeout: 120_000 })
  await expect(placeholder).toContainText(to('Comment', COMMENT_TO))
  expect(await page.content()).not.toContain(MARKER)
  await snap(page, info, 'anon-letter-comment')
  // The issue sent to specific people: a row and a "#N" page with its count, never "not found".
  await page.goto(url('/issues', '&state=all'), { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page, 120_000)
  const row = page.locator(`[data-testid="issue-row"][data-number="${LETTER}"]`)
  await expect(row).toBeVisible({ timeout: 120_000 })
  await expect(row.getByTestId('members-only-title')).toHaveText(to('Issue', ISSUE_TO))
  await openIssue(page, issueUrl(LETTER))
  await expect(page.getByTestId('members-only-target')).toContainText(to('Issue', ISSUE_TO))
  await expect(page.getByTestId('members-only-target').locator('h1')).toHaveText(new RegExp(`^#${LETTER} · to \\d+ (person|people)$`))
  await expect(page.getByText(/not found/i)).toHaveCount(0)
  expect(await page.content()).not.toContain(MARKER)
  await snap(page, info, 'anon-letter-issue')
  expect(await runAxe(page, 'letter target (anon)')).toEqual([])
})

test('recipient: reads both, with who they went to', async ({ browser }, info) => {
  const page = await signedInAs(browser, RECIPIENT)
  await openIssue(page, issueUrl(ISSUE))
  const comment = page.getByTestId('timeline-comment').filter({ hasText: MARKER })
  await unlockLetters(page, comment)
  await expect(comment).toHaveAttribute('data-audience', 'specificPeople')
  const label = comment.getByTestId('visible-to-people')
  await expect(label).toHaveText(/^Visible to .+ \(maintainers when sent\)( and .+)?$/)
  await expect(label).toHaveAttribute('title', 'as listed by the sender')
  await snap(page, info, 'recipient-letter-comment')
  await openIssue(page, issueUrl(LETTER))
  const body = page.getByTestId('thread-conversation')
  await expect(body).toContainText(MARKER, { timeout: 120_000 })
  await expect(body.getByTestId('visible-to-people').first()).toHaveText(/^Visible to .*you$/)
  // a reply in it goes to the same people: only Specific people is offered
  const chip = page.getByTestId('issue-composer').getByTestId('audience-chip')
  await expect(chip).toBeVisible()
  await chip.click()
  await expect(page.getByTestId('audience-option-people')).toBeVisible()
  await expect(page.getByTestId('audience-option-public')).toHaveCount(0)
  await expect(page.getByTestId('people-picker')).toBeVisible()
  await snap(page, info, 'recipient-letter-issue')
  await page.context().close()
})

test('a member who is not a recipient sees the placeholders only', async ({ browser }, info) => {
  const page = await signedInAs(browser, OTHER)
  await openIssue(page, issueUrl(ISSUE))
  const placeholder = page.locator('[data-testid="members-only-placeholder"][data-audience="specificPeople"]').first()
  await expect(placeholder).toBeVisible({ timeout: 120_000 })
  await expect(placeholder).toContainText(to('Comment', COMMENT_TO))
  expect(await page.content()).not.toContain(MARKER)
  await openIssue(page, issueUrl(LETTER))
  await expect(page.getByTestId('members-only-target')).toContainText(to('Issue', ISSUE_TO))
  expect(await page.content()).not.toContain(MARKER)
  await snap(page, info, 'other-member-placeholders')
  await page.context().close()
})

test('the picker offers the §10 options', async ({ browser }, info) => {
  const page = await signedInAs(browser, RECIPIENT)
  await openIssue(page, issueUrl(ISSUE))
  const chip = page.getByTestId('issue-composer').getByTestId('audience-chip')
  await expect(chip).toBeVisible({ timeout: 120_000 })
  await chip.click()
  const picker = page.getByTestId('audience-picker')
  await expect(picker).toContainText('Who can read this?')
  await expect(page.getByTestId('audience-option-public')).toBeVisible()
  await expect(page.getByTestId('audience-option-maintainers')).toContainText(/Maintainers \(\d+\)/)
  await expect(page.getByTestId('audience-option-maintainers')).toContainText(/Sent to the \d+ current maintainers\. People who become maintainers later see it only if someone adds them\./)
  await expect(page.getByTestId('audience-option-writers')).toContainText(/Writers and maintainers \(\d+\)/)
  await expect(page.getByTestId('audience-option-people')).toContainText("Specific people…You're always included. Up to 16 people.")
  await snap(page, info, 'picker-options')
  await page.getByTestId('audience-option-maintainers').locator('input').check()
  await expect(chip).toContainText(/Maintainers \(\d+\)/)
  await page.context().close()
})

test('a repo with more than 16 writers: Writers and maintainers is disabled with its size', async ({ browser }, info) => {
  test.skip(!BIG_OWNER || !BIG_NAME || !BIG_ISSUE, 'needs a repo with more than 16 writers: E2E_LETTERS_BIG_OWNER, _BIG_NAME, _BIG_ISSUE')
  const page = await signedInAs(browser, RECIPIENT)
  await openIssue(page, url('/issue', `&number=${BIG_ISSUE}`, BIG_OWNER, BIG_NAME))
  await page.getByTestId('issue-composer').getByTestId('audience-chip').click()
  const writers = page.getByTestId('audience-option-writers')
  await expect(writers.locator('input')).toBeDisabled({ timeout: 120_000 })
  await expect(writers.getByTestId('audience-too-many')).toHaveText(/^Writers and maintainers is \d+ people\. A message can go to at most 16\. Choose All members or pick people\.$/)
  await snap(page, info, 'picker-too-many')
  await page.context().close()
})
