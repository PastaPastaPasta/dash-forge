import { test, expect, type Request } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DAPI_METHOD, idFile, idOf, shot, signedIn, waitForRepoResolved } from './helpers'

/**
 * Branch and tag administration from the browser (P1-4), live on a devnet with the spec's own
 * identities (real spend, about 0.02 DASH):
 *
 *   E2E_DEVNET=sakura E2E_WRITE=1 E2E_IDENTITY_DIR=<dir with OWNER, COLLAB> \
 *     E2E_BIN_DIR=<dir with dg + git-remote-dash> pnpm exec playwright test ref-admin.spec.ts
 *
 * The CLI sets up a repo with `main`, a `release/*` protection and a protected `release/1`, and
 * COLLAB as a writer:
 *
 *   ra-1. The branches page, cold and signed out, within S-1 (≤ 25 DAPI requests); no controls.
 *   ra-2. OWNER creates a branch from main, deletes it, and restores it from the page.
 *   ra-3. COLLAB (a writer) cannot create a branch matching a protected pattern, nor delete the
 *         default or a protected branch: each control says why.
 *   ra-4. OWNER publishes a release on a new tag: the tag is created at main's tip (`dg repo view`
 *         agrees), and the tags page lists it.
 */

test.skip(process.env['E2E_WRITE'] !== '1', 'live devnet writes: set E2E_WRITE=1')
test.skip(!process.env['E2E_IDENTITY_DIR'], "set E2E_IDENTITY_DIR to this spec's own identities (never the shared fixtures)")
test.skip(!process.env['E2E_BIN_DIR'], 'set E2E_BIN_DIR to a directory holding dg and git-remote-dash')
test.skip(!!process.env['E2E_IDENTITY_DIR'] && !existsSync(idFile('COLLAB')), 'OWNER / COLLAB identity files not found')
test.describe.configure({ mode: 'serial', timeout: 600_000 })

const BIN = process.env['E2E_BIN_DIR'] ?? ''
const ids = process.env['E2E_IDENTITY_DIR'] ? { owner: idOf('OWNER'), collab: idOf('COLLAB') } : { owner: '', collab: '' }
const RUN = process.env['E2E_RUN'] ?? Date.now().toString(36)
const REPO = `ref-admin-${RUN}`
const SLUG = `${ids.owner}/${REPO}`
const WORK = join(tmpdir(), `dash-forge-${REPO}`)
/** S-1's cold page budget (`page-budget.spec.ts`). */
const COLD_BUDGET = 25
const BRANCHES = `/repo/branches/?owner=${ids.owner}&name=${REPO}`

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
  const r = spawnSync(join(BIN, 'dg'), ['--yes', '--json', ...args], { env: env(who), cwd: WORK, encoding: 'utf8', timeout: 300_000 })
  if (r.status !== 0) throw new Error(`dg ${args.join(' ')} exited ${r.status}: ${r.stdout}${r.stderr}`)
  return JSON.parse(r.stdout || '{}') as Record<string, unknown>
}

function git(who: string, dir: string, args: string[]): void {
  const r = spawnSync('git', ['-c', 'dash.confirm=never', ...args], { env: env(who), cwd: dir, encoding: 'utf8', timeout: 240_000 })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.stdout}${r.stderr}`)
}

/** Where `refName` points now, per `dg repo view` (null: absent or deleted). */
function tipOf(refName: string): string | null {
  const refs = dg('OWNER', 'repo', 'view', SLUG)['refs'] as { name: string; state: { state: string; oid?: string } }[]
  return refs.find((r) => r.name === refName)?.state.oid ?? null
}

let mainTip = ''

test.beforeAll(() => {
  test.setTimeout(900_000)
  if (!process.env['E2E_IDENTITY_DIR'] || !BIN) return
  rmSync(WORK, { recursive: true, force: true })
  const src = join(WORK, 'src')
  mkdirSync(src, { recursive: true })
  const g = (...a: string[]): string => execFileSync('git', a, { cwd: src, encoding: 'utf8' }).trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'owner@e2e.forge.invalid')
  g('config', 'user.name', 'E2E Owner')
  g('config', 'commit.gpgsign', 'false')
  writeFileSync(join(src, 'README.md'), `# ${REPO}\n`)
  g('add', '.')
  g('commit', '-qm', 'first')
  mainTip = g('rev-parse', 'HEAD')
  dg('OWNER', 'repo', 'create', REPO, '--storage', 'platform')
  dg('OWNER', 'repo', 'protect', 'add', SLUG, 'release/*')
  git('OWNER', src, ['push', '-q', `dash://${SLUG}`, 'main:refs/heads/main', 'main:refs/heads/release/1'])
  dg('COLLAB', 'collab', 'accept', SLUG)
  dg('OWNER', 'collab', 'add', SLUG, ids.collab, '--role', 'writer', '--wait', '60')
})

