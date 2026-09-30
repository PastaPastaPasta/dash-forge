import { test, expect, type Page } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { countDocumentQueries, expectPlatformPreAllowed, idFile, idOrEmpty, shot, signedIn, waitForRepoResolved } from './helpers'

/**
 * G4 — the browse cache after a push or merge it did not see (L-08, L-09, L-16), live on a
 * devnet with two real users and no reload anywhere (a reload would also lock the vault):
 *
 *   E2E_DEVNET=bonsia E2E_WRITE=1 E2E_IDENTITY_DIR=<dir with OWNER, COLLAB> \
 *     E2E_BIN_DIR=<dir with dg + git-remote-dash> pnpm exec playwright test browse-cache-invalidation.spec.ts
 *
 * The identities are the spec's own, never the shared fixtures: OWNER owns a new repo per run,
 * COLLAB is its writer.
 *
 *   g1. OWNER's tab is open on the repo (its browse context resolved, main only). COLLAB pushes
 *       a branch with the CLI. In the SAME tab, OWNER opens New pull request: the diff of the
 *       new branch renders (no "object not in locator") and the title is the branch head's
 *       subject. A second branch pushed meanwhile, picked next, retitles the PR to its own
 *       subject (never the first one's). No request beyond one manifest re-read is spent.
 *   g2. OWNER creates the PR, merges it in the browser (fast-forward), and the Code tab — in
 *       the same tab — shows the new tip and its file, not "That read did not land".
 */

test.skip(process.env['E2E_WRITE'] !== '1', 'live devnet writes: set E2E_WRITE=1')
test.skip(!process.env['E2E_IDENTITY_DIR'], "set E2E_IDENTITY_DIR to this spec's own identities (never the shared fixtures)")
test.skip(!process.env['E2E_BIN_DIR'], 'set E2E_BIN_DIR to a directory holding dg and git-remote-dash')
test.skip(!!process.env['E2E_IDENTITY_DIR'] && (!existsSync(idFile('OWNER')) || !existsSync(idFile('COLLAB'))), 'OWNER / COLLAB identity files not found')
test.describe.configure({ mode: 'serial', timeout: 480_000 })

const BIN = process.env['E2E_BIN_DIR'] ?? ''
const OWNER = idOrEmpty('OWNER')
const REPO = `g4-cache-${Date.now().toString(36)}`
const SLUG = `${OWNER}/${REPO}`
const REMOTE = `dash://${SLUG}`
const SRC = join(tmpdir(), `dash-forge-${REPO}`)
const FIRST = 'Add the greeting module'
const SECOND = 'Document the release checklist'

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
  const out = execFileSync(join(BIN, 'dg'), ['--yes', '--json', ...args], { env: env(who), cwd: SRC, encoding: 'utf8', timeout: 240_000 })
  return JSON.parse(out) as Record<string, unknown>
}

/** `git push` as `who`; throws with the helper's output on failure. */
function push(who: string, refspec: string): void {
  const r = spawnSync('git', ['push', REMOTE, refspec], { env: { ...env(who), RUST_LOG: 'warn' }, cwd: SRC, encoding: 'utf8', timeout: 300_000 })
  if (r.status !== 0) throw new Error(`push ${refspec} as ${who} failed:\n${r.stdout}${r.stderr}`)
}

const g = (...a: string[]): string => execFileSync('git', a, { cwd: SRC, encoding: 'utf8' }).trim()

/** A new branch off main with one commit adding `file`; its head oid. */
function branch(name: string, file: string, content: string, subject: string): string {
  g('checkout', '-q', '-b', name, 'main')
  writeFileSync(join(SRC, file), content)
  g('add', file)
  g('commit', '-q', '-m', subject, '-m', 'Body text that must not reach the title.')
  const oid = g('rev-parse', 'HEAD')
  g('checkout', '-q', 'main')
  return oid
}

function repoPath(path: string, extra = ''): string {
  return `/repo/${path}${path ? '/' : ''}?owner=${OWNER}&name=${REPO}${extra}`
}


/** A tab link inside the repo header: client-side navigation, the browse cache is kept. */
async function tab(page: Page, name: 'Code' | 'Pull requests'): Promise<void> {
  await page.getByRole('navigation', { name: 'Repository' }).getByRole('link', { name: new RegExp(`^${name}`) }).first().click()
}

let page: Page
let firstHead = ''
let secondHead = ''

