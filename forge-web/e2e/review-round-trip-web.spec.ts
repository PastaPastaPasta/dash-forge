import { test, expect, type Page } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { idFile, idOf, runAxe, shot, signedIn, unlock, waitForRepoResolved } from './helpers'

/**
 * The full GitHub-style review round trip in the browser (review-parity spec §7 PRs 3–6), two
 * users on a devnet with the spec's own identities (≈ 0.03 DASH plus a few KiB of storage):
 *
 *   E2E_DEVNET=moutai E2E_WRITE=1 E2E_IDENTITY_DIR=<dir with OWNER, CONTRIB, COLLAB> \
 *     E2E_BIN_DIR=<dir with dg, git-remote-dash, seed_check_run> \
 *     pnpm exec playwright test review-round-trip-web.spec.ts
 *
 *   r1. OWNER sets a branch policy in Settings: 1 approval from maintainers, required checks,
 *       merge methods squash only.
 *   r2. CONTRIB opens a PR from the fork in the browser.
 *   r3. OWNER reviews on Files changed: a pending 3-line range comment and a pending suggestion,
 *       submitted together as "Request changes" (3 documents).
 *   r4. CONTRIB applies the suggestion from the browser → the PR head follows (the Commits tab
 *       counts 2, "Applied in").
 *   r5. OWNER sees "New commits since your review", replies to and resolves the range thread,
 *       approves; the merge box says required checks are not passing (a writer could not
 *       merge; OWNER is offered the override) — then a relay-style `checkRun` is written for the
 *       head (seed_check_run) and the checks row reads "1 passed".
 *   r6. OWNER squash-merges with an edited message and deletes the branch: the PR reads Merged;
 *       main's new tip is ONE commit on the old main with the edited message and
 *       `Co-authored-by`; the fork's branch is gone.
 *   r7. Cross-check with the CLI: `dg pr view --json` agrees on state, head, reviews, resolved
 *       threads; a `dg pr comment` shows on the web page.
 */

test.skip(process.env['E2E_WRITE'] !== '1', 'live devnet writes: set E2E_WRITE=1')
test.skip(!process.env['E2E_IDENTITY_DIR'], "set E2E_IDENTITY_DIR to this spec's own identities (never the shared fixtures)")
test.skip(!process.env['E2E_BIN_DIR'], 'set E2E_BIN_DIR to a directory holding dg, git-remote-dash and seed_check_run')
test.skip(!!process.env['E2E_IDENTITY_DIR'] && !existsSync(idFile('CONTRIB')), 'OWNER / CONTRIB identity files not found')
test.describe.configure({ mode: 'serial', timeout: 480_000 })

const BIN = process.env['E2E_BIN_DIR'] ?? ''
const ids = process.env['E2E_IDENTITY_DIR'] ? { owner: idOf('OWNER'), contrib: idOf('CONTRIB') } : { owner: '', contrib: '' }
const RUN = process.env['E2E_RUN'] ?? Date.now().toString(36)
const REPO = `review-rt-${RUN}`
const FORK = `review-rt-fork-${RUN}`
const SLUG = `${ids.owner}/${REPO}`
const FORK_SLUG = `${ids.contrib}/${FORK}`
const WORK = join(tmpdir(), `dash-forge-${REPO}`)
const FILE = 'src/greet.rs'
const TITLE = 'Greet the forge'
let prNumber = 0
let repoId = ''

function env(who: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DASH_FORGE_KEY: idFile(who),
    DASH_FORGE_NETWORK: 'devnet',
    DASH_FORGE_DEVNET_NAME: process.env['E2E_DEVNET'] || 'moutai',
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

async function confirmWrite(page: Page, label: RegExp): Promise<void> {
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('cost-preview')).toBeVisible()
  await dialog.getByRole('button', { name: label }).click()
  await expect(dialog).toBeHidden({ timeout: 180_000 })
}

async function commitIdentity(page: Page, name: string, email: string): Promise<void> {
  await page.goto('/settings/', { waitUntil: 'domcontentloaded' })
  await unlock(page)
  await page.getByLabel('Merge commit name').fill(name)
  await page.getByLabel('Merge commit email').fill(email)
}

/** Agree to Platform storage when the upload asks (no bucket configured for the spec's identities). */
async function allowPlatformStorage(page: Page): Promise<void> {
  const ask = page.getByRole('dialog', { name: /Store the merge pack .* on Platform\?/ })
  if (await ask.isVisible({ timeout: 90_000 }).catch(() => false)) await ask.getByRole('button', { name: /sign & store on platform/i }).click()
}

