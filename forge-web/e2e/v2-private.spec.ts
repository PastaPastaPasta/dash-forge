/**
 * A private repository end to end on moutai (`docs/security/private-repos.md`; `ux-dx-spec.md`
 * §9): OWNER creates it in the browser (the four facts, the epoch-0 key and sealed anchor) →
 * pushes a branch with the CLI (a sealed Platform pack, the ref name in `enc`) → browses the
 * decrypted tree and file → opens an issue and comments (sealed) → adds CONTRIB as a writer
 * (membership + wrap) → CONTRIB reads the code and the issue → OWNER removes CONTRIB (delete →
 * rotation) → CONTRIB is locked out, and the chain holds no plaintext name, title or body.
 *
 * Writes real documents (about 0.019 DASH of OWNER's, measured 2026-09-27), so it runs only with E2E_WRITE=1, and it
 * needs `dg` and `git-remote-dash` (E2E_BIN_DIR, else `target/release`). Its repo is
 * `forge-v2-private-<run>`, OWNER's, new each run (reserved in e2e/README.md).
 *
 *   E2E_DEVNET=sakura E2E_WRITE=1 E2E_BIN_DIR=… pnpm exec playwright test v2-private.spec.ts
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect, test, type Browser, type Locator, type Page } from '@playwright/test'
import { deployment, E2E_DEVNET, idFile, idOrEmpty, nodeSdk, PASSPHRASE, stateFile, unlock, waitForRepoResolved } from './helpers'

const RUN = Date.now().toString(36)
const NAME = `forge-v2-private-${RUN}`
const SHOTS = process.env['E2E_SHOTS'] ?? join(__dirname, 'screenshots', 'v2-private')
const OWNER = idOrEmpty('OWNER')
const CONTRIB = idOrEmpty('CONTRIB')
const ROOT = resolve(__dirname, '../..')
const BIN = process.env['E2E_BIN_DIR'] ?? join(ROOT, 'target', 'release')
const SECRET = { branch: 'refs/heads/main', file: 'hidden-plan.md', text: `the plan ${RUN}`, title: `secret issue ${RUN}`, body: `secret body ${RUN}`, comment: `secret comment ${RUN}` }

test.describe.configure({ mode: 'serial', timeout: 600_000 })
test.skip(process.env['E2E_WRITE'] !== '1', 'writes real documents: set E2E_WRITE=1')
test.skip(OWNER === '' || CONTRIB === '', 'OWNER / CONTRIB identity files not found')
test.skip(!existsSync(join(BIN, 'dg')) || !existsSync(join(BIN, 'git-remote-dash')), `needs dg and git-remote-dash in ${BIN} (E2E_BIN_DIR)`)

const shot = (page: Page, name: string): Promise<Buffer> => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true })
const url = (path: string, extra = ''): string => `/repo${path}/?owner=${OWNER}&name=${NAME}${extra}`

/**
 * A page load keeps only the spend-capped signing key (session persistence): this tab's
 * encryption key opens again with the passphrase, in whichever inline prompt the page shows
 * (the repo's "Unlock to view this private repo", Settings' encryption panel, New repo's).
 * Waits for that prompt or for `ready` (what the page shows when no unlock is needed).
 */
async function unlockEncryption(page: Page, ready: Locator): Promise<void> {
  const prompt = page.locator('[data-testid=private-unlock], [data-testid=encryption-unlock], [data-testid=new-private-unlock]').first()
  await expect(prompt.or(ready).first()).toBeVisible({ timeout: 120_000 })
  if (!(await prompt.isVisible())) return
  await prompt.getByLabel('Passphrase').fill(PASSPHRASE)
  await prompt.getByRole('button', { name: /^unlock$/i }).click()
  await expect(prompt).toBeHidden({ timeout: 60_000 })
}

