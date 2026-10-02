import { test, expect, type Request } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DAPI_METHOD, idFile, idOf, shot, signedIn, unlock, waitForRepoResolved } from './helpers'

/**
 * Sync fork (P1-4), live on a devnet with the spec's own identities (real spend, about
 * 0.03 DASH):
 *
 *   E2E_DEVNET=sakura E2E_WRITE=1 E2E_IDENTITY_DIR=<dir with OWNER, CONTRIB> \
 *     E2E_BIN_DIR=<dir with dg + git-remote-dash> pnpm exec playwright test fork-sync.spec.ts
 *
 * The CLI sets up a parent with a pushed `main`, CONTRIB's fork of its default branch only
 * (`dg repo fork --default-branch-only`), and a parent commit the fork does not have:
 *
 *   fs-1. The fork's home, cold and signed out, stays within S-1 (≤ 25 DAPI requests): the fork
 *         bar's two reads included, and the comparison not read until asked for. It says the
 *         branch is not the parent's, and Compare finds it 1 commit behind (no Update for a
 *         stranger).
 *   fs-2. CONTRIB syncs it in the browser (Update branch) → "up to date"; `dg repo sync` agrees.
 *   fs-3. The CLI: the parent moves again → `dg repo sync` fast-forwards; then both sides move →
 *         E105, nothing written.
 */

test.skip(process.env['E2E_WRITE'] !== '1', 'live devnet writes: set E2E_WRITE=1')
test.skip(!process.env['E2E_IDENTITY_DIR'], "set E2E_IDENTITY_DIR to this spec's own identities (never the shared fixtures)")
test.skip(!process.env['E2E_BIN_DIR'], 'set E2E_BIN_DIR to a directory holding dg and git-remote-dash')
test.skip(!!process.env['E2E_IDENTITY_DIR'] && !existsSync(idFile('CONTRIB')), 'OWNER / CONTRIB identity files not found')
test.describe.configure({ mode: 'serial', timeout: 600_000 })

const BIN = process.env['E2E_BIN_DIR'] ?? ''
const ids = process.env['E2E_IDENTITY_DIR'] ? { owner: idOf('OWNER'), contrib: idOf('CONTRIB') } : { owner: '', contrib: '' }
const RUN = process.env['E2E_RUN'] ?? Date.now().toString(36)
const REPO = `fork-sync-${RUN}`
const FORK = `fork-sync-fork-${RUN}`
const SLUG = `${ids.owner}/${REPO}`
const FORK_SLUG = `${ids.contrib}/${FORK}`
const WORK = join(tmpdir(), `dash-forge-${REPO}`)
/** S-1's cold page budget (`page-budget.spec.ts`). */
const COLD_BUDGET = 25

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

/** `dg --yes --json …` as `who`: its exit status and parsed JSON. */
function dgRun(who: string, ...args: string[]): { status: number; json: Record<string, unknown> } {
  const r = spawnSync(join(BIN, 'dg'), ['--yes', '--json', ...args], { env: env(who), cwd: WORK, encoding: 'utf8', timeout: 300_000 })
  return { status: r.status ?? -1, json: JSON.parse(r.stdout || '{}') as Record<string, unknown> }
}

function dg(who: string, ...args: string[]): Record<string, unknown> {
  const r = dgRun(who, ...args)
  if (r.status !== 0) throw new Error(`dg ${args.join(' ')} exited ${r.status}: ${JSON.stringify(r.json)}`)
  return r.json
}

function git(who: string, dir: string, args: string[]): string {
  const r = spawnSync('git', ['-c', 'dash.confirm=never', ...args], { env: env(who), cwd: dir, encoding: 'utf8', timeout: 240_000 })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.stdout}${r.stderr}`)
  return r.stdout.trim()
}

/** A commit on `dir`'s current branch, pushed to `slug`'s `main` as `who`. */
function commitAndPush(who: string, dir: string, slug: string, file: string): string {
  writeFileSync(join(dir, file), `${file} ${Date.now()}\n`)
  execFileSync('git', ['add', file], { cwd: dir })
  execFileSync('git', ['commit', '-qm', `add ${file}`], { cwd: dir })
  git(who, dir, ['push', '-q', `dash://${slug}`, 'HEAD:refs/heads/main'])
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
}

function repoInit(dir: string, who: string): void {
  mkdirSync(dir, { recursive: true })
  const g = (...a: string[]): void => void execFileSync('git', a, { cwd: dir })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', `${who.toLowerCase()}@e2e.forge.invalid`)
  g('config', 'user.name', `E2E ${who}`)
  g('config', 'commit.gpgsign', 'false')
}

const SRC = join(WORK, 'src')

