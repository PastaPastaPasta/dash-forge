import { test, expect, type Page } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PASSPHRASE, countDocumentQueries, idFile, idOf, shot, signedIn, unlock, waitForRepoResolved } from './helpers'

/**
 * G5 + G18 of the live fix list, on a devnet with the spec's OWN identities (never the shared
 * fixtures) and the local S3 store (RustFS, `forge-byo`) reachable at a public https address:
 *
 *   docker compose -f infra/docker-compose.yml up -d rustfs s3-init
 *   cloudflared tunnel --url http://127.0.0.1:9000          # prints https://<name>.trycloudflare.com
 *   E2E_DEVNET=moutai E2E_WRITE=1 E2E_IDENTITY_DIR=<dir with OWNER, CONTRIB> \
 *     E2E_BIN_DIR=<dir with dg + git-remote-dash> \
 *     E2E_PUBLIC_MINIO=https://<name>.trycloudflare.com/forge-byo \
 *     pnpm exec playwright test storage-trust-inbox.spec.ts
 *
 * Real spend: about 0.02 DASH (one repo, two pushes, a PR, a merge event, a release).
 *
 *   g1. L-10: OWNER adds an S3 profile. It is the default at once (ticked); "Save default" is
 *       disabled with nothing ticked, says why, and never says "Saved." for that.
 *   g2. L-10: a release with an asset publishes on that default. With the default unticked, the
 *       dialog names the missing step and links to it.
 *   g3. L-18: the repo's README is on Platform, a second file on S3 (pushed with the CLI). On
 *       that file's page the Verification summary says "from <S3 host>", not "from Platform".
 *   g4. L-17: CONTRIB's PR is merged, THEN CONTRIB watches it (comments on it: a thread the inbox
 *       subscribes to). CONTRIB's inbox, whose state feed already read past the merge, shows
 *       "marked merged", for one backfill query.
 */

const PUBLIC = (process.env['E2E_PUBLIC_MINIO'] ?? '').replace(/\/+$/, '')
const BIN = process.env['E2E_BIN_DIR'] ?? ''
test.skip(process.env['E2E_WRITE'] !== '1', 'live devnet writes: set E2E_WRITE=1')
test.skip(!process.env['E2E_IDENTITY_DIR'], "set E2E_IDENTITY_DIR to this spec's own identities (never the shared fixtures)")
test.skip(!!process.env['E2E_IDENTITY_DIR'] && !existsSync(idFile('CONTRIB')), 'OWNER / CONTRIB identity files not found')
test.skip(!BIN || !existsSync(join(BIN, 'dg')), 'set E2E_BIN_DIR to a directory holding dg and git-remote-dash')
test.skip(!PUBLIC.startsWith('https://'), 'set E2E_PUBLIC_MINIO to a public https URL for the forge-byo bucket')
test.describe.configure({ mode: 'serial', timeout: 420_000 })

const RUN = Date.now().toString(36)
const OWNER = process.env['E2E_IDENTITY_DIR'] ? idOf('OWNER') : ''
const REPO = `g5g18-${RUN}`
const SLUG = `${OWNER}/${REPO}`
const REMOTE = `dash://${SLUG}`
const SRC = join(tmpdir(), `dash-forge-${REPO}`)
const HOME = join(tmpdir(), `dash-forge-${REPO}-home`)
const S3_HOST = new URL(PUBLIC || 'https://invalid.example').host
const PROFILE = 'rustfs-e2e'
const TAG = `v0.${RUN}`
let prNumber = 0

function env(who: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME,
    XDG_CONFIG_HOME: join(HOME, '.config'),
    XDG_STATE_HOME: join(HOME, '.state'),
    DASH_FORGE_NO_KEYCHAIN: '1',
    DASH_FORGE_STORAGE_CONFIG: join(HOME, 'storage.toml'),
    DASH_FORGE_KEY: idFile(who),
    DASH_FORGE_NETWORK: 'devnet',
    DASH_FORGE_DEVNET_NAME: process.env['E2E_DEVNET'] || 'moutai',
    E2E_S3_SECRET: 'minioadmin',
    GIT_AUTHOR_NAME: `G5G18 ${who}`,
    GIT_AUTHOR_EMAIL: `${who.toLowerCase()}@g5g18.invalid`,
    GIT_COMMITTER_NAME: `G5G18 ${who}`,
    GIT_COMMITTER_EMAIL: `${who.toLowerCase()}@g5g18.invalid`,
    RUST_LOG: 'error',
    NO_COLOR: '1',
    PATH: `${BIN}:${process.env['PATH'] ?? ''}`,
  }
}

