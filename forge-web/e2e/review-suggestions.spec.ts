import { test, expect, type Page } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { idFile, idOf, shot, signedIn, unlock, waitForRepoResolved } from './helpers'

/**
 * Suggestions and "Update branch" from the browser (review-parity spec §7 PR 5), live on a devnet
 * with the spec's own identities (about 0.01 DASH plus a few KiB of Platform storage):
 *
 *   E2E_DEVNET=moutai E2E_WRITE=1 E2E_IDENTITY_DIR=<dir with OWNER, CONTRIB, COLLAB> \
 *     E2E_BIN_DIR=<dir with dg + git-remote-dash> pnpm exec playwright test review-suggestions.spec.ts
 *
 *   s1. OWNER (maintainer) comments two suggestions on CONTRIB's PR from the web: each renders
 *       as a diff (the lines removed, the suggested ones), with no Apply for OWNER (not a writer of
 *       the fork) and the reason why.
 *   s2. CONTRIB (the author, writer of the fork) batches both → "Apply 2 suggestions in one
 *       commit" → the step list completes → the PR head moves ("pushed 1 commit") → both read
 *       "Applied in <oid>". The fork's branch holds the commit with dg's trailers
 *       (`Forge-Suggestion:` ×2, `Co-authored-by:`), and the file has the suggested text.
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


/** Set the browser's commit identity (Settings), as a merge needs. */
async function commitIdentity(page: Page, name: string, email: string): Promise<void> {
  await page.goto('/settings/', { waitUntil: 'domcontentloaded' })
  await unlock(page)
  await page.getByLabel('Merge commit name').fill(name)
  await page.getByLabel('Merge commit email').fill(email)
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
  dg('OWNER', 'repo', 'create', REPO, '--storage', 'platform')
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
  for (const [line, text] of [
    [2, '    let name = "Dash Forge";'],
    [3, '    let punct = "!";'],
  ] as const) {
    await expect(lineButton(page, line)).toBeVisible({ timeout: 180_000 })
    await lineButton(page, line).click()
    await page.getByRole('textbox', { name: `Your comment on ${FILE} line ${line} (new)` }).fill(`Suggest:\n\n\`\`\`suggestion\n${text}\n\`\`\``)
    await page.getByRole('button', { name: 'Add single comment' }).click()
    await expect(page.getByTestId('suggestion').filter({ hasText: text })).toBeVisible({ timeout: 180_000 })
  }
  const first = page.getByTestId('suggestion').first()
  await expect(first.locator('[data-kind=removed]')).toContainText('let name = "forge";')
  await expect(first.locator('[data-kind=added]')).toContainText('let name = "Dash Forge";')
  await expect(page.getByRole('button', { name: 'Apply suggestion' })).toHaveCount(0)
  await expect(page.getByTestId('suggestion-actions').first()).toContainText('Only the PR author')
  await shot(page, 'review-suggest-01-maintainer-view')
})

test('s2. the author batches both into one commit; the head follows; "Applied in"', async ({ browser }) => {
  const page = await signedIn(browser, 'CONTRIB', '/settings/')
  await commitIdentity(page, 'E2E Contrib', 'contrib@e2e.forge.invalid')
  await page.goto(pr('&tab=files'), { waitUntil: 'domcontentloaded' })
  await unlock(page)
  await waitForRepoResolved(page)
  const actions = page.getByTestId('suggestion-actions')
  await expect(actions).toHaveCount(2, { timeout: 180_000 })
  await actions.nth(0).getByRole('button', { name: 'Add to batch' }).click()
  await actions.nth(1).getByRole('button', { name: 'Add to batch' }).click()
  await expect(page.getByTestId('suggestion-batch')).toContainText('2 suggestions in the batch')
  await shot(page, 'review-suggest-02-batch')
  await page.getByRole('button', { name: 'Apply 2 suggestions in one commit' }).click()
  const ask = page.getByRole('dialog', { name: /Store the merge pack .* on Platform\?/ })
  if (await ask.isVisible({ timeout: 60_000 }).catch(() => false)) await ask.getByRole('button', { name: /sign & store on platform/i }).click()
  const steps = page.getByTestId('branch-commit')
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
  const ask = page.getByRole('dialog', { name: /Store the merge pack .* on Platform\?/ })
  if (await ask.isVisible({ timeout: 60_000 }).catch(() => false)) await ask.getByRole('button', { name: /sign & store on platform/i }).click()
  await expect(page.getByTestId('branch-commit').locator('[data-step="head"]')).toHaveAttribute('data-state', 'done', { timeout: 300_000 })
  const after = String(dg('OWNER', 'pr', 'view', SLUG, String(prNumber))['headOid'])
  expect(after).not.toBe(before)
  const w = join(WORK, 'fork')
  git('CONTRIB', w, ['pull', '-q', '--ff-only', `dash://${FORK_SLUG}`, 'feature/greet'])
  expect(execFileSync('git', ['log', '-1', '--format=%P'], { cwd: w, encoding: 'utf8' }).trim()).toBe(`${before} ${main}`)
  await shot(page, 'review-suggest-04-updated')
})