test.beforeAll(() => {
  test.setTimeout(900_000)
  if (!process.env['E2E_IDENTITY_DIR'] || !BIN) return
  rmSync(WORK, { recursive: true, force: true })
  repoInit(SRC, 'Owner')
  writeFileSync(join(SRC, 'README.md'), `# ${REPO}\n`)
  execFileSync('git', ['add', '.'], { cwd: SRC })
  execFileSync('git', ['commit', '-qm', 'first'], { cwd: SRC })
  execFileSync('git', ['tag', 'v1'], { cwd: SRC })
  dg('OWNER', 'repo', 'create', REPO, '--storage', 'platform')
  git('OWNER', SRC, ['push', '-q', `dash://${SLUG}`, 'main:refs/heads/main', 'v1'])
  const forked = dg('CONTRIB', 'repo', 'fork', SLUG, '--name', FORK, '--default-branch-only')
  // The default branch alone: no tag.
  expect(forked['refsWritten']).toEqual(['refs/heads/main'])
  commitAndPush('OWNER', SRC, SLUG, 'one.txt')
})

test.afterAll(() => rmSync(WORK, { recursive: true, force: true }))

test('fs-1. the fork home, cold and signed out, within S-1; Compare finds it 1 commit behind', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const dapi: string[] = []
  page.on('request', (r: Request) => {
    const m = DAPI_METHOD.exec(r.url())?.[1]
    if (m !== undefined) dapi.push(m)
  })
  await page.goto(`/repo/?owner=${ids.contrib}&name=${FORK}`, { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page)
  const status = page.getByTestId('fork-sync-status')
  await expect(status).toContainText('is not the same as', { timeout: 120_000 })
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined)
  await page.waitForTimeout(2_500)
  const cold = dapi.length
  test.info().annotations.push({ type: 'dapi', description: `fork home cold: ${cold}` })
  expect(cold).toBeLessThanOrEqual(COLD_BUDGET)
  await page.getByTestId('fork-sync-open').click()
  await expect(page.getByTestId('fork-sync-behind')).toContainText('1 commit behind', { timeout: 120_000 })
  await expect(page.getByTestId('fork-sync-update')).toHaveCount(0)
  await shot(page, 'fs-01-fork-compare-signed-out')
  await context.close()
})

test('fs-2. the fork owner syncs it in the browser', async ({ browser }) => {
  const page = await signedIn(browser, 'CONTRIB', `/repo/?owner=${ids.contrib}&name=${FORK}`)
  await waitForRepoResolved(page)
  await page.getByTestId('fork-sync-open').click({ timeout: 120_000 })
  const update = page.getByTestId('fork-sync-update')
  await expect(update).toBeEnabled({ timeout: 120_000 })
  await expect(page.getByTestId('cost-preview').first()).toBeVisible()
  await update.click()
  // The home re-reads until the moved branch shows (a node a block behind).
  await expect(page.getByTestId('fork-sync-status')).toContainText('is up to date with', { timeout: 180_000 }).catch(async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await unlock(page)
    await expect(page.getByTestId('fork-sync-status')).toContainText('is up to date with', { timeout: 120_000 })
  })
  await shot(page, 'fs-02-fork-synced')
  expect(dg('CONTRIB', 'repo', 'sync', FORK_SLUG)['status']).toBe('up_to_date')
  await page.context().close()
})

test('fs-3. dg repo sync: a fast-forward, then E105 when both sides moved', async () => {
  const tip = commitAndPush('OWNER', SRC, SLUG, 'two.txt')
  const synced = dg('CONTRIB', 'repo', 'sync', FORK_SLUG)
  expect(synced['status']).toBe('synced')
  expect(synced['to']).toBe(tip)
  // The fork gets a commit of its own, and the parent another: no fast-forward.
  const fork = join(WORK, 'fork')
  git('CONTRIB', WORK, ['clone', '-q', `dash://${FORK_SLUG}`, fork])
  execFileSync('git', ['config', 'user.email', 'contrib@e2e.forge.invalid'], { cwd: fork })
  execFileSync('git', ['config', 'user.name', 'E2E Contrib'], { cwd: fork })
  commitAndPush('CONTRIB', fork, FORK_SLUG, 'mine.txt')
  expect(dg('CONTRIB', 'repo', 'sync', FORK_SLUG)['status']).toBe('ahead')
  commitAndPush('OWNER', SRC, SLUG, 'three.txt')
  const diverged = dgRun('CONTRIB', 'repo', 'sync', FORK_SLUG)
  expect(diverged.status).not.toBe(0)
  expect(diverged.json['status']).toBe('diverged')
  expect([diverged.json['ahead'], diverged.json['behind']]).toEqual([1, 1])
})
