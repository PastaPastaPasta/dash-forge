import { test, expect, type Page } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { idFile, idOf, shot, signedIn, unlock, waitForRepoResolved } from './helpers'

/**
 * Repository settings, live on a devnet (QA D-503: no product path wrote `config` after a repo
 * was created). Real spend, about 0.02 DASH per run:
 *
 *   E2E_DEVNET=sakura E2E_WRITE=1 E2E_IDENTITY_DIR=<dir with OWNER, COLLAB> \
 *     E2E_BIN_DIR=<dir with dg + git-remote-dash> pnpm exec playwright test repo-settings.spec.ts
 *
 * The identities are the spec's own (`E2E_IDENTITY_DIR`), never the shared fixtures: OWNER owns
 * a new repo per run, COLLAB is its writer. The CLI sets the repo up and does the git pushes the
 * browser cannot; every settings write goes through the web UI's confirm dialog and its cost.
 *
 *   s1. OWNER protects `main` in Settings → Branches (the preview names `main`).
 *   s2. COLLAB's CLI push to `main` is refused: by the helper with E601, and with the pre-check
 *       off, at consensus (the helper routes it to the maintainer-only `protectedRefUpdate`).
 *   s3. COLLAB's PR into `main`: the web offers COLLAB no merge ("protected branch"), and offers
 *       OWNER the merge box (no "Mark as merged": the head is not on `main`, nothing was merged
 *       elsewhere).
 *   s4. OWNER changes the default branch to `trunk`: the repo home opens on `trunk` and the
 *       clone box says a clone checks out `trunk`.
 *   s5. OWNER sets a branch policy (labelled a client rule); the PR shows "0 of 1", the merge is
 *       disabled, and OWNER is offered the explicit "bypass rules" step (QW-001).
 *   s6. OWNER archives: composers are disabled for COLLAB; OWNER unarchives.
 */

test.skip(process.env['E2E_WRITE'] !== '1', 'live devnet writes: set E2E_WRITE=1')
test.skip(!process.env['E2E_IDENTITY_DIR'], "set E2E_IDENTITY_DIR to this spec's own identities (never the shared fixtures)")
test.skip(!process.env['E2E_BIN_DIR'], 'set E2E_BIN_DIR to a directory holding dg and git-remote-dash')
test.skip(!!process.env['E2E_IDENTITY_DIR'] && !existsSync(idFile('COLLAB')), 'OWNER / COLLAB identity files not found')
test.describe.configure({ mode: 'serial', timeout: 300_000 })

const BIN = process.env['E2E_BIN_DIR'] ?? ''
const OWNER = process.env['E2E_IDENTITY_DIR'] ? idOf('OWNER') : ''
const REPO = `settings-${Date.now().toString(36)}`
const SLUG = `${OWNER}/${REPO}`
const REMOTE = `dash://${SLUG}`
const SRC = join(tmpdir(), `dash-forge-${REPO}`)
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

/** `dg --yes --json …` as `who`; the parsed JSON. Throws with the output on failure. */
function dg(who: string, ...args: string[]): Record<string, unknown> {
  const out = execFileSync(join(BIN, 'dg'), ['--yes', '--json', ...args], { env: env(who), cwd: SRC, encoding: 'utf8', timeout: 240_000 })
  return JSON.parse(out) as Record<string, unknown>
}

/** git as `who` in the scratch repo; its exit status and combined output. */
function git(who: string, args: string[], extra: Record<string, string> = {}): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { env: { ...env(who), RUST_LOG: 'warn', ...extra }, cwd: SRC, encoding: 'utf8', timeout: 240_000 })
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` }
}

function repoPath(path: string, extra = ''): string {
  return `/repo/${path}${path ? '/' : ''}?owner=${OWNER}&name=${REPO}${extra}`
}

/** Confirm the open dialog: it must show a cost, then close once Platform shows the write. */
async function confirmWrite(page: Page, label: RegExp): Promise<void> {
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('cost-preview')).toBeVisible()
  await dialog.getByRole('button', { name: label }).click()
  await expect(dialog).toBeHidden({ timeout: 120_000 })
}

test.beforeAll(() => {
  if (!process.env['E2E_IDENTITY_DIR'] || !BIN) return
  rmSync(SRC, { recursive: true, force: true })
  mkdirSync(SRC, { recursive: true })
  const g = (...a: string[]): void => void execFileSync('git', a, { cwd: SRC })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'e2e@dash-forge.test')
  g('config', 'user.name', 'Dash Forge E2E')
  g('config', 'commit.gpgsign', 'false')
  writeFileSync(join(SRC, 'README.md'), `# ${REPO}\n`)
  g('add', '.')
  g('commit', '-q', '-m', 'first')
  g('branch', 'trunk')
  dg('OWNER', 'repo', 'create', REPO, '--storage', 'platform', '--no-protect', '--description', 'Dash Forge e2e: repo settings from the web')
  const push = git('OWNER', ['push', REMOTE, 'main', 'trunk'])
  if (!push.ok) throw new Error(`owner push failed:\n${push.out}`)
  // RC1 consent (R-06): the member accepts before the owner can add them (--wait rides out a
  // node that has not seen the consent yet).
  dg('COLLAB', 'collab', 'accept', SLUG)
  dg('OWNER', 'collab', 'add', SLUG, idOf('COLLAB'), '--role', 'writer', '--wait', '60')
})