interface View {
  state: string
  headOid: string
  reviews: { id: string; verdict: number }[]
  threads: { id: string; location: string; resolved: boolean }[]
  approvedBy: string[]
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
  writeFileSync(join(src, FILE), 'fn main() {\n    let name = "world";\n    let greeting = "hello";\n    let punct = "!";\n    let sep = ", ";\n    println!("{greeting}{sep}{name}{punct}");\n}\n')
  g('add', '.')
  g('commit', '-q', '-m', 'base: greet')
  repoId = String(dg('OWNER', 'repo', 'create', REPO, '--storage', 'platform')['repoId'])
  git('OWNER', src, ['push', '-q', `dash://${SLUG}`, 'main:refs/heads/main'])
  dg('CONTRIB', 'repo', 'fork', SLUG, '--name', FORK)
  // The contributor lets the maintainer write the fork (as "allow edits by maintainers"): only
  // a writer of the source repo is offered "Delete the branch after merging" (r6).
  dg('CONTRIB', 'collab', 'add', FORK_SLUG, ids.owner, '--role', 'writer')
  const w = join(WORK, 'fork')
  git('CONTRIB', WORK, ['clone', '-q', `dash://${FORK_SLUG}`, w])
  const gw = (...a: string[]): void => void execFileSync('git', a, { cwd: w })
  gw('config', 'user.email', 'contrib@e2e.forge.invalid')
  gw('config', 'user.name', 'E2E Contrib')
  gw('config', 'commit.gpgsign', 'false')
  gw('checkout', '-q', '-b', 'feature/greet', 'origin/main')
  writeFileSync(join(w, FILE), 'fn main() {\n    let name = "forge";\n    let greeting = "hello";\n    let punct = "!";\n    let sep = ", ";\n    println!("{greeting}{sep}{name}{punct}");\n}\nfn helper() {}\n')
  gw('commit', '-qam', TITLE)
  git('CONTRIB', w, ['push', '-q', `dash://${FORK_SLUG}`, 'feature/greet:refs/heads/feature/greet'])
})

test.afterAll(() => rmSync(WORK, { recursive: true, force: true }))

test('r1. the owner sets the branch policy: 1 maintainer approval, checks, squash only', async ({ browser }) => {
  const page = await signedIn(browser, 'OWNER', `/repo/settings/?owner=${ids.owner}&name=${REPO}`)
  await waitForRepoResolved(page)
  const policy = page.getByTestId('policy-editor')
  await expect(policy).toContainText('A client rule', { timeout: 90_000 })
  await policy.getByLabel('Required approvals').fill('1')
  await policy.getByText("Only maintainers' approvals count").click()
  await policy.getByText('Require passing checks').click()
  for (const m of ['Fast-forward', 'Merge commit', 'Rebase']) await policy.getByLabel(m).uncheck()
  await policy.getByRole('button', { name: /save policy/i }).click()
  await confirmWrite(page, /sign & save/i)
  await expect(policy.getByRole('button', { name: /save policy/i })).toBeDisabled({ timeout: 90_000 })
})

test('r2. the contributor opens a PR from the fork', async ({ browser }) => {
  const page = await signedIn(browser, 'CONTRIB', `/repo/pulls/new/?owner=${ids.owner}&name=${REPO}`)
  await waitForRepoResolved(page)
  const head = page.locator('#pr-head optgroup[label="Your forks"] option', { hasText: FORK }).first()
  await expect(head).toBeAttached({ timeout: 120_000 })
  await page.getByLabel('Compare (your branch)').selectOption({ label: `${FORK}: feature/greet` })
  await page.getByLabel('Title', { exact: true }).fill(TITLE)
  await page.getByLabel('Description', { exact: true }).fill('Greets the forge.')
  await page.getByRole('button', { name: 'Create pull request' }).click()
  await page.waitForURL(/\/repo\/pull\/\?.*number=\d+/, { timeout: 180_000 })
  prNumber = Number(new URL(page.url()).searchParams.get('number'))
  expect(prNumber).toBeGreaterThan(0)
})

