import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { FUNDS_PILL, PASSPHRASE, SESSION_UNLOCK, expectLocked, expectSignedIn, idFile, readKeptSession, repoUrl, shot, waitForRepoResolved } from './helpers'

/**
 * The session lasts until it locks (G1, L-04, L-05; G19), live on moutai:
 *
 *   E2E_DEVNET=bonsia E2E_WRITE=1 E2E_IDENTITY_DIR=<dir> E2E_SESSION_IDENTITY=<name> \
 *     pnpm exec playwright test session-persistence.spec.ts
 *
 * One import registers one limited key for a FRESH identity (E2E_SESSION_IDENTITY, default
 * SESSION, in E2E_IDENTITY_DIR; never a shared fixture). Then, with no further spend:
 *
 * p1. A reload and a new tab stay signed in for public repos (no passphrase asked), and after a
 *     reload a public write (Star) signs with no prompt. The kept record holds the limited key
 *     only: its IndexedDB row is checked for the encryption key.
 * p2. Lock in tab A locks tab B at once; the header of every page says "Session locked — Unlock",
 *     a write button opens Unlock (not the tile list), and a reload stays locked.
 * p3. "Stay signed in for public repos" off (Settings → Security): a reload starts locked.
 * p4. The owner of a private repo: after a reload the repo asks "Unlock to view this private
 *     repo" (inline, not the sign-in chooser); after it the repo reads in that tab; a new tab asks
 *     again. Locked, it offers Unlock instead of "You're not one" (L-05).
 * p5. Clicking the fixed links (header, footer, account menu, settings, repo tabs) never loads
 *     a document (G19: every in-app href has its trailing slash).
 * p6. The 12-hour lock (an injected clock): past it, a reload is locked and nothing is kept.
 */

const NAME = process.env['E2E_SESSION_IDENTITY'] ?? 'SESSION'
test.skip(process.env['E2E_WRITE'] !== '1', 'registers a limited key (real spend): set E2E_WRITE=1')
test.skip(!process.env['E2E_IDENTITY_DIR'], 'use a fresh identity: set E2E_IDENTITY_DIR (never a shared fixture)')
test.skip(!existsSync(idFile(NAME)), `no identity file ${idFile(NAME)}`)
test.describe.configure({ mode: 'serial', timeout: 10 * 60_000 })

let context: BrowserContext

/** Whether the page's origin holds a kept session (the IndexedDB record reloads pick up). */
const hasKept = async (page: Page): Promise<boolean> => (await readKeptSession(page)) !== null

/** Unlock from the header with the passphrase. */
async function unlockFromHeader(page: Page): Promise<void> {
  await page.getByRole('banner').getByTestId(SESSION_UNLOCK).click()
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
  await page.getByRole('button', { name: /^unlock$/i }).click()
  await expectSignedIn(page)
  await expect(page.getByRole('dialog')).toBeHidden()
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext()
})
test.afterAll(async () => {
  await context?.close()
})