test.beforeAll(() => {
  if (!process.env['E2E_IDENTITY_DIR'] || !BIN) return
  rmSync(SRC, { recursive: true, force: true })
  mkdirSync(SRC, { recursive: true })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'e2e@dash-forge.test')
  g('config', 'user.name', 'Dash Forge E2E')
  g('config', 'commit.gpgsign', 'false')
  writeFileSync(join(SRC, 'README.md'), `# ${REPO}\n\nThe G4 browse-cache fixture.\n`)
  g('add', 'README.md')
  g('commit', '-q', '-m', 'first')
  dg('OWNER', 'repo', 'create', REPO, '--storage', 'platform', '--description', 'Dash Forge e2e: the browse cache after a push (G4)')
  push('OWNER', 'main')
  // RC1 consent (R-06): the member accepts before the owner can add them (--wait rides out a
  // node that has not seen the consent yet).
  dg('COLLAB', 'collab', 'accept', SLUG)
  dg('OWNER', 'collab', 'add', SLUG, idOrEmpty('COLLAB'), '--role', 'writer', '--wait', '60')
})

test.afterAll(() => rmSync(SRC, { recursive: true, force: true }))

test('g1. a branch pushed by another user while the tab is open: New PR shows its diff and title, no reload (L-08, L-16)', async ({ browser }) => {
  page = await signedIn(browser, 'OWNER', repoPath(''))
  await waitForRepoResolved(page)
  // The tab resolves its browse context now, before the push: only main exists.
  await expect(page.getByRole('region', { name: 'README' })).toContainText('The G4 browse-cache fixture', { timeout: 120_000 })
  await shot(page, 'g4-01-home-before-push')

  // Budget, warm hit: moving between the repo's pages within the revalidation window reads no
  // pack manifests at all — the browse context is served from the session cache.
  const warm = countDocumentQueries(page, 'packManifest')
  await tab(page, 'Pull requests')
  await expect(page.getByRole('link', { name: /new pull request/i })).toBeVisible({ timeout: 60_000 })
  await tab(page, 'Code')
  await expect(page.getByRole('region', { name: 'README' })).toBeVisible({ timeout: 60_000 })
  expect(warm.count(), 'packManifest listings on a warm navigation').toBe(0)

  // The second user pushes a branch from the CLI.
  firstHead = branch('feature/greeting', 'greeting.txt', 'hello from the pushed branch\n', FIRST)
  push('COLLAB', 'feature/greeting')

  // Same tab: Pull requests → New pull request. The repo home revalidates after 30 s; give it
  // that long to see the new ref, the way a person switching tabs would.
  await page.waitForTimeout(31_000)
  const listings = countDocumentQueries(page, 'packManifest')
  await tab(page, 'Pull requests')
  await page.getByRole('link', { name: /new pull request/i }).click()
  await page.waitForURL(/\/repo\/pulls\/new/)
  const head = page.locator('#pr-head')
  await expect(head.locator('option', { hasText: 'feature/greeting' })).toBeAttached({ timeout: 90_000 })
  await head.selectOption({ label: 'feature/greeting' })

  // The diff renders from the new pack: no "Diff unavailable … object not in locator".
  await expect(page.getByText('greeting.txt').first()).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText('hello from the pushed branch').first()).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(/not in locator|Diff unavailable/)).toHaveCount(0)
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(FIRST, { timeout: 60_000 })
  await shot(page, 'g4-02-new-pr-after-push')
  // Budget, after a push: exactly one re-resolve — one pack-manifest listing, shared by the
  // background revalidation and the stale reader's miss — not one per object or per retry.
  expect(listings.count(), 'packManifest listings while opening New PR after a push').toBe(1)

  // A second branch pushed meanwhile: picking it takes ITS subject, never the first's (L-16).
  secondHead = branch('docs/checklist', 'CHECKLIST.md', '- [ ] tag\n- [ ] notes\n', SECOND)
  push('COLLAB', 'docs/checklist')
  await page.waitForTimeout(31_000)
  await tab(page, 'Code')
  await tab(page, 'Pull requests')
  await page.getByRole('link', { name: /new pull request/i }).click()
  await page.waitForURL(/\/repo\/pulls\/new/)
  await expect(head.locator('option', { hasText: 'docs/checklist' })).toBeAttached({ timeout: 90_000 })
  await head.selectOption({ label: 'docs/checklist' })
  await expect(page.getByText('CHECKLIST.md').first()).toBeVisible({ timeout: 120_000 })
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(SECOND, { timeout: 60_000 })
  await head.selectOption({ label: 'feature/greeting' })
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(FIRST, { timeout: 60_000 })
  await shot(page, 'g4-03-title-follows-head')
})

