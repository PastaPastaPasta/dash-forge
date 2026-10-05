import { test, expect, type Page } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { answerStorageQuestion, idFile, idOf, shot, signedIn, unlock, waitForRepoResolved } from './helpers'

/**
 * Suggestions and "Update branch" from the browser (review-parity spec §7 PR 5), live on a devnet
 * with the spec's own identities (about 0.01 DASH plus a few KiB of Platform storage):
 *
 *   E2E_DEVNET=sakura E2E_WRITE=1 E2E_IDENTITY_DIR=<dir with OWNER, CONTRIB, COLLAB> \
 *     E2E_BIN_DIR=<dir with dg + git-remote-dash> pnpm exec playwright test review-suggestions.spec.ts
 *
 *   s1. OWNER (maintainer) comments two suggestions on CONTRIB's PR from the web, the first with
 *       "Insert a suggestion" (pre-filled with the line) and checked in Preview (QW-067): each
 *       renders as a diff (the lines removed, the suggested ones), with no Apply for OWNER (not a
 *       writer of the fork) and the reason why. A pending review comment's suggestion shows the
 *       line it replaces too.
 *   s2. CONTRIB (the author, writer of the fork), in a tab resumed after a reload (the signing
 *       key only; QW-007) and with no commit name and email yet (QW-065: set beside Apply),
 *       batches both → "Apply 2 suggestions in one commit" → the step list completes in the
 *       batch bar → the PR head moves ("pushed 1 commit") → both read "Applied in <oid>". The
 *       fork's branch holds the commit with dg's trailers (`Forge-Suggestion:` ×2,
 *       `Co-authored-by:`), and the file has the suggested text.
 *   s3. OWNER pushes to main; CONTRIB's "Update branch" merges it into the PR branch (parents:
 *       the old head and main), and the PR follows.
 */

test.skip(process.env['E2E_WRITE'] !== '1', 'live devnet writes: set E2E_WRITE=1')
test.skip(!process.env['E2E_IDENTITY_DIR'], "set E2E_IDENTITY_DIR to this spec's own identities (never the shared fixtures)")
test.skip(!process.env['E2E_BIN_DIR'], 'set E2E_BIN_DIR to a directory holding dg and git-remote-dash')
test.skip(!!process.env['E2E_IDENTITY_DIR'] && !existsSync(idFile('CONTRIB')), 'OWNER / CONTRIB identity files not found')
test.describe.configure({ mode: 'serial', timeout: 420_000 })

const BIN = process.env['E2E_BIN_DIR'] ?? ''
const ids = process.env['E2E_IDENTITY_DIR'] ? { owner: idOf('OWNER'), contrib: idOf('CONTRIB') } : { owner: '', contrib: '' }
const RUN = process.env['E2E_RUN'] ?? Date.now().toString(36)
const REPO = `review-suggest-${RUN}`
const FORK = `review-suggest-fork-${RUN}`
const SLUG = `${ids.owner}/${REPO}`
const FORK_SLUG = `${ids.contrib}/${FORK}`
const WORK = join(tmpdir(), `dash-forge-${REPO}`)
const FILE = 'src/greet.rs'
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

function dg(who: string, ...args: string[]): Record<string, unknown> {
  const out = execFileSync(join(BIN, 'dg'), ['--yes', '--json', ...args], { env: env(who), cwd: WORK, encoding: 'utf8', timeout: 240_000 })
  return JSON.parse(out) as Record<string, unknown>
}

function git(who: string, dir: string, args: string[]): string {
  const r = spawnSync('git', ['-c', 'dash.confirm=never', '-c', 'dash.prAutoSync=false', ...args], { env: env(who), cwd: dir, encoding: 'utf8', timeout: 240_000 })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.stdout}${r.stderr}`)
  return r.stdout.trim()
}

const pr = (extra = ''): string => `/repo/pull/?owner=${ids.owner}&name=${REPO}&number=${prNumber}${extra}`
const lineButton = (page: Page, line: number) => page.getByRole('button', { name: `Comment on new line ${line} of ${FILE}` }).first()


/** Set the browser's commit identity (Settings), as a merge needs. */
async function commitIdentity(page: Page, name: string, email: string): Promise<void> {
  await page.goto('/settings/', { waitUntil: 'domcontentloaded' })
  await unlock(page)
  await page.getByLabel('Commit author name').fill(name)
  await page.getByLabel('Commit author email').fill(email)
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
  writeFileSync(join(src, FILE), 'fn main() {\n    let name = "world";\n    let punct = "!";\n    println!("hello, {name}{punct}");\n}\n')
  writeFileSync(join(src, 'README.md'), `# ${REPO}\n`)
  g('add', '.')
  g('commit', '-q', '-m', 'base')
  dg('OWNER', 'repo', 'create', REPO, '--storage', 'platform', '--no-protect')
  git('OWNER', src, ['push', '-q', `dash://${SLUG}`, 'main:refs/heads/main'])
  dg('CONTRIB', 'repo', 'fork', SLUG, '--name', FORK)
  const w = join(WORK, 'fork')
  git('CONTRIB', WORK, ['clone', '-q', `dash://${FORK_SLUG}`, w])
  const gw = (...a: string[]): void => void execFileSync('git', a, { cwd: w })
  gw('config', 'user.email', 'contrib@e2e.forge.invalid')
  gw('config', 'user.name', 'E2E Contrib')
  gw('config', 'commit.gpgsign', 'false')
  gw('checkout', '-q', '-b', 'feature/greet', 'origin/main')
  writeFileSync(join(w, FILE), 'fn main() {\n    let name = "forge";\n    let punct = "?";\n    println!("hello, {name}{punct}");\n}\n')
  gw('commit', '-qam', 'Greet the forge')
  git('CONTRIB', w, ['push', '-q', `dash://${FORK_SLUG}`, 'feature/greet:refs/heads/feature/greet'])
  prNumber = Number(dg('CONTRIB', 'pr', 'create', SLUG, '--base', 'main', '--head', 'feature/greet', '--head-repo', FORK_SLUG, '--title', 'Greet the forge')['number'])
})