test('p1. import once, then a reload and a new tab stay signed in', async () => {
  const page = await context.newPage()
  await page.goto('/settings/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /^sign in$/i }).first().click()
  await page.getByTestId('tile-import').click()
  await page.setInputFiles('input[type="file"]', idFile(NAME))
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
  await page.getByLabel('Repeat passphrase').fill(PASSPHRASE)
  // p5 creates a private repo as this identity: keep its encryption key too.
  await page.getByTestId('enable-private-repos').check()
  await page.getByRole('button', { name: /create this browser's key/i }).click()
  await expect(page.getByTestId(FUNDS_PILL)).toBeVisible({ timeout: 180_000 })
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 60_000 })
  await expect.poll(() => hasKept(page)).toBe(true)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expectSignedIn(page)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await shot(page, 'session-p1-after-reload')
  // The kept record: one sealed signing key, nothing else of the vault (no encryption key).
  const row = Object.keys((await readKeptSession(page)) ?? {}).sort()
  expect(row).toEqual(['expiresAt', 'hint', 'identityId', 'iv', 'keyId', 'network', 'savedAt', 'usedAt', 'version', 'wrapKey', 'wrapped'])

  // A public write right after a reload signs with no prompt: Star, then Unstar.
  await page.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
  await expectSignedIn(page)
  await waitForRepoResolved(page)
  const star = page.getByTestId('star-button')
  await expect(star).toBeEnabled({ timeout: 90_000 })
  const wasStarred = /^Starred/.test((await star.getAttribute('aria-label')) ?? '')
  const flipped = wasStarred ? /^Star \(/ : /^Starred/
  await star.click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(star).toHaveAttribute('aria-label', flipped, { timeout: 120_000 })
  await shot(page, 'session-p1-star-after-reload')
  // Put it back (an unstar refunds the star's storage).
  await star.click()
  await expect(star).toHaveAttribute('aria-label', wasStarred ? /^Starred/ : /^Star \(/, { timeout: 120_000 })

  const tab = await context.newPage()
  await tab.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
  await expectSignedIn(tab)
  await shot(tab, 'session-p1-new-tab')
  // A typed URL is a document load too.
  await tab.goto('/explore/', { waitUntil: 'domcontentloaded' })
  await expectSignedIn(tab)
  await tab.close()
})

test('p2. Lock in one tab locks the others; pages offer Unlock; write buttons open it', async () => {
  const [a] = context.pages()
  const b = await context.newPage()
  await b.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
  await expectSignedIn(b)

  await a!.getByRole('button', { name: 'Account menu' }).click()
  await a!.getByRole('button', { name: /^lock\b/i }).click()
  await expectLocked(a!)
  // Tab B locks at once, with no reload.
  await expectLocked(b)
  await expect(b.getByRole('banner').getByTestId(SESSION_UNLOCK)).toContainText('Unlock')
  await shot(b, 'session-p2-other-tab-locked')

  // Star opens Unlock directly (the stored key), not the sign-in tiles.
  await waitForRepoResolved(b)
  await b.getByTestId('star-button').click()
  const dialog = b.getByRole('dialog')
  await expect(dialog.getByLabel('Passphrase', { exact: true })).toBeVisible()
  await expect(dialog.getByTestId('tile-import')).toHaveCount(0)
  await shot(b, 'session-p2-star-opens-unlock')
  await b.keyboard.press('Escape')

  // Locked survives a reload (the kept session was wiped).
  await b.reload({ waitUntil: 'domcontentloaded' })
  await expectLocked(b)
  await unlockFromHeader(b)
  // Unlocking in B signs A in too (a kept session is announced to the other tabs).
  await expectSignedIn(a!)
  await b.close()
})

test('p3. "Stay signed in for public repos" off restores lock-on-reload', async () => {
  const [page] = context.pages()
  await page!.goto('/settings/', { waitUntil: 'domcontentloaded' })
  await expectSignedIn(page!)
  const toggle = page!.getByTestId('stay-signed-in')
  await expect(toggle).toBeChecked()
  await toggle.uncheck()
  await shot(page!, 'session-p3-strict-on')
  await page!.reload({ waitUntil: 'domcontentloaded' })
  await expectLocked(page!)
  await unlockFromHeader(page!)
  await page!.getByTestId('stay-signed-in').check()
  // Ticking keeps the open session (written asynchronously): a reload after it stays signed in.
  await expect.poll(() => hasKept(page!)).toBe(true)
  await page!.reload({ waitUntil: 'domcontentloaded' })
  await expectSignedIn(page!)
})

test('p4. the locked OWNER of a private repo is offered Unlock, not "You\'re not one"', async () => {
  const page = context.pages()[0]!
  // The identity creates its own private repo (about 0.02 DASH), then locks.
  const name = `g1-private-${Date.now().toString(36)}`
  const owner = (JSON.parse(readFileSync(idFile(NAME), 'utf8')) as { identityId: string }).identityId
  await page.goto('/new/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('banner').getByTestId(SESSION_UNLOCK).or(page.getByTestId(FUNDS_PILL)).first().waitFor({ timeout: 60_000 })
  if (await page.getByRole('banner').getByTestId(SESSION_UNLOCK).isVisible()) await unlockFromHeader(page)
  await page.locator('#repo-name').fill(name)
  await page.getByTestId('visibility-private').click()
  // This tab resumed after a reload (p3): the encryption key asks for an inline unlock first.
  const newUnlock = page.getByTestId('new-private-unlock')
  if (await newUnlock.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await shot(page, 'session-p4-new-private-asks-unlock')
    await newUnlock.getByLabel('Passphrase').fill(PASSPHRASE)
    await newUnlock.getByRole('button', { name: /^unlock$/i }).click()
    await expect(newUnlock).toHaveCount(0, { timeout: 60_000 })
  }
  await page.getByRole('button', { name: /^create repository$/i }).click()
  await page.getByRole('button', { name: /sign & create/i }).click()
  await page.waitForURL(/created=1/, { timeout: 300_000 })
  await waitForRepoResolved(page, 120_000)
  await expect(page.getByTestId('private-chip')).toBeVisible({ timeout: 120_000 })
  const privateUrl = repoUrl('', '', { owner, name })

  // A reload keeps only the signing key: the private repo asks to unlock, inline.
  await page.goto(privateUrl, { waitUntil: 'domcontentloaded' })
  await expectSignedIn(page)
  const prompt = page.getByTestId('private-unlock')
  await expect(prompt).toBeVisible({ timeout: 90_000 })
  await expect(prompt).toContainText('Unlock to view this private repo')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await shot(page, 'session-p4-private-asks-unlock')
  await prompt.getByLabel('Passphrase').fill(PASSPHRASE)
  await prompt.getByRole('button', { name: /^unlock$/i }).click()
  await expect(page.getByTestId('private-chip')).toBeVisible({ timeout: 120_000 })
  // In this tab it stays open: browsing within the repo does not ask again.
  await page.getByRole('navigation', { name: 'Repository' }).getByRole('link', { name: /^issues/i }).click()
  await expect(page.getByTestId('private-unlock')).toHaveCount(0)
  await expect(page.getByTestId('private-chip')).toBeVisible({ timeout: 60_000 })
  // A new tab asks again (the unlock lives in that tab's memory only).
  const other = await context.newPage()
  await other.goto(privateUrl, { waitUntil: 'domcontentloaded' })
  await expectSignedIn(other)
  await expect(other.getByTestId('private-unlock')).toBeVisible({ timeout: 90_000 })
  await shot(other, 'session-p4-new-tab-asks-again')
  await other.close()

  await page.getByRole('button', { name: 'Account menu' }).click()
  await page.getByRole('button', { name: /^lock\b/i }).click()
  await page.goto(privateUrl, { waitUntil: 'domcontentloaded' })
  await expectLocked(page)
  const sealed = page.getByTestId('private-signed-out')
  await expect(sealed).toBeVisible({ timeout: 90_000 })
  await expect(sealed).toContainText('Your session is locked')
  await expect(page.getByText("You're not one")).toHaveCount(0)
  await shot(page, 'session-p4-private-locked')
  await sealed.getByRole('button', { name: /unlock/i }).click()
  await page.getByRole('dialog').getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
  await page.getByRole('button', { name: /^unlock$/i }).click()
  // Unlocked, the owner reads the repo again.
  await expect(page.getByTestId('private-chip')).toBeVisible({ timeout: 120_000 })
})

test('p5. the fixed in-app links navigate without a document load', async () => {
  const page = await context.newPage()
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  // Hydrated (the header's session control is up: signed in, locked, or Sign in).
  const banner = page.getByRole('banner')
  await banner.getByTestId(SESSION_UNLOCK).or(page.getByTestId(FUNDS_PILL)).or(banner.getByRole('button', { name: /^sign in$/i })).first().waitFor({ timeout: 60_000 })
  const documents: string[] = []
  page.on('request', (r) => {
    if (r.resourceType() === 'document') documents.push(r.url())
  })
  const clickTo = async (click: () => Promise<void>, url: RegExp): Promise<void> => {
    await click()
    await page.waitForURL(url, { timeout: 30_000 })
  }
  await clickTo(() => page.getByRole('banner').getByRole('link', { name: /explore/i }).click(), /\/explore\/$/)
  await clickTo(() => page.getByRole('contentinfo').getByRole('link', { name: /^new/i }).click(), /\/new\/$/)
  await clickTo(() => page.getByRole('contentinfo').getByRole('link', { name: /explore/i }).click(), /\/explore\/$/)
  await page.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
  documents.length = 0
  await waitForRepoResolved(page)
  const tabs = page.getByRole('navigation', { name: 'Repository' })
  await clickTo(() => tabs.getByRole('link', { name: /^issues/i }).click(), /\/repo\/issues\/\?/)
  await clickTo(() => tabs.getByRole('link', { name: /^code/i }).click(), /\/repo\/\?/)
  // The account menu's Settings link (was `/settings`, a 301) when signed in.
  if (await page.getByTestId(FUNDS_PILL).isVisible()) {
    await page.getByRole('button', { name: 'Account menu' }).click()
    await clickTo(() => page.getByRole('link', { name: /settings/i }).click(), /\/settings\/$/)
    await clickTo(() => page.getByRole('link', { name: /storage settings/i }).click(), /\/settings\/storage\/$/)
  }
  // Every href on the page that stays in the app carries the trailing slash.
  const slashless = await page.$$eval('a[href^="/"]', (as) =>
    as.map((a) => a.getAttribute('href') ?? '').filter((h) => h !== '/' && !/^\/[^?#]*\/([?#]|$)/.test(h)),
  )
  expect(slashless).toEqual([])
  expect(documents).toEqual([])
  await page.close()
})

test('p6. the 12-hour lock: past it, a page load is locked and nothing is kept', async () => {
  // Last: the clock it installs applies to the whole context, for good.
  const page = await context.newPage()
  await page.goto('/explore/', { waitUntil: 'domcontentloaded' })
  await expectSignedIn(page)
  // The next page load runs 12 h + 1 min later.
  await page.clock.install({ time: Date.now() + 12 * 60 * 60 * 1000 + 60_000 })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expectLocked(page)
  await expect.poll(() => hasKept(page)).toBe(false)
  await shot(page, 'session-p6-expired')
  await page.close()
})