test.afterAll(() => rmSync(SRC, { recursive: true, force: true }))

test('s1. the owner protects main from Settings → Branches', async ({ browser }) => {
  const page = await signedIn(browser, 'OWNER', repoPath('settings'))
  await waitForRepoResolved(page)
  const branches = page.getByRole('region', { name: 'Branches' })
  await expect(branches.getByText('Nothing is protected')).toBeVisible({ timeout: 60_000 })
  await branches.getByLabel('Branch or pattern').fill('main')
  await expect(branches.getByTestId('pattern-preview')).toHaveText(/refs\/heads\/main\s+protects main/)
  await expect(branches.getByTestId('cost-preview')).toContainText('DASH')
  await shot(page, 'settings-01-protect-preview')
  await branches.getByRole('button', { name: /^protect$/i }).click()
  await confirmWrite(page, /sign & protect/i)
  await expect(branches.getByTestId('protected-pattern')).toContainText('refs/heads/main', { timeout: 60_000 })
  await expect(branches.getByTestId('protected-pattern')).toContainText('matches main')
  await shot(page, 'settings-02-main-protected')
})

test('s1b. the one-click suggestion completes the default: every tag', async ({ browser }) => {
  const page = await signedIn(browser, 'OWNER', repoPath('settings'))
  await waitForRepoResolved(page)
  const branches = page.getByRole('region', { name: 'Branches' })
  // main is protected (s1), so only tags are missing.
  const suggestion = branches.getByTestId('protection-suggestion')
  await expect(suggestion).toContainText('Any writer can create or move tags', { timeout: 60_000 })
  await suggestion.getByRole('button', { name: /^protect tags$/i }).click()
  await confirmWrite(page, /sign & protect/i)
  await expect(branches.getByTestId('protected-pattern').filter({ hasText: 'refs/tags/**' })).toBeVisible({ timeout: 60_000 })
  await expect(suggestion).toHaveCount(0)
  await shot(page, 'settings-02b-tags-protected')
})

test("s2. the writer's CLI push to main is refused (E601), at consensus too", () => {
  const listed = dg('COLLAB', 'repo', 'protect', 'list', SLUG)
  expect(listed['protectedPatterns']).toEqual(['refs/heads/main', 'refs/tags/**'])
  writeFileSync(join(SRC, 'writer.txt'), 'a writer change\n')
  execFileSync('git', ['add', 'writer.txt'], { cwd: SRC })
  execFileSync('git', ['commit', '-q', '-m', 'writer change'], { cwd: SRC })
  const pre = git('COLLAB', ['push', REMOTE, 'HEAD:refs/heads/main'])
  expect(pre.ok).toBe(false)
  expect(pre.out).toContain('E601')
  expect(pre.out).toContain('protected ref: maintainers only')
  expect(pre.out).toContain('checked before building or paying for anything')
  // The helper's check is advisory; consensus is the gate. A plain refUpdate would be inert,
  // so the helper sends a protectedRefUpdate, which only a maintainer can write.
  const bypass = git('COLLAB', ['push', REMOTE, 'HEAD:refs/heads/main'], { DASH_FORGE_SKIP_WRITE_PRECHECK: '1' })
  expect(bypass.ok).toBe(false)
  expect(bypass.out).toMatch(/40120/)
  expect(bypass.out).toContain('protectedRefUpdate')
})

test("s3. the writer's PR into main: no merge for the writer, a merge for the maintainer", async ({ browser }) => {
  const feature = git('COLLAB', ['push', REMOTE, 'HEAD:refs/heads/feature'])
  expect(feature.ok, feature.out).toBe(true)
  const pr = dg('COLLAB', 'pr', 'create', SLUG, '--base', 'main', '--head', 'feature', '--head-repo', SLUG, '--title', 'A writer PR into protected main')
  prNumber = Number(pr['number'])

  const writer = await signedIn(browser, 'COLLAB', repoPath('pull', `&number=${prNumber}`))
  await waitForRepoResolved(writer)
  await expect(writer.getByTestId('protected-base')).toContainText('main is protected', { timeout: 90_000 })
  await expect(writer.getByText('main is a protected branch: only maintainers can merge into it.')).toBeVisible()
  await expect(writer.getByRole('button', { name: /mark as merged/i })).toHaveCount(0)
  await shot(writer, 'settings-03-writer-merge-blocked')

  const maintainer = await signedIn(browser, 'OWNER', repoPath('pull', `&number=${prNumber}`))
  await waitForRepoResolved(maintainer)
  await expect(maintainer.getByTestId('protected-base')).toBeVisible({ timeout: 90_000 })
  await expect(maintainer.getByTestId('merge-panel')).toBeVisible({ timeout: 90_000 })
  await expect(maintainer.getByRole('button', { name: /mark as merged/i })).toHaveCount(0)
  await shot(maintainer, 'settings-04-maintainer-can-merge')
})