test('r3. the maintainer submits a pending review: a 3-line range and a suggestion', async ({ browser }) => {
  test.skip(prNumber === 0, 'needs r2')
  const page = await signedIn(browser, 'OWNER', pr('&tab=files'))
  await waitForRepoResolved(page)
  await expect(lineButton(page, 3)).toBeVisible({ timeout: 180_000 })
  await lineButton(page, 3).click()
  await lineButton(page, 5).click({ modifiers: ['Shift'] })
  await page.getByRole('textbox', { name: `Your comment on ${FILE} lines 3–5 (new)` }).fill('These three could be one format string.')
  await page.getByRole('button', { name: 'Start a review' }).click()
  await lineButton(page, 8).click()
  await page.getByRole('textbox', { name: `Your comment on ${FILE} line 8 (new)` }).fill('Return the name?\n\n```suggestion\nfn helper() -> &\'static str { "forge" }\n```')
  await page.getByRole('button', { name: 'Add review comment' }).click()
  await page.getByRole('button', { name: /review changes/i }).click()
  const panel = page.getByRole('region', { name: 'Finish your review' })
  await panel.getByLabel('Review summary').fill('Two things before this lands.')
  await panel.getByLabel(/^Request changes/).check()
  await expect(panel.getByTestId('review-documents')).toContainText('3 documents')
  await panel.getByRole('button', { name: 'Submit review' }).click()
  await expect(page.getByTestId('thread')).toHaveCount(2, { timeout: 240_000 })
  await expect(page.getByTestId('suggestion')).toBeVisible()
  await shot(page, 'review-rt-01-review')
})

test('r4. the contributor applies the suggestion; the head follows', async ({ browser }) => {
  test.skip(prNumber === 0, 'needs r2')
  const page = await signedIn(browser, 'CONTRIB', '/settings/')
  await commitIdentity(page, 'E2E Contrib', 'contrib@e2e.forge.invalid')
  await page.goto(pr('&tab=files'), { waitUntil: 'domcontentloaded' })
  await unlock(page)
  await waitForRepoResolved(page)
  await page.getByRole('button', { name: 'Apply suggestion' }).click({ timeout: 180_000 })
  await allowPlatformStorage(page)
  await expect(page.getByTestId('branch-commit').locator('[data-step="head"]')).toHaveAttribute('data-state', 'done', { timeout: 300_000 })
  // The thread was made on the previous head, so it now sits under "comments on an older version"
  // (collapsed, as on GitHub): open it to see the suggestion marked applied.
  const applied = page.getByTestId('suggestion-applied')
  await expect(applied).toBeAttached({ timeout: 240_000 })
  await page.getByTestId('outdated-comments').locator('summary').click()
  await expect(applied).toBeVisible()
  await expect(page.getByTestId('pr-tab-commits-count')).toHaveText('2', { timeout: 120_000 })
  await shot(page, 'review-rt-02-applied')
})

test('r5. the maintainer re-reviews: resolves, approves; checks gate the merge until a run passes', async ({ browser }) => {
  test.skip(prNumber === 0, 'needs r2')
  const page = await signedIn(browser, 'OWNER', pr())
  await waitForRepoResolved(page)
  await expect(page.getByTestId('since-your-review')).toBeVisible({ timeout: 180_000 })
  await page.getByTestId('pr-tab-files').click()
  const view = dg('OWNER', 'pr', 'view', SLUG, String(prNumber), '--comments') as unknown as View
  const range = view.threads.find((t) => t.location.startsWith(`${FILE}:3-5`))!
  // The range thread is outdated now (the suggestion commit moved the head): it lists on top.
  await page.getByTestId('outdated-comments').locator('summary').click({ timeout: 180_000 })
  const thread = page.locator(`[data-testid=thread][data-root="${range.id}"]`)
  await thread.getByRole('button', { name: 'Reply' }).click()
  await thread.getByRole('textbox', { name: 'Reply' }).fill('Fine as it is.')
  await thread.getByRole('button', { name: 'Reply' }).last().click()
  await expect(thread.getByTestId('thread-comment')).toHaveCount(2, { timeout: 120_000 })
  await thread.getByRole('button', { name: 'Resolve conversation' }).click()
  await confirmWrite(page, /sign & resolve/i)
  await page.getByTestId('pr-tab-conversation').click()
  await page.getByRole('button', { name: /^approve$/i }).click()
  await confirmWrite(page, /submit review/i)
  await expect(page.getByTestId('policy-checks')).toContainText('not all passing', { timeout: 180_000 })
  await expect(page.getByTestId('checks-row')).toContainText('No checks reported')
  await shot(page, 'review-rt-03-checks-required')
  // A relay-style check run for the head, by the maintainer.
  const head = String(dg('OWNER', 'pr', 'view', SLUG, String(prNumber))['headOid'])
  execFileSync(join(BIN, 'seed_check_run'), [idFile('OWNER'), repoId, head, 'build', 'completed', 'success', `https://ci.example.invalid/${RUN}`], { env: env('OWNER'), timeout: 240_000 })
  for (let i = 0; i < 6; i++) {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await unlock(page)
    await waitForRepoResolved(page)
    if (await page.getByTestId('checks-row').filter({ hasText: '1 passed' }).isVisible({ timeout: 60_000 }).catch(() => false)) break
  }
  await expect(page.getByTestId('checks-row')).toContainText('1 passed')
  await expect(page.getByTestId('policy-checks')).toContainText('Required checks pass')
  await page.getByTestId('pr-tab-checks').click()
  await expect(page.getByTestId('check-run')).toHaveAttribute('data-outcome', 'passed')
  await shot(page, 'review-rt-04-checks-pass')
})