test.afterAll(() => rmSync(WORK, { recursive: true, force: true }))

test('s1. the maintainer suggests two changes; they render as diffs, with no Apply for the maintainer', async ({ browser }) => {
  const page = await signedIn(browser, 'OWNER', pr('&tab=files'))
  await waitForRepoResolved(page)
  // Line 2 with "Insert a suggestion": the block comes pre-filled with the line, edited in place.
  await expect(lineButton(page, 2)).toBeVisible({ timeout: 180_000 })
  await lineButton(page, 2).click()
  const box2 = page.getByRole('textbox', { name: `Your comment on ${FILE} line 2 (new)` })
  await page.getByRole('button', { name: 'Insert a suggestion' }).click()
  await expect(box2).toHaveValue('```suggestion\n    let name = "forge";\n```\n')
  await box2.fill(`Suggest:\n\n${(await box2.inputValue()).replace('"forge"', '"Dash Forge"')}`)
  await page.getByRole('tab', { name: 'Preview' }).click()
  const preview = page.getByTestId('markdown-preview')
  await expect(preview.locator('[data-kind=removed]')).toContainText('let name = "forge";')
  await expect(preview.locator('[data-kind=added]')).toContainText('let name = "Dash Forge";')
  await shot(page, 'review-suggest-00-insert-preview')
  await page.getByRole('button', { name: 'Add single comment' }).click()
  await expect(page.getByTestId('suggestion').filter({ hasText: 'let name = "Dash Forge";' })).toBeVisible({ timeout: 180_000 })
  // Line 3 typed by hand.
  await lineButton(page, 3).click()
  await page.getByRole('textbox', { name: `Your comment on ${FILE} line 3 (new)` }).fill('Suggest:\n\n```suggestion\n    let punct = "!";\n```')
  await page.getByRole('button', { name: 'Add single comment' }).click()
  await expect(page.getByTestId('suggestion').filter({ hasText: 'let punct = "!";' })).toBeVisible({ timeout: 180_000 })
  // A pending review comment's suggestion shows the line it replaces (kept in this browser, free).
  await lineButton(page, 4).click()
  await page.getByRole('button', { name: 'Insert a suggestion' }).click()
  await page.getByRole('button', { name: 'Start a review' }).click()
  const pendingOne = page.getByTestId('pending-comment')
  await expect(pendingOne.locator('[data-kind=removed]')).toContainText('println!("hello, {name}{punct}");')
  await expect(pendingOne.locator('[data-kind=added]')).toContainText('println!("hello, {name}{punct}");')
  await shot(page, 'review-suggest-00-pending-suggestion')
  await pendingOne.getByRole('button', { name: 'Delete pending comment' }).click()
  await expect(page.getByTestId('pending-comment')).toHaveCount(0)
  const first = page.getByTestId('suggestion').first()
  await expect(first.locator('[data-kind=removed]')).toContainText('let name = "forge";')
  await expect(first.locator('[data-kind=added]')).toContainText('let name = "Dash Forge";')
  await expect(page.getByRole('button', { name: 'Apply suggestion' })).toHaveCount(0)
  await expect(page.getByTestId('suggestion-actions').first()).toContainText('Only the PR author')
  await shot(page, 'review-suggest-01-maintainer-view')
})