/** A context signed in as `name` whose vault holds the identity's encryption key. */
async function member(
  browser: Browser,
  name: 'OWNER' | 'CONTRIB',
): Promise<{ page: Page; go: (p: string) => Promise<void>; settings: () => Promise<void>; close: () => Promise<void> }> {
  const saved = stateFile(name)
  const context = await browser.newContext(existsSync(saved) ? { storageState: saved } : {})
  const page = await context.newPage()
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  if (existsSync(saved)) {
    await unlock(page)
  } else {
    await page.getByRole('button', { name: /^sign in$/i }).first().click()
    await page.getByTestId('tile-import').click()
    await page.setInputFiles('input[type="file"]', idFile(name))
    await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
    await page.getByLabel('Repeat passphrase').fill(PASSPHRASE)
    await page.getByTestId('enable-private-repos').check()
    await page.getByRole('button', { name: /create this browser's key/i }).click()
    await expect(page.getByTestId('funds-pill')).toBeVisible({ timeout: 120_000 })
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 120_000 })
    mkdirSync(join(__dirname, '.playwright', 'auth'), { recursive: true, mode: 0o700 })
    await context.storageState({ path: saved, indexedDB: true })
  }
  await page.goto('/settings/', { waitUntil: 'domcontentloaded' })
  await unlock(page)
  await expect(page.getByTestId('encryption-key-panel')).toBeVisible({ timeout: 60_000 })
  const stored = page.getByTestId('encryption-key-stored')
  await unlockEncryption(page, stored.or(page.locator('#enc-file')))
  await expect(stored.or(page.locator('#enc-file')).first()).toBeVisible({ timeout: 60_000 })
  if (!(await stored.isVisible())) {
    await page.setInputFiles('#enc-file', idFile(name))
    await expect(page.getByTestId('encryption-key-stored')).toBeVisible({ timeout: 60_000 })
  }
  const go = async (path: string): Promise<void> => {
    await page.goto(path, { waitUntil: 'domcontentloaded' })
    await unlock(page)
    await waitForRepoResolved(page, 120_000)
    // Ready without a prompt: decrypted (the chip names the key epoch), or not a member at all.
    const decrypted = page.getByTestId('private-chip').filter({ hasText: /decrypted with your key/ })
    await unlockEncryption(page, decrypted.or(page.getByTestId('private-repo').filter({ hasText: /You're not one/ })))
  }
  // The repo's Settings has no inline unlock after a page load: unlock on the repo home, then
  // open Settings in-app (a hard navigation would lock the tab's encryption key again).
  const settings = async (): Promise<void> => {
    await go(url(''))
    await page.getByRole('navigation', { name: 'Repository' }).getByRole('link', { name: /^settings/i }).click()
    await expect(page.locator('#member-id')).toBeVisible({ timeout: 90_000 })
  }
  return { page, go, settings, close: () => context.close() }
}

/** Run `dg`/git with the CLI's moutai env as `role`. */
function cli(role: 'OWNER' | 'CONTRIB', cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd === 'git' ? 'git' : join(BIN, cmd), args, {
    cwd,
    encoding: 'utf8',
    timeout: 300_000,
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env['PATH']}`,
      DASH_FORGE_NETWORK: 'devnet',
      DASH_FORGE_DEVNET_NAME: E2E_DEVNET,
      DASH_FORGE_KEY: idFile(role),
      RUST_LOG: 'error',
      NO_COLOR: '1',
    },
  })
}

/** Every document of `type` in the repo, raw from Platform (what everyone sees). */
async function rawDocs(type: string, contract: 'core' | 'collab'): Promise<string> {
  const sdk = await nodeSdk()
  const dep = deployment()
  const repos = await sdk.documents.query({ dataContractId: dep.v2.forgeCore.contractId, documentTypeName: 'repo', where: [['$ownerId', '==', OWNER], ['name', '==', NAME]], limit: 1 })
  const repoId = [...repos.keys()][0]
  const docs = await sdk.documents.query({
    dataContractId: contract === 'core' ? dep.v2.forgeCore.contractId : dep.v2.forgeCollab.contractId,
    documentTypeName: type,
    where: [['repoId', '==', repoId]],
    limit: 100,
  })
  return JSON.stringify([...docs.values()].map((d: { toJSON(v: number): unknown }) => d.toJSON(sdk.version())))
}

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }))

test('1. OWNER creates a private repo in the browser: four facts, key and sealed config', async ({ browser }) => {
  const { page, close } = await member(browser, 'OWNER')
  await page.goto('/new/', { waitUntil: 'domcontentloaded' })
  await unlock(page)
  await page.locator('#repo-name').fill(NAME)
  await page.getByTestId('visibility-private').click()
  await unlockEncryption(page, page.getByTestId('private-facts'))
  await expect(page.getByTestId('private-facts')).toContainText('no recovery: if every member loses their encryption key, the contents are gone')
  await expect(page.getByTestId('private-no-key')).toHaveCount(0)
  await shot(page, '01-new-private')
  await page.getByRole('button', { name: /^create repository$/i }).click()
  await expect(page.getByRole('dialog')).toContainText('members keep whatever they could already read')
  await shot(page, '02-create-confirm')
  await page.getByRole('button', { name: /sign & create/i }).click()
  // The page drops `created=1` from the bar once it has read it: match the route, not the param.
  await page.waitForURL(/\/repo\/\?/, { timeout: 300_000 })
  await waitForRepoResolved(page, 120_000)
  await expect(page.getByTestId('private-chip')).toHaveText(/Private · decrypted with your key \(epoch 0\)/, { timeout: 120_000 })
  await shot(page, '03-created')
  await close()
})

test('2. OWNER pushes a branch with the CLI: a sealed pack, the ref name only in enc', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v2-private-'))
  try {
    cli('OWNER', 'git', ['init', '-q', '-b', 'main', dir])
    writeFileSync(join(dir, SECRET.file), `${SECRET.text}\n`)
    cli('OWNER', 'git', ['-c', 'user.email=e2e@dash-forge.test', '-c', 'user.name=E2E', 'add', '-A'], dir)
    cli('OWNER', 'git', ['-c', 'user.email=e2e@dash-forge.test', '-c', 'user.name=E2E', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'secret commit'], dir)
    cli('OWNER', 'git', ['push', `dash://${OWNER}/${NAME}`, `${SECRET.branch}:${SECRET.branch}`], dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  // main is protected by default in the CLI's create, not the web's: either type, no name.
  const refs = (await rawDocs('refUpdate', 'core')) + (await rawDocs('protectedRefUpdate', 'core'))
  expect(refs).not.toContain('refs/heads/main')
})

test('3. OWNER browses the decrypted tree and file; opens an issue and comments (sealed)', async ({ browser }) => {
  const { page, go, close } = await member(browser, 'OWNER')
  await go(url(''))
  await expect(page.getByText(SECRET.file)).toBeVisible({ timeout: 120_000 })
  await shot(page, '04-owner-tree')
  await go(url('/issues'))
  await page.getByRole('button', { name: /new issue/i }).first().click()
  await page.locator('#issue-title').fill(SECRET.title)
  await page.locator('#issue-body').fill(SECRET.body)
  await expect(page.getByTestId('sealed-limit')).toContainText('bytes')
  await shot(page, '05-issue-compose')
  await page.getByRole('button', { name: /^submit issue$/i }).click()
  // A private repo's address bar keeps the canonical route: its links carry per-tab tokens.
  await page.waitForURL(/\/repo\/issue\/?\?.*number=1(&|$)/, { timeout: 300_000 })
  await waitForRepoResolved(page, 120_000)
  await expect(page.getByText(SECRET.body)).toBeVisible({ timeout: 120_000 })
  expect(page.url(), 'a private repo never shows a short URL').toMatch(/\/repo\/issue\/?\?.*number=1(&|$)/)
  await page.locator('#comment-body').fill(SECRET.comment)
  await page.getByRole('button', { name: /^comment$/i }).click()
  // Posted once the composer clears and the comment shows in the thread (not in the textarea).
  await expect(page.locator('#comment-body')).toHaveValue('', { timeout: 300_000 })
  await expect(page.getByText(SECRET.comment, { exact: true })).toBeVisible({ timeout: 120_000 })
  await shot(page, '06-issue-comment')
  await close()
  const collab = (await rawDocs('issue', 'collab')) + (await rawDocs('comment', 'collab').catch(() => ''))
  for (const s of [SECRET.title, SECRET.body, SECRET.comment]) expect(collab).not.toContain(s)
})

test('4. OWNER adds CONTRIB as a writer; CONTRIB reads the code and the issue', async ({ browser }) => {
  // RC1 consent (R-06): the member accepts before the owner can add them.
  cli('CONTRIB', 'dg', ['collab', 'accept', `${OWNER}/${NAME}`, '--yes'])
  const owner = await member(browser, 'OWNER')
  await owner.settings()
  await owner.page.locator('#member-id').fill(CONTRIB)
  await expect(owner.page.getByRole('button', { name: /^add$/i })).toBeEnabled({ timeout: 60_000 })
  await owner.page.getByRole('button', { name: /^add$/i }).click()
  await owner.page.getByRole('button', { name: /sign & add/i }).click()
  await expect(owner.page.getByRole('dialog').getByText(/confirmed on platform/i)).toBeVisible({ timeout: 300_000 })
  await shot(owner.page, '07-member-added')
  await owner.close()

  const contrib = await member(browser, 'CONTRIB')
  await contrib.go(url('/issue', '&number=1'))
  await expect(contrib.page.getByText(SECRET.body)).toBeVisible({ timeout: 120_000 })
  await expect(contrib.page.getByText(SECRET.comment, { exact: true })).toBeVisible({ timeout: 60_000 })
  await shot(contrib.page, '08-contrib-reads-issue')
  await contrib.go(url(''))
  await expect(contrib.page.getByText(SECRET.file)).toBeVisible({ timeout: 120_000 })
  await shot(contrib.page, '09-contrib-reads-tree')
  await contrib.close()
})

test('5. OWNER removes CONTRIB: the warning, then delete → rotation to epoch 1', async ({ browser }) => {
  const { page, settings, close } = await member(browser, 'OWNER')
  await settings()
  const row = page.getByTestId('private-members').locator('div', { hasText: /writer/ }).filter({ has: page.getByRole('button', { name: /remove/i }) }).last()
  await row.getByRole('button', { name: /remove/i }).click()
  await expect(page.getByRole('dialog')).toContainText(/rotates the repo key/)
  await page.getByRole('button', { name: /sign & remove/i }).click()
  await expect(page.getByRole('dialog').getByText(/confirmed on platform/i)).toBeVisible({ timeout: 480_000 })
  await shot(page, '10-removed')
  await page.keyboard.press('Escape')
  await settings()
  await expect(page.getByTestId('key-epoch')).toContainText('key epoch 1', { timeout: 120_000 })
  await shot(page, '11-rotated')
  await close()
})

test('6. CONTRIB, removed, is locked out; the chain still holds no plaintext', async ({ browser }) => {
  const { page, go, close } = await member(browser, 'CONTRIB')
  await go(url('/issues'))
  await expect(page.getByTestId('private-repo')).toBeVisible({ timeout: 120_000 })
  const html = await page.content()
  for (const s of [SECRET.title, SECRET.body, SECRET.comment, SECRET.file]) expect(html).not.toContain(s)
  await shot(page, '12-contrib-locked-out')
  await close()
})
