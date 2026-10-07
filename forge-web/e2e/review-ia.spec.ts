import { test, expect, type Page } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atRoute, idFile, idOf, routeOf, runAxe, shot, signedIn, unlock, waitForRepoResolved } from './helpers'

/**
 * The PR page's information architecture, drafts and head sync (review-parity spec §7 PR 3),
 * live on a devnet with the spec's own identities (real spend, about 0.01 DASH):
 *
 *   E2E_DEVNET=sakura E2E_WRITE=1 E2E_IDENTITY_DIR=<dir with OWNER, CONTRIB, COLLAB> \
 *     E2E_BIN_DIR=<dir with dg + git-remote-dash> pnpm exec playwright test review-ia.spec.ts
 *
 * The CLI sets up what a browser cannot (a repo with a pushed `main`, a fork, a feature branch
 * pushed to it); every PR action is taken in the web UI through its confirm dialog:
 *
 *   i1. CONTRIB opens a DRAFT PR from the fork in the browser → "Draft" pill, no merge box,
 *       tabs Conversation / Commits (1) / Checks / Files changed (1), right rail.
 *   i2. CONTRIB marks it ready.
 *   i3. CONTRIB pushes a second commit with the CLI (auto-sync off) → the head-sync banner →
 *       "Update PR head" → the head moves, the timeline says "pushed 1 commit", Commits (2).
 *   i4. OWNER requests COLLAB's review → Reviewers card "Awaiting review".
 *   i5. COLLAB approves → "Approved"; the CLI (`dg pr view --json`) agrees.
 *   i6. OWNER dismisses it with a reason → "Dismissed", the approval no longer counts.
 *   i7. CONTRIB edits the title → the heading changes, "edited" on the description.
 *   i8. The short URL `/<owner>/<repo>/pull/<n>/files` opens Files changed; axe is clean.
 */

test.skip(process.env['E2E_WRITE'] !== '1', 'live devnet writes: set E2E_WRITE=1')
test.skip(!process.env['E2E_IDENTITY_DIR'], "set E2E_IDENTITY_DIR to this spec's own identities (never the shared fixtures)")
test.skip(!process.env['E2E_BIN_DIR'], 'set E2E_BIN_DIR to a directory holding dg and git-remote-dash')
test.skip(!!process.env['E2E_IDENTITY_DIR'] && !existsSync(idFile('CONTRIB')), 'OWNER / CONTRIB / COLLAB identity files not found')
test.describe.configure({ mode: 'serial', timeout: 600_000 })

const BIN = process.env['E2E_BIN_DIR'] ?? ''
const ids = process.env['E2E_IDENTITY_DIR'] ? { owner: idOf('OWNER'), contrib: idOf('CONTRIB'), collab: idOf('COLLAB') } : { owner: '', contrib: '', collab: '' }
const RUN = process.env['E2E_RUN'] ?? Date.now().toString(36)
const REPO = `review-ia-${RUN}`
const FORK = `review-ia-fork-${RUN}`
const SLUG = `${ids.owner}/${REPO}`
const WORK = join(tmpdir(), `dash-forge-${REPO}`)
const TITLE = 'Greet the forge'
let prNumber = 0

function env(who: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DASH_FORGE_KEY: idFile(who),
    DASH_FORGE_NETWORK: 'devnet',
    DASH_FORGE_DEVNET_NAME: process.env['E2E_DEVNET'] || 'sakura',
    RUST_LOG: 'error',
    NO_COLOR: '1',
    PATH: `${BIN}:${process.env['PATH'] ?? ''}`,
  }
}

/** `dg --yes --json …` as `who`; the parsed JSON. */
function dg(who: string, ...args: string[]): Record<string, unknown> {
  const out = execFileSync(join(BIN, 'dg'), ['--yes', '--json', ...args], { env: env(who), cwd: WORK, encoding: 'utf8', timeout: 240_000 })
  return JSON.parse(out) as Record<string, unknown>
}