test('s2. after a reload, the author sets a commit identity in place and batches both into one commit; the head follows; "Applied in"', async ({ browser }) => {
  const page = await signedIn(browser, 'CONTRIB', '/settings/')
  // No commit identity yet: it is asked for beside Apply (QW-065).
  await page.evaluate(() => {
    const raw = window.localStorage.getItem('forge.prefs.v1')
    const prefs = raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>)
    window.localStorage.setItem('forge.prefs.v1', JSON.stringify({ ...prefs, mergeName: '', mergeEmail: '' }))
  })
  await page.goto(pr('&tab=files'), { waitUntil: 'domcontentloaded' })
  await unlock(page)
  // A tab resumed after a reload holds the signing key only (QW-007): the batch must still apply.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('funds-pill')).toBeVisible({ timeout: 60_000 })
  await waitForRepoResolved(page)
  const actions = page.getByTestId('suggestion-actions')
  await expect(actions).toHaveCount(2, { timeout: 180_000 })
  await expect(actions.nth(0).getByRole('button', { name: 'Apply suggestion' })).toBeDisabled()
  await actions.nth(0).getByRole('button', { name: 'Add to batch' }).click()
  await actions.nth(1).getByRole('button', { name: 'Add to batch' }).click()
  const bar = page.getByTestId('suggestion-batch')
  await expect(bar).toContainText('2 suggestions in the batch')
  await expect(bar.getByRole('button', { name: 'Apply 2 suggestions in one commit' })).toBeDisabled()
  await shot(page, 'review-suggest-02a-identity-prompt')
  await bar.getByRole('button', { name: 'Set name and email' }).click()
  await bar.getByLabel('Commit name').fill('E2E Contrib')
  await bar.getByLabel('Commit email').fill('contrib@e2e.forge.invalid')
  await bar.getByRole('button', { name: 'Save' }).click()
  await expect(bar.getByRole('button', { name: 'Apply 2 suggestions in one commit' })).toBeEnabled()
  await shot(page, 'review-suggest-02-batch')
  await bar.getByRole('button', { name: 'Apply 2 suggestions in one commit' }).click()
  // The run shows in the batch bar, where it was started, with no unlock needed (none stored).
  const steps = bar.getByTestId('branch-commit')
  await answerStorageQuestion(page, steps.locator('[data-step="upload"]:is([data-state="done"],[data-state="skipped"])'))
  await expect(steps.locator('[data-step="head"]')).toHaveAttribute('data-state', 'done', { timeout: 300_000 })
  await shot(page, 'review-suggest-03-steps')
  await expect(page.getByTestId('suggestion-applied')).toHaveCount(2, { timeout: 240_000 })
  // The CLI reads the same: the head is the new commit; the fork holds dg's trailers and the text.
  const view = dg('OWNER', 'pr', 'view', SLUG, String(prNumber))
  const head = String(view['headOid'])
  const w = join(WORK, 'fork')
  git('CONTRIB', w, ['pull', '-q', '--ff-only', `dash://${FORK_SLUG}`, 'feature/greet'])
  expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: w, encoding: 'utf8' }).trim()).toBe(head)
  const msg = execFileSync('git', ['log', '-1', '--format=%B'], { cwd: w, encoding: 'utf8' })
  expect(msg.match(/^Forge-Suggestion: /gm)).toHaveLength(2)
  expect(msg).toContain(`Co-authored-by: `)
  expect(msg).toContain(`<${ids.owner}@users.forge.invalid>`)
  expect(readFileSync(join(w, FILE), 'utf8')).toContain('let name = "Dash Forge";')
  await page.getByTestId('pr-tab-conversation').click()
  await expect(page.getByTestId('timeline-event').filter({ hasText: /pushed 1 commit/ })).toBeVisible({ timeout: 120_000 })
})

test('s3. the base moves; "Update branch" merges it into the PR branch', async ({ browser }) => {
  const src = join(WORK, 'src')
  writeFileSync(join(src, 'README.md'), `# ${REPO}\n\nMore docs.\n`)
  execFileSync('git', ['commit', '-qam', 'docs'], { cwd: src })
  git('OWNER', src, ['push', '-q', `dash://${SLUG}`, 'main:refs/heads/main'])
  const main = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: src, encoding: 'utf8' }).trim()
  const before = String(dg('OWNER', 'pr', 'view', SLUG, String(prNumber))['headOid'])

  const page = await signedIn(browser, 'CONTRIB', '/settings/')
  await commitIdentity(page, 'E2E Contrib', 'contrib@e2e.forge.invalid')
  await page.goto(pr(), { waitUntil: 'domcontentloaded' })
  await unlock(page)
  await waitForRepoResolved(page)
  const row = page.getByTestId('update-branch')
  await expect(row).toBeVisible({ timeout: 240_000 })
  await row.getByRole('button', { name: 'Update branch' }).click()
  await answerStorageQuestion(page, page.getByTestId('branch-commit').locator('[data-step="upload"]:is([data-state="done"],[data-state="skipped"])'))
  await expect(page.getByTestId('branch-commit').locator('[data-step="head"]')).toHaveAttribute('data-state', 'done', { timeout: 300_000 })
  const after = String(dg('OWNER', 'pr', 'view', SLUG, String(prNumber))['headOid'])
  expect(after).not.toBe(before)
  const w = join(WORK, 'fork')
  git('CONTRIB', w, ['pull', '-q', '--ff-only', `dash://${FORK_SLUG}`, 'feature/greet'])
  expect(execFileSync('git', ['log', '-1', '--format=%P'], { cwd: w, encoding: 'utf8' }).trim()).toBe(`${before} ${main}`)
  await shot(page, 'review-suggest-04-updated')
})