test('s4. changing the default branch updates the repo home and the clone box', async ({ browser }) => {
  const page = await signedIn(browser, 'OWNER', repoPath('settings'))
  await waitForRepoResolved(page)
  const general = page.getByRole('region', { name: 'General' })
  await general.getByLabel('Default branch').selectOption('trunk')
  await expect(general.getByTestId('cost-preview')).toContainText('DASH')
  await general.getByRole('button', { name: /^update$/i }).click()
  await confirmWrite(page, /sign & update/i)
  await expect(general.getByLabel('Default branch')).toHaveValue('trunk', { timeout: 60_000 })

  await page.goto(repoPath(''), { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page)
  await expect(page.getByTestId('clone-default-branch')).toContainText('trunk', { timeout: 60_000 })
  await expect(page.getByRole('region', { name: 'About' }).getByText('trunk')).toBeVisible()
  await shot(page, 'settings-05-home-on-trunk')
  // What a clone checks out: the helper advertises HEAD → trunk.
  const sym = git('OWNER', ['ls-remote', '--symref', REMOTE, 'HEAD'])
  expect(sym.out).toMatch(/ref: refs\/heads\/trunk\s+HEAD/)
})

test('s5. the branch policy is saved and shown on the PR as a client rule', async ({ browser }) => {
  const page = await signedIn(browser, 'OWNER', repoPath('settings'))
  await waitForRepoResolved(page)
  const policy = page.getByTestId('policy-editor')
  await expect(policy).toContainText('A client rule, not consensus', { timeout: 60_000 })
  await policy.getByLabel('Required approvals').fill('1')
  await policy.getByRole('button', { name: /save policy/i }).click()
  await confirmWrite(page, /sign & save/i)
  await expect(policy.getByRole('button', { name: /save policy/i })).toBeDisabled({ timeout: 60_000 })

  // A full navigation keeps the session (or unlocks a restored one with the passphrase).
  await page.goto(repoPath('pull', `&number=${prNumber}`), { waitUntil: 'domcontentloaded' })
  await unlock(page)
  await waitForRepoResolved(page)
  await expect(page.getByTestId('policy-status')).toContainText('0 of 1 required approval', { timeout: 90_000 })
  await expect(page.getByText(/Policy is a client rule; a maintainer can bypass it/)).toBeVisible()
  await expect(page.getByTestId('merge-rules-unmet')).toContainText('required approvals: 0 of 1', { timeout: 240_000 })
  await expect(page.getByTestId('merge-submit')).toBeDisabled()
  await page.getByTestId('merge-bypass').check()
  await expect(page.getByTestId('merge-submit')).toHaveText(/bypass rules and merge/i)
  await expect(page.getByRole('button', { name: /merge anyway/i })).toHaveCount(0)
  await shot(page, 'settings-06-policy-override')
})

test('s6. archiving disables composers; unarchive restores them', async ({ browser }) => {
  const owner = await signedIn(browser, 'OWNER', repoPath('settings'))
  await waitForRepoResolved(owner)
  const danger = owner.getByRole('region', { name: 'Danger zone' })
  await danger.getByRole('button', { name: /^archive$/i }).click()
  await confirmWrite(owner, /sign & archive/i)
  await expect(danger.getByRole('button', { name: /^unarchive$/i })).toBeVisible({ timeout: 60_000 })

  const writer = await signedIn(browser, 'COLLAB', repoPath('issues'))
  await waitForRepoResolved(writer)
  await expect(writer.getByText('A maintainer has marked this repo archived.')).toBeVisible({ timeout: 60_000 })
  await expect(writer.getByRole('button', { name: /new issue/i }).first()).toBeDisabled()
  await shot(writer, 'settings-07-archived-issues')

  await owner.reload()
  await unlock(owner)
  await waitForRepoResolved(owner)
  await owner.getByRole('region', { name: 'Danger zone' }).getByRole('button', { name: /^unarchive$/i }).click()
  await confirmWrite(owner, /sign & unarchive/i)
  await expect(owner.getByRole('region', { name: 'Danger zone' }).getByRole('button', { name: /^archive$/i })).toBeVisible({ timeout: 60_000 })
})