/** git as `who` in `dir`. */
function git(who: string, dir: string, args: string[]): string {
  const r = spawnSync('git', ['-c', 'dash.confirm=never', '-c', 'dash.prAutoSync=false', ...args], { env: env(who), cwd: dir, encoding: 'utf8', timeout: 240_000 })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.stdout}${r.stderr}`)
  return r.stdout.trim()
}

function pr(extra = ''): string {
  return `/repo/pull/?owner=${ids.owner}&name=${REPO}&number=${prNumber}${extra}`
}

/** Confirm the open dialog: it must show a cost, then close once Platform shows the write. */
async function confirmWrite(page: Page, label: RegExp): Promise<void> {
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('cost-preview')).toBeVisible()
  await dialog.getByRole('button', { name: label }).click()
  await expect(dialog).toBeHidden({ timeout: 180_000 })
}

/** Reload until `check` holds (a node one block behind). A reload locks the vault: unlock. */
async function eventually(page: Page, check: () => Promise<void>, tries = 6): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await check()
      return
    } catch (e) {
      if (i >= tries) throw e
      await page.reload({ waitUntil: 'domcontentloaded' })
      await unlock(page)
      await waitForRepoResolved(page)
    }
  }
}

test.beforeAll(() => {
  test.setTimeout(900_000)
  if (!process.env['E2E_IDENTITY_DIR'] || !BIN) return
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(join(WORK, 'src', 'src'), { recursive: true })
  const src = join(WORK, 'src')
  const g = (...a: string[]): void => void execFileSync('git', a, { cwd: src })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'owner@e2e.forge.invalid')
  g('config', 'user.name', 'E2E Owner')
  g('config', 'commit.gpgsign', 'false')
  writeFileSync(join(src, 'src', 'greet.rs'), 'fn main() {\n    let name = "world";\n    println!("hello, {name}!");\n}\n')
  writeFileSync(join(src, 'README.md'), `# ${REPO}\n`)
  g('add', '.')
  g('commit', '-q', '-m', 'base: greet')
  dg('OWNER', 'repo', 'create', REPO, '--storage', 'platform', '--no-protect')
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
  gw('checkout', '-q', '-b', 'feature/greet', 'origin/main')
  writeFileSync(join(w, 'src', 'greet.rs'), 'fn main() {\n    let name = "forge";\n    println!("hello, {name}!");\n}\n')
  gw('commit', '-qam', TITLE)
  git('CONTRIB', w, ['push', '-q', `dash://${ids.contrib}/${FORK}`, 'feature/greet:refs/heads/feature/greet'])
})

test.afterAll(() => rmSync(WORK, { recursive: true, force: true }))

test('i1. the contributor opens a draft PR from the fork; tabs, counts and the rail', async ({ browser }) => {
  const page = await signedIn(browser, 'CONTRIB', `/repo/pulls/new/?owner=${ids.owner}&name=${REPO}`)
  await waitForRepoResolved(page)
  await eventually(page, () => expect(page.locator('#pr-head optgroup[label="Your forks"] option', { hasText: FORK }).first()).toBeAttached({ timeout: 45_000 }))
  // Labelled owner-first, `<owner>/<fork>:<branch>` (QW4-030).
  await page.getByLabel('Compare (your branch)').selectOption((await page.locator('#pr-head option', { hasText: `${FORK}:feature/greet` }).first().getAttribute('value')) ?? '')
  // The diff renders before anything is signed (the fork's head read through its packs).
  await expect(page.getByText('src/greet.rs').first()).toBeVisible({ timeout: 180_000 })
  await page.getByLabel('Title', { exact: true }).fill(TITLE)
  await page.getByLabel('Description', { exact: true }).fill('Greets the forge. Fixes #1')
  await page.getByLabel('Open as a draft').check()
  await page.getByRole('button', { name: 'Create draft pull request' }).click()
  await page.waitForURL(atRoute(/\/repo\/pull\/\?.*number=\d+/), { timeout: 180_000 })
  prNumber = Number(routeOf(page.url()).searchParams.get('number'))
  await expect(page.getByTestId('pr-state')).toHaveText('Draft', { timeout: 90_000 })
  await expect(page.getByTestId('draft-box')).toBeVisible()
  await expect(page.getByTestId('merge-panel')).toHaveCount(0)
  await expect(page.getByTestId('pr-tab-commits-count')).toHaveText('1', { timeout: 120_000 })
  await expect(page.getByTestId('pr-tab-files-count')).toHaveText('1')
  await expect(page.getByTestId('linked-issues')).toContainText('#1')
  await expect(page.getByRole('complementary', { name: 'Pull request details' })).toContainText(FORK)
  expect(await runAxe(page, 'draft PR')).toEqual([])
  await shot(page, 'review-ia-01-draft')
})