/** `dg --yes --json …` as `who`; the parsed JSON. */
function dg(who: string, ...args: string[]): Record<string, unknown> {
  const out = execFileSync(join(BIN, 'dg'), ['--yes', '--json', ...args], { env: env(who), cwd: SRC, encoding: 'utf8', timeout: 300_000 })
  return JSON.parse(out) as Record<string, unknown>
}

function git(who: string, ...args: string[]): string {
  const r = spawnSync('git', args, { env: env(who), cwd: SRC, encoding: 'utf8', timeout: 300_000 })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.stdout}${r.stderr}`)
  return `${r.stdout}${r.stderr}`
}

function repoPath(path: string, extra = ''): string {
  return `/repo/${path}${path ? '/' : ''}?owner=${OWNER}&name=${REPO}${extra}`
}

/** Remove every saved storage profile, waiting for each removal to show. */
async function removeAllProfiles(page: Page): Promise<void> {
  const remove = page.getByRole('button', { name: /^remove /i })
  for (let n = await remove.count(); n > 0; n = await remove.count()) {
    await remove.first().click()
    await expect(remove).toHaveCount(n - 1, { timeout: 30_000 })
  }
}

/**
 * After a navigation: unlock the vault, and the storage settings a resumed signing-only session
 * keeps sealed (#108) when the page asks for them.
 */
async function unlockAll(page: Page): Promise<void> {
  await unlock(page)
  const more = page.locator('[data-testid="storage-unlock"], [data-testid="release-storage-unlock"]').first()
  if (await more.isVisible().catch(() => false)) {
    await more.getByPlaceholder('Passphrase').fill(PASSPHRASE)
    await more.getByRole('button', { name: /unlock/i }).last().click()
    await expect(more).toBeHidden({ timeout: 60_000 })
  }
}

/** Reload until `check` holds (a node a block behind may not have the new documents yet). */
async function eventually(page: Page, check: () => Promise<void>, tries = 5): Promise<void> {
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
  if (!OWNER || !BIN || !PUBLIC) return
  for (const d of [SRC, HOME]) rmSync(d, { recursive: true, force: true })
  mkdirSync(SRC, { recursive: true })
  mkdirSync(join(HOME, '.config'), { recursive: true })
  const g = (...a: string[]): void => void execFileSync('git', a, { cwd: SRC })
  g('init', '-q', '-b', 'main')
  g('config', 'commit.gpgsign', 'false')
  writeFileSync(join(SRC, 'README.md'), `# ${REPO}\n\nPushed to Platform.\n`)
  g('add', '.')
  g('-c', 'user.name=G5G18', '-c', 'user.email=g5g18@invalid', 'commit', '-q', '-m', 'README on Platform')
  // The README's pack on Platform, then a second file's pack on S3 (the same repo, two places).
  dg('OWNER', 'repo', 'create', REPO, '--storage', 'platform', '--description', 'G5/G18 e2e: storage default, trust summary, inbox backfill')
  git('OWNER', 'push', REMOTE, 'main')
  dg('OWNER', 'storage', 'add', PROFILE, '--kind', 's3', '--endpoint', 'http://127.0.0.1:9000', '--region', 'us-east-1', '--bucket', 'forge-byo', '--public-url', PUBLIC, '--prefix', `g5g18-${RUN}`, '--access-key-id', 'minioadmin', '--secret-access-key', 'env:E2E_S3_SECRET')
  execFileSync('git', ['config', 'dash.storage', PROFILE], { cwd: SRC })
  writeFileSync(join(SRC, 's3file.txt'), `served from S3 (${RUN})\n`)
  g('add', 's3file.txt')
  g('-c', 'user.name=G5G18', '-c', 'user.email=g5g18@invalid', 'commit', '-q', '-m', 'a file on S3')
  git('OWNER', 'push', REMOTE, 'main')
  // CONTRIB's PR, from a branch of this repo (CONTRIB is made a writer), merged by OWNER below.
  dg('OWNER', 'collab', 'add', SLUG, idOf('CONTRIB'), '--role', 'writer')
  g('checkout', '-q', '-b', 'feature/greet')
  writeFileSync(join(SRC, 'greet.txt'), 'hello\n')
  g('add', 'greet.txt')
  g('-c', 'user.name=G5G18', '-c', 'user.email=g5g18@invalid', 'commit', '-q', '-m', 'Greet')
  execFileSync('git', ['config', 'dash.storage', 'platform'], { cwd: SRC })
  git('CONTRIB', 'push', REMOTE, 'feature/greet')
})