test('g2. a browser merge, then the Code tab shows the new tip without a reload (L-09)', async () => {
  test.skip(firstHead === '', 'needs g1')
  await page.getByLabel('Description', { exact: true }).fill('Opened by the G4 browse-cache spec.')
  await page.getByRole('button', { name: /create pull request/i }).click()
  await page.waitForURL(/\/repo\/pull\/\?.*number=\d+/, { timeout: 180_000 })
  await expect(page.getByRole('heading', { name: new RegExp(FIRST) })).toBeVisible({ timeout: 120_000 })

  // The head descends from main: a fast-forward, nothing to upload.
  await expect(page.getByTestId('merge-button-state')).toHaveAttribute('data-state', 'fast-forward', { timeout: 180_000 })
  await page.getByRole('button', { name: 'Merge (fast-forward)' }).click()
  const steps = page.getByRole('list', { name: 'Merge steps' })
  await expect(steps.locator('[data-step="ref"]')).toHaveAttribute('data-state', 'done', { timeout: 300_000 })
  await page.getByTestId('merge-panel').scrollIntoViewIfNeeded()
  await shot(page, 'g4-04-merged')

  // Same tab, Code tab: the new tip and its file — not "That read did not land", and not the
  // pre-merge tip a node a block behind still serves.
  await tab(page, 'Code')
  await page.waitForURL((u) => u.pathname.replace(/\/$/, '') === '/repo', { timeout: 30_000 })
  const refBar = page.getByTestId('commit-count').locator('..')
  await expect(refBar).toBeVisible({ timeout: 120_000 })
  await expect(refBar.getByRole('button', { name: new RegExp(`^${firstHead.slice(0, 7)}\\b`) })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('link', { name: /greeting\.txt/ }).first()).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('region', { name: 'README' })).toBeVisible()
  await expect(page.getByText(/did not land|not in locator/)).toHaveCount(0)
  await shot(page, 'g4-05-code-tab-after-merge')
})

test('g3. a merge commit built in the browser (a new pack), then the Code tab reads the new commit (L-09)', async () => {
  test.skip(secondHead === '', 'needs g1')
  // main has moved on (g2's fast-forward) since docs/checklist branched: merging it needs a
  // merge commit, whose objects exist only in the pack this merge stores — the object no
  // context resolved before the merge can hold.
  await page.evaluate(() => {
    const key = 'forge.prefs.v1'
    const prefs = JSON.parse(window.localStorage.getItem(key) ?? '{}') as Record<string, unknown>
    window.localStorage.setItem(key, JSON.stringify({ ...prefs, mergeName: 'Forge G4 E2E', mergeEmail: 'g4@e2e.forge.invalid' }))
    window.dispatchEvent(new StorageEvent('storage', { key }))
  })
  await tab(page, 'Pull requests')
  await page.getByRole('link', { name: /new pull request/i }).click()
  await page.waitForURL(/\/repo\/pulls\/new/)
  const head = page.locator('#pr-head')
  await expect(head.locator('option', { hasText: 'docs/checklist' })).toBeAttached({ timeout: 90_000 })
  await head.selectOption({ label: 'docs/checklist' })
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(SECOND, { timeout: 120_000 })
  await page.getByRole('button', { name: /create pull request/i }).click()
  await page.waitForURL(/\/repo\/pull\/\?.*number=\d+/, { timeout: 180_000 })

  await expect(page.getByTestId('merge-button-state')).toHaveAttribute('data-state', 'merge-commit', { timeout: 180_000 })
  await expectPlatformPreAllowed(page.getByTestId('merge-panel'))
  await page.getByRole('button', { name: 'Create merge commit and merge' }).click()
  const steps = page.getByRole('list', { name: 'Merge steps' })
  await expect(steps.locator('[data-step="ref"]')).toHaveAttribute('data-state', 'done', { timeout: 300_000 })
  // Pre-allowed before the merge: the run never stopped to ask.
  await expect(page.getByTestId('storage-question')).toHaveCount(0)
  await page.getByTestId('merge-panel').scrollIntoViewIfNeeded()
  await shot(page, 'g4-06-merge-commit-done')

  // The merge commit's oid, from the panel ("Base branch moved to <oid>").
  const moved = page.getByText(/Base branch moved to/)
  await expect(moved).toBeVisible({ timeout: 120_000 })
  const mergeTip = ((await moved.getByRole('button').first().getAttribute('title')) ?? '').split('\n')[0] ?? ''
  expect(mergeTip).toMatch(/^[0-9a-f]{40}$/)

  await tab(page, 'Code')
  const refBar = page.getByTestId('commit-count').locator('..')
  await expect(refBar.getByRole('button', { name: new RegExp(`^${mergeTip.slice(0, 7)}\\b`) })).toBeVisible({ timeout: 120_000 })
  await expect(page.getByRole('link', { name: /CHECKLIST\.md/ }).first()).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('link', { name: /greeting\.txt/ }).first()).toBeVisible()
  await expect(page.getByText(/did not land|not in locator/)).toHaveCount(0)
  await shot(page, 'g4-07-code-tab-after-merge-commit')
})