test('i2. the author marks it ready', async ({ browser }) => {
  test.skip(prNumber === 0, 'needs the PR from i1')
  const page = await signedIn(browser, 'CONTRIB', pr())
  await waitForRepoResolved(page)
  await page.getByRole('button', { name: 'Ready for review' }).click()
  await confirmWrite(page, /sign & mark ready/i)
  await expect(page.getByTestId('pr-state')).toHaveText('Open', { timeout: 120_000 })
  await expect(page.getByTestId('timeline-event').filter({ hasText: 'marked this ready for review' })).toBeVisible()
})

test('i3. a push to the branch → "Update PR head" → the PR follows; Commits (2)', async ({ browser }) => {
  test.skip(prNumber === 0, 'needs the PR from i1')
  const w = join(WORK, 'fork')
  writeFileSync(join(w, 'NOTES.md'), 'a second commit\n')
  execFileSync('git', ['add', 'NOTES.md'], { cwd: w })
  execFileSync('git', ['commit', '-qm', 'docs: notes'], { cwd: w })
  git('CONTRIB', w, ['push', '-q', `dash://${ids.contrib}/${FORK}`, 'feature/greet:refs/heads/feature/greet'])
  const head2 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: w, encoding: 'utf8' }).trim()

  const page = await signedIn(browser, 'CONTRIB', pr())
  await waitForRepoResolved(page)
  await eventually(page, () => expect(page.getByTestId('head-sync-banner')).toBeVisible({ timeout: 60_000 }))
  await expect(page.getByTestId('head-sync-banner')).toContainText('Your branch')
  await shot(page, 'review-ia-02-head-sync-banner')
  await page.getByRole('button', { name: 'Update PR head' }).click()
  await confirmWrite(page, /sign & update head/i)
  await expect(page.getByTestId('pr-head')).toContainText(head2.slice(0, 9), { timeout: 120_000 })
  await expect(page.getByTestId('head-sync-banner')).toHaveCount(0)
  await expect(page.getByTestId('timeline-event').filter({ hasText: /pushed 1 commit/ })).toBeVisible({ timeout: 120_000 })
  await expect(page.getByTestId('pr-tab-commits-count')).toHaveText('2', { timeout: 120_000 })
  await page.getByTestId('pr-tab-commits').click()
  await expect(page.getByTestId('pr-commit')).toHaveCount(2)
  await expect(page.getByTestId('pr-commits')).toContainText('docs: notes')
  await shot(page, 'review-ia-03-commits-tab')
})

test("i4. the owner requests COLLAB's review → Awaiting", async ({ browser }) => {
  test.skip(prNumber === 0, 'needs the PR from i1')
  const page = await signedIn(browser, 'OWNER', pr())
  await waitForRepoResolved(page)
  const card = page.getByTestId('reviewers-card')
  await card.getByRole('button', { name: 'Request a review' }).click()
  await card.locator(`[data-testid=reviewer-option][data-identity="${ids.collab}"]`).click()
  await confirmWrite(page, /sign & request/i)
  await expect(card.locator(`[data-testid=reviewer-row][data-identity="${ids.collab}"]`)).toHaveAttribute('data-state', 'awaiting', { timeout: 120_000 })
  await shot(page, 'review-ia-04-awaiting')
})