test('r6. squash and merge with an edited message; the branch is deleted', async ({ browser }) => {
  test.skip(prNumber === 0, 'needs r2')
  const mainBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(WORK, 'src'), encoding: 'utf8' }).trim()
  const page = await signedIn(browser, 'OWNER', '/settings/')
  await commitIdentity(page, 'E2E Owner', 'owner@e2e.forge.invalid')
  await page.goto(pr(), { waitUntil: 'domcontentloaded' })
  await unlock(page)
  await waitForRepoResolved(page)
  const panel = page.getByTestId('merge-panel')
  await expect(page.getByTestId('merge-button-state')).toHaveAttribute('data-state', /fast-forward|merge-commit/, { timeout: 240_000 })
  // The policy allows squash only: the menu starts on it.
  await expect(panel.getByLabel('Merge method')).toHaveValue('squash')
  const msg = panel.getByLabel('Commit message')
  await expect(msg).toHaveValue(new RegExp(`^${TITLE} \\(#${prNumber}\\)`))
  await expect(msg).toHaveValue(/Co-authored-by: E2E Contrib <contrib@e2e\.forge\.invalid>/)
  await msg.fill(`${TITLE} (#${prNumber})\n\nSquashed in the browser (${RUN}).\n\nCo-authored-by: E2E Contrib <contrib@e2e.forge.invalid>`)
  await expect(panel.getByLabel(/Delete .*feature\/greet after merging/)).toBeChecked()
  await shot(page, 'review-rt-05-squash-box')
  await panel.getByRole('button', { name: 'Squash and merge' }).click()
  await allowPlatformStorage(page)
  await expect(panel.locator('[data-step="event"]')).toHaveAttribute('data-state', 'done', { timeout: 300_000 })
  await expect(page.getByTestId('branch-deleted')).toBeVisible({ timeout: 180_000 })
  await expect(page.getByTestId('pr-state')).toHaveText('Merged', { timeout: 180_000 })
  await shot(page, 'review-rt-06-merged')
  // main: one new commit on the old main, the edited message.
  const src = join(WORK, 'src')
  git('OWNER', src, ['pull', '-q', '--ff-only', `dash://${SLUG}`, 'main'])
  expect(execFileSync('git', ['log', '-1', '--format=%P'], { cwd: src, encoding: 'utf8' }).trim()).toBe(mainBefore)
  const body = execFileSync('git', ['log', '-1', '--format=%B'], { cwd: src, encoding: 'utf8' })
  expect(body).toContain(`Squashed in the browser (${RUN}).`)
  expect(body).toContain('Co-authored-by: E2E Contrib <contrib@e2e.forge.invalid>')
  expect(readFileSync(join(src, FILE), 'utf8')).toContain('fn helper() -> &\'static str { "forge" }')
  // The fork's branch is gone.
  expect(git('CONTRIB', WORK, ['ls-remote', `dash://${FORK_SLUG}`, 'refs/heads/feature/greet'])).toBe('')
})

test('r7. the CLI agrees, and a dg comment shows on the web', async ({ browser }) => {
  test.skip(prNumber === 0, 'needs r2')
  const view = dg('OWNER', 'pr', 'view', SLUG, String(prNumber), '--comments') as unknown as View
  expect(view.state).toBe('merged')
  expect(view.reviews.map((r) => r.verdict)).toEqual([2, 1])
  expect(view.threads.filter((t) => t.resolved)).toHaveLength(1)
  dg('OWNER', 'pr', 'comment', SLUG, String(prNumber), '--body', `Thanks! (${RUN}, from dg)`)
  const page = await signedIn(browser, 'CONTRIB', pr())
  await waitForRepoResolved(page)
  await expect(page.getByText(`Thanks! (${RUN}, from dg)`)).toBeVisible({ timeout: 180_000 })
  await expect(page.getByTestId('pr-head')).toContainText(view.headOid.slice(0, 9))
  expect(await runAxe(page, 'merged PR')).toEqual([])
})