test.afterAll(() => rmSync(WORK, { recursive: true, force: true }))

test('ra-1. the branches page, cold and signed out, within S-1, with no controls', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const dapi: string[] = []
  page.on('request', (r: Request) => {
    const m = DAPI_METHOD.exec(r.url())?.[1]
    if (m !== undefined) dapi.push(m)
  })
  await page.goto(BRANCHES, { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page)
  await expect(page.locator('a', { hasText: 'release/1' })).toBeVisible({ timeout: 120_000 })
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined)
  await page.waitForTimeout(2_500)
  test.info().annotations.push({ type: 'dapi', description: `branches cold: ${dapi.length}` })
  expect(dapi.length).toBeLessThanOrEqual(COLD_BUDGET)
  await expect(page.getByTestId('new-branch')).toHaveCount(0)
  await expect(page.getByTestId('delete-branch')).toHaveCount(0)
  await context.close()
})

test('ra-2. the owner creates, deletes and restores a branch', async ({ browser }) => {
  const page = await signedIn(browser, 'OWNER', BRANCHES)
  await waitForRepoResolved(page)
  await page.getByTestId('new-branch').click({ timeout: 120_000 })
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('New branch name').fill('feature/e2e')
  await expect(dialog.getByTestId('cost-preview')).toBeVisible()
  await dialog.getByTestId('new-branch-create').click()
  await expect(dialog).toBeHidden({ timeout: 180_000 })
  await expect(page.locator('a', { hasText: 'feature/e2e' })).toBeVisible({ timeout: 120_000 })
  await expect.poll(() => tipOf('refs/heads/feature/e2e'), { timeout: 60_000 }).toBe(mainTip)

  await page.getByRole('button', { name: 'Delete branch feature/e2e' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete branch', exact: true }).click()
  await expect(page.getByTestId('restore-branch')).toBeVisible({ timeout: 180_000 })
  await shot(page, 'ra-02-branch-deleted')
  await page.getByTestId('restore-branch').click()
  await expect(page.locator('a', { hasText: 'feature/e2e' })).toBeVisible({ timeout: 180_000 })
  await expect.poll(() => tipOf('refs/heads/feature/e2e'), { timeout: 60_000 }).toBe(mainTip)
  await page.context().close()
})

test('ra-3. a writer: protected patterns and the default branch are refused, with the reason', async ({ browser }) => {
  const page = await signedIn(browser, 'COLLAB', BRANCHES)
  await waitForRepoResolved(page)
  await expect(page.getByTestId('new-branch')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByRole('button', { name: /^main is the default branch/ })).toBeDisabled()
  await expect(page.getByRole('button', { name: /^release\/1 is protected/ })).toBeDisabled()
  await page.getByTestId('new-branch').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('New branch name').fill('release/2')
  await expect(dialog.locator('#new-branch-problem')).toHaveText('release/2 matches the protected pattern refs/heads/release/*: only maintainers can create this branch.')
  await expect(dialog.getByTestId('new-branch-create')).toBeDisabled()
  await shot(page, 'ra-03-writer-protected')
  await page.context().close()
})

test('ra-4. a release on a new tag creates the tag at the target branch', async ({ browser }) => {
  const page = await signedIn(browser, 'OWNER', `/repo/releases/?owner=${ids.owner}&name=${REPO}`)
  await waitForRepoResolved(page)
  await page.getByTestId('new-release').click({ timeout: 120_000 })
  await page.locator('#release-tag').fill('v1.0.0')
  await expect(page.getByTestId('release-new-tag')).toContainText('v1.0.0 is a new tag')
  await expect(page.getByTestId('release-tag-target')).toHaveValue('refs/heads/main')
  await page.getByRole('button', { name: /Sign & publish/ }).click()
  await expect(page.getByTestId('release-done')).toBeVisible({ timeout: 180_000 })
  await shot(page, 'ra-04-release-new-tag')
  await expect.poll(() => tipOf('refs/tags/v1.0.0'), { timeout: 60_000 }).toBe(mainTip)
  await page.goto(`/repo/tags/?owner=${ids.owner}&name=${REPO}`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('a', { hasText: 'v1.0.0' })).toBeVisible({ timeout: 120_000 })
  await page.context().close()
})