test('i5. COLLAB approves → Approved; dg pr view agrees', async ({ browser }) => {
  test.skip(prNumber === 0, 'needs the PR from i1')
  const page = await signedIn(browser, 'COLLAB', pr())
  await waitForRepoResolved(page)
  await page.getByRole('button', { name: /^approve$/i }).click()
  await confirmWrite(page, /submit review/i)
  const row = page.getByTestId('reviewers-card').locator(`[data-testid=reviewer-row][data-identity="${ids.collab}"]`)
  await expect(row).toHaveAttribute('data-state', 'approved', { timeout: 120_000 })
  const view = dg('OWNER', 'pr', 'view', SLUG, String(prNumber))
  const reviewers = view['reviewers'] as { identity: string; state: string }[]
  expect(reviewers.find((r) => r.identity === ids.collab)?.state).toBe('approved')
  expect(view['approvedBy']).toEqual([ids.collab])
})

test("i6. the owner dismisses the approval with a reason; it no longer counts", async ({ browser }) => {
  test.skip(prNumber === 0, 'needs the PR from i1')
  const page = await signedIn(browser, 'OWNER', pr())
  await waitForRepoResolved(page)
  const card = page.getByTestId('reviewers-card')
  const row = card.locator(`[data-testid=reviewer-row][data-identity="${ids.collab}"]`)
  await expect(row).toHaveAttribute('data-state', 'approved', { timeout: 90_000 })
  await row.getByRole('button', { name: 'Dismiss review' }).click()
  await row.getByLabel('Reason for dismissing').fill('approved before the notes landed')
  await row.getByRole('button', { name: /^dismiss$/i }).click()
  await confirmWrite(page, /sign & dismiss/i)
  await expect(row).toHaveAttribute('data-state', 'dismissed', { timeout: 120_000 })
  await expect(row).toContainText('approved before the notes landed')
  await expect(page.getByTestId('timeline-event').filter({ hasText: 'dismissed a review' })).toBeVisible()
  const view = dg('OWNER', 'pr', 'view', SLUG, String(prNumber))
  expect(view['approvedBy']).toEqual([])
  await shot(page, 'review-ia-05-dismissed')
})

test('i7. the author edits the title; "edited"', async ({ browser }) => {
  test.skip(prNumber === 0, 'needs the PR from i1')
  const page = await signedIn(browser, 'CONTRIB', pr())
  await waitForRepoResolved(page)
  await page.getByRole('button', { name: /^edit$/i }).first().click()
  await page.getByLabel('Title').fill(`${TITLE} (edited ${RUN})`)
  await page.getByRole('button', { name: /^save$/i }).click()
  await confirmWrite(page, /sign & save/i)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(`(edited ${RUN})`, { timeout: 120_000 })
  await expect(page.getByTestId('edited-marker').first()).toBeVisible()
  const view = dg('OWNER', 'pr', 'view', SLUG, String(prNumber))
  expect(view['title']).toBe(`${TITLE} (edited ${RUN})`)
})

test('i8. the short URL opens Files changed; axe clean on every tab', async ({ browser }) => {
  test.skip(prNumber === 0, 'needs the PR from i1')
  const page = await signedIn(browser, 'OWNER', `/${ids.owner}/${REPO}/pull/${prNumber}/files`)
  await page.waitForURL(/tab=files/, { timeout: 60_000 })
  await waitForRepoResolved(page)
  await expect(page.getByTestId('pr-tab-files')).toHaveAttribute('aria-selected', 'true', { timeout: 60_000 })
  await expect(page.getByText('src/greet.rs').first()).toBeVisible({ timeout: 120_000 })
  expect(await runAxe(page, 'PR files tab')).toEqual([])
  for (const t of ['commits', 'checks', 'conversation'] as const) {
    await page.getByTestId(`pr-tab-${t}`).click()
    await expect(page.getByTestId(`pr-tab-${t}`)).toHaveAttribute('aria-selected', 'true')
    expect(await runAxe(page, `PR ${t} tab`)).toEqual([])
  }
  await shot(page, 'review-ia-06-conversation')
})