test.afterAll(() => {
  for (const d of [SRC, HOME]) rmSync(d, { recursive: true, force: true })
})

test('g1. a new S3 profile is the default at once; Save is disabled with nothing ticked (L-10)', async ({ browser }) => {
  const page = await signedIn(browser, 'OWNER', '/settings/storage/')
  await expect(page.getByRole('heading', { name: 'Your storage' })).toBeVisible({ timeout: 60_000 })
  page.on('dialog', (d) => void d.accept())
  await removeAllProfiles(page)
  await page.getByTestId('tile-minio').click()
  await page.getByLabel('Profile name', { exact: true }).fill(PROFILE)
  await page.getByLabel('S3 endpoint', { exact: true }).fill('http://127.0.0.1:9000')
  await page.getByLabel('Region', { exact: true }).fill('us-east-1')
  await page.getByLabel('Bucket', { exact: true }).fill('forge-byo')
  await page.getByLabel('Public URL', { exact: true }).fill(PUBLIC)
  await page.getByLabel(/^Key prefix/).fill(`g5g18-web-${RUN}`)
  await page.getByLabel('Access key id', { exact: true }).fill('minioadmin')
  await page.getByLabel('Secret access key', { exact: true }).fill('minioadmin')
  await page.getByRole('button', { name: /^test$/i }).click()
  for (const row of ['put', 'get', 'public', 'range', 'cors-put', 'delete']) {
    await expect(page.getByTestId(`probe-${row}`)).toHaveAttribute('data-state', 'ok', { timeout: 90_000 })
  }
  await page.getByRole('button', { name: /save profile/i }).click()
  await expect(page.getByTestId('profile-list')).toContainText(PROFILE)

  // The new profile is the default: ticked, and nothing to save.
  const policy = page.getByRole('region', { name: 'Where browser pushes go' })
  const box = page.getByRole('checkbox', { name: PROFILE })
  const save = page.getByRole('button', { name: /save default/i })
  const status = page.getByTestId('default-policy-status')
  await expect(box).toBeChecked()
  await expect(save).toBeDisabled()
  await expect(status).toHaveText('This is your saved default.')
  await shot(page, 'g5-01-default-preselected')

  // Nothing ticked: Save stays disabled and says why; never "Saved.".
  await box.uncheck()
  await expect(save).toBeDisabled()
  await expect(status).toContainText('Tick at least one place')
  await expect(policy.getByText('Saved.')).toHaveCount(0)
  await shot(page, 'g5-02-nothing-ticked')
  await box.check()
  await expect(save).toBeDisabled()
  await expect(status).toHaveText('This is your saved default.')
})

test('g2. a release asset uploads on that default; without one the dialog says what is missing (L-10)', async ({ browser }) => {
  const page = await signedIn(browser, 'OWNER', repoPath('releases'))
  await waitForRepoResolved(page)
  await page.getByRole('button', { name: /new release/i }).click({ timeout: 90_000 })
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('#release-assets-hint')).toContainText(`Uploaded to ${PROFILE}`, { timeout: 30_000 })
  await dialog.getByLabel('Tag').fill(TAG)
  await dialog.getByLabel('Title (optional)').fill(`Release ${TAG}`)
  await dialog.locator('input[type="file"]').setInputFiles({ name: `${TAG}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`asset for ${TAG}\n`) })
  const publish = dialog.getByRole('button', { name: /sign & publish/i })
  await expect(publish).toBeEnabled()
  await publish.click()
  await expect(dialog.getByTestId(`asset-${TAG}.txt`)).toHaveAttribute('data-state', 'done', { timeout: 180_000 })
  await expect(dialog.getByRole('status')).toContainText('Release published.', { timeout: 180_000 })
  await shot(page, 'g5-03-release-published')
  await dialog.getByRole('button', { name: /^close$/i }).click()
  await expect(page.getByText(`Release ${TAG}`)).toBeVisible({ timeout: 90_000 })

  // The trap as QA hit it: a profile but no default. This repo's own choice is only Platform:
  // the dialog names the step and links to the page that fixes it.
  await page.goto(repoPath('settings'), { waitUntil: 'domcontentloaded' })
  await unlockAll(page)
  await waitForRepoResolved(page)
  const repoPolicy = page.getByTestId('repo-storage-policy')
  await expect(repoPolicy).toContainText('Using your default', { timeout: 60_000 })
  await repoPolicy.getByRole('checkbox', { name: PROFILE }).uncheck()
  // No Platform profile to tick: with nothing ticked the repo override cannot be saved either.
  await expect(repoPolicy.getByRole('button', { name: /use for this repo/i })).toBeDisabled()
  await page.goto('/settings/storage/', { waitUntil: 'domcontentloaded' })
  await unlockAll(page)
  await page.getByTestId('tile-platform').click()
  await page.getByRole('button', { name: /add dash platform/i }).click()
  await expect(page.getByTestId('profile-list')).toContainText('platform')
  // Adding a second profile never replaces the default.
  await expect(page.getByRole('checkbox', { name: PROFILE })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'platform' })).not.toBeChecked()
  await page.goto(repoPath('settings'), { waitUntil: 'domcontentloaded' })
  await unlockAll(page)
  await waitForRepoResolved(page)
  await expect(repoPolicy).toContainText('Using your default', { timeout: 60_000 })
  await repoPolicy.getByRole('checkbox', { name: PROFILE }).uncheck()
  await repoPolicy.getByRole('checkbox', { name: 'platform' }).check()
  await repoPolicy.getByRole('button', { name: /use for this repo/i }).click()
  await expect(repoPolicy).toContainText('Saved for this repo.')

  await page.goto(repoPath('releases'), { waitUntil: 'domcontentloaded' })
  await unlockAll(page)
  await waitForRepoResolved(page)
  await page.getByRole('button', { name: /new release/i }).click({ timeout: 90_000 })
  const gap = page.getByRole('dialog').getByTestId('release-storage-gap')
  await expect(gap).toHaveAttribute('data-reason', 'platform-only', { timeout: 30_000 })
  await expect(gap).toContainText("This repo's storage choice has only Platform")
  const fix = gap.getByRole('link', { name: "Open this repo's storage settings" })
  await expect(fix).toHaveAttribute('href', /\/repo\/settings\?.*#storage$/)
  await shot(page, 'g5-06-release-dialog-names-the-gap')
  // Back to the default: the dialog uploads to the profile again.
  await fix.click()
  await unlockAll(page)
  await waitForRepoResolved(page)
  await page.getByTestId('repo-storage-policy').getByRole('button', { name: /use my default/i }).click()
  await expect(page.getByTestId('repo-storage-policy')).toContainText('Back to your default.')
})

test('g3. on a file served from S3 the Verification summary names S3, not Platform (L-18)', async ({ browser }) => {
  const page = await signedIn(browser, 'OWNER', repoPath(''))
  await waitForRepoResolved(page)
  const summary = page.getByTestId('verification-summary')
  // The home reads the README from its Platform pack.
  await eventually(page, () => expect(page.getByText('Pushed to Platform.').first()).toBeVisible({ timeout: 60_000 }))
  await expect(summary).toContainText('from Platform', { timeout: 60_000 })
  await shot(page, 'g5-04-home-from-platform')

  // Then the S3 file, in the same tab (a client navigation keeps the session's ledger).
  await page.getByRole('link', { name: 's3file.txt' }).first().click()
  await expect(page.getByText(`served from S3 (${RUN})`)).toBeVisible({ timeout: 90_000 })
  await expect(summary).toContainText(`from ${S3_HOST}`, { timeout: 60_000 })
  await expect(summary).not.toContainText('from Platform')
  await page.getByRole('button', { name: /verification/i }).first().click()
  await shot(page, 'g5-05-s3-file-from-s3')
})

test('g4. a PR watched after it merged shows "marked merged" in the inbox, for one backfill query (L-17)', async ({ browser }) => {
  // CONTRIB opens a PR; CONTRIB marks it merged (a writer's merge event); CONTRIB watches its own
  // PR from the start, so the watcher who arrives LATE is the other user: OWNER.
  const pr = dg('CONTRIB', 'pr', 'create', SLUG, '--base', 'main', '--head', 'feature/greet', '--head-repo', SLUG, '--title', `Greet by name ${RUN}`)
  prNumber = Number(pr['number'])
  expect(prNumber).toBeGreaterThan(0)
  // OWNER watches this repo's state feed through an issue of its own, and its inbox reads it
  // (every thread OWNER opened or commented on is watched; the repo's state feed with it).
  const issue = dg('OWNER', 'issue', 'create', SLUG, '--title', `Watched first ${RUN}`)
  expect(Number(issue['number'])).toBeGreaterThan(0)
  dg('OWNER', 'pr', 'merge', SLUG, String(prNumber))

  const page = await signedIn(browser, 'OWNER', '/notifications/')
  const checkNow = page.getByRole('button', { name: /check now/i })
  const watching = page.getByRole('region', { name: 'What this browser watches' })
  // The first poll reads the state feed PAST the merge: the PR is not watched yet.
  await expect(page.getByText(/Last checked/)).toBeVisible({ timeout: 180_000 })
  await checkNow.click()
  await expect(checkNow).toBeEnabled({ timeout: 180_000 })
  await expect(watching).toContainText(/1 issues and pull requests you opened or commented on/, { timeout: 60_000 })
  await expect(page.getByTestId('inbox-list').getByText('marked merged')).toHaveCount(0)
  await shot(page, 'g18-01-inbox-before-watching')

  // OWNER comments on the merged PR: now it is watched.
  dg('OWNER', 'pr', 'comment', SLUG, String(prNumber), '--body', 'Late to this one: thanks!')
  // "Check now" recomputes the watch list, then backfills the PR's state events: ONE query on
  // the PR's `target` index for the `event` feed (the merge), none for `authorEvent` (nothing
  // since the PR's start that the feed had read past... unless it had: at most one more).
  // Every state-feed read: `event` is a byte substring of `authorEvent`, so this counts both.
  const events = countDocumentQueries(page, 'vent')
  const stateReads = (): number => events.count()
  const before = stateReads()
  const list = page.getByTestId('inbox-list')
  let rounds = 0
  while (rounds < 4) {
    rounds++
    await checkNow.click()
    await expect(checkNow).toBeEnabled({ timeout: 180_000 })
    if (await list.getByText('marked merged').isVisible().catch(() => false)) break
  }
  await expect(watching).toContainText(/2 issues and pull requests you opened or commented on/)
  const row = list.locator('li', { hasText: 'marked merged' })
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(row).toContainText(`#${prNumber}`)
  await expect(row).toContainText(`Greet by name ${RUN}`)
  await shot(page, 'g18-02-inbox-marked-merged')
  // Request budget: the `event` + `authorEvent` feed reads each round, plus at most 2 backfills
  // in total (one per state feed, once). A per-poll re-read of the PR's history would exceed it.
  // (A poll is counted even if the tab's own 60 s timer ran one more.)
  const polls = rounds + 1
  expect(stateReads() - before).toBeLessThanOrEqual(2 * polls + 2)
})
