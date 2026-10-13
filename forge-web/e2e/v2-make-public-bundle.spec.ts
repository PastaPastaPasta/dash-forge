/**
 * A maintainer makes other people's members-only posts public with a make-public bundle (DESIGN
 * §4.6, §10; stream 2B), against a scratch repo seeded on the devnet with `dg … --members`. It
 * writes, so it runs only when pointed at that repo:
 *
 * - a maintainer makes another member's comment public (one post), then a whole members-only
 *   thread with "Also publish earlier edits"; nothing is broadcast while a dialog is open;
 * - a logged-out visitor (desktop and phone) reads both, "Made public by" on each post and the
 *   issue's earlier versions under it; a post nobody published stays a placeholder;
 * - a writer's bundle (E2E_MPB_WRITER_MARKER) is ignored, and a maintainer's entry whose key does
 *   not match its post (E2E_MPB_LYING_MARKER) is ignored and said once on the page
 *   (`lib/repo/made-public.live.test.ts` writes both first);
 * - the author whose words went public sees it in their inbox, and an edit of their post is
 *   public now.
 *
 * The repo (E2E_MPB_OWNER / E2E_MPB_NAME): a public issue E2E_MPB_ISSUE holding the reader's
 * members-only comments E2E_MPB_MARKER (made public here), E2E_MPB_KEEP_MARKER (never), and the
 * writer- and lying-bundle targets; a members-only issue E2E_MPB_THREAD by the writer edited twice
 * (titles E2E_MPB_THREAD_V1, _V2, _V3), with members-only replies by the reader and the maintainer.
 * Identities (E2E_IDENTITY_DIR): E2E_MPB_MAINTAINER (default `maint`), E2E_MPB_READER (`bob`, the
 * reader whose comment is made public) and E2E_MPB_WRITER (`alice`, the thread's author), each file
 * with its encryption key.
 *
 *   E2E_MPB_OWNER=… E2E_MPB_NAME=… E2E_MPB_ISSUE=1 E2E_MPB_THREAD=2 E2E_MPB_MARKER=… \
 *   E2E_MPB_KEEP_MARKER=… E2E_MPB_WRITER_MARKER=… E2E_MPB_LYING_MARKER=… E2E_MPB_THREAD_V1=… \
 *   E2E_MPB_THREAD_V2=… E2E_MPB_THREAD_V3=… E2E_IDENTITY_DIR=… \
 *   pnpm exec playwright test v2-make-public-bundle.spec.ts
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { devices, expect, test, type Browser, type Locator, type Page } from '@playwright/test'
import { DAPI_METHOD, PASSPHRASE, idFile, runAxe, stateFile, unlock, waitForRepoResolved } from './helpers'

const env = (k: string, d = ''): string => process.env[k] ?? d
const OWNER = env('E2E_MPB_OWNER')
const NAME = env('E2E_MPB_NAME')
const ISSUE = env('E2E_MPB_ISSUE')
const THREAD = env('E2E_MPB_THREAD')
const MARKER = env('E2E_MPB_MARKER')
const KEEP = env('E2E_MPB_KEEP_MARKER')
const WRITER_MARKER = env('E2E_MPB_WRITER_MARKER')
const LYING_MARKER = env('E2E_MPB_LYING_MARKER')
const [V1, V2, V3] = [env('E2E_MPB_THREAD_V1'), env('E2E_MPB_THREAD_V2'), env('E2E_MPB_THREAD_V3')]
const MAINTAINER = env('E2E_MPB_MAINTAINER', 'maint')
const READER = env('E2E_MPB_READER', 'bob')
const WRITER = env('E2E_MPB_WRITER', 'alice')
const SHOTS = env('E2E_MPB_SHOTS', join(__dirname, 'test-results', 'make-public-bundle'))

test.describe.configure({ mode: 'serial', timeout: 480_000 })
test.skip(
  [OWNER, NAME, ISSUE, THREAD, MARKER, KEEP, WRITER_MARKER, LYING_MARKER, V1, V2, V3].some((v) => v === ''),
  'needs the bundle scratch repo: E2E_MPB_OWNER, _NAME, _ISSUE, _THREAD, _MARKER, _KEEP_MARKER, _WRITER_MARKER, _LYING_MARKER, _THREAD_V1.._V3',
)
test.skip(![MAINTAINER, READER, WRITER].every((n) => existsSync(idFile(n))), `needs the ${MAINTAINER}, ${READER} and ${WRITER} identity files (E2E_IDENTITY_DIR)`)

const url = (n: string): string => `/repo/issue/?owner=${OWNER}&name=${NAME}&number=${n}`

/** A context signed in as `name`, its identity file's encryption key in this browser. */
async function signedInAs(browser: Browser, name: string): Promise<Page> {
  const saved = stateFile(name)
  const context = await browser.newContext(existsSync(saved) ? { storageState: saved } : {})
  const page = await context.newPage()
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  if (existsSync(saved)) {
    await unlock(page)
  } else {
    await page.getByRole('banner').getByRole('button', { name: /^sign in$/i }).first().click()
    await page.getByTestId('tile-import').click()
    await page.setInputFiles('input[type="file"]', idFile(name))
    await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
    await page.getByLabel('Repeat passphrase').fill(PASSPHRASE)
    await page.getByTestId('enable-private-repos').check()
    await page.getByRole('button', { name: /create this browser's key/i }).click()
    await expect(page.getByTestId('funds-pill')).toBeVisible({ timeout: 120_000 })
    mkdirSync(join(__dirname, '.playwright', 'auth'), { recursive: true, mode: 0o700 })
    await context.storageState({ path: saved, indexedDB: true })
  }
  return page
}

/**
 * Open a thread and, for a member whose tab holds the key locked, unlock it inline: an offer on a
 * public thread, or the form a members-only issue shows in place of its text.
 */
async function openThread(page: Page, path: string, readable: string): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page, 120_000)
  const offer = page.getByTestId('members-only-unlock')
  const form = page.getByRole('main').getByLabel('Passphrase')
  const text = page.getByText(readable).first()
  await expect(offer.or(form).or(text).first()).toBeVisible({ timeout: 120_000 })
  if (await offer.isVisible()) {
    await offer.click()
    const panel = page.getByTestId('members-only-unlock-panel')
    await panel.getByLabel('Passphrase').fill(PASSPHRASE)
    await panel.getByRole('button', { name: /^unlock$/i }).click()
  } else if (await form.isVisible()) {
    await form.fill(PASSPHRASE)
    await page.getByRole('main').getByRole('button', { name: /^unlock$/i }).click()
  }
  await expect(text).toBeVisible({ timeout: 120_000 })
}

/** Count broadcasts the page sends from now on. */
function broadcasts(page: Page): string[] {
  const out: string[] = []
  page.on('request', (r) => {
    const m = DAPI_METHOD.exec(r.url())
    if (m && /broadcast/i.test(m[1] ?? '')) out.push(m[1] ?? '')
  })
  return out
}

/** Confirm a make-public dialog: "Make public", or "Make public anyway" after a quote warning. */
async function confirm(dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: /^Make public( anyway)?$/ }).click()
}

async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  await page.waitForTimeout(500) // a dialog's open animation
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage })
}

test("maintainer: makes a reader's members-only comment public", async ({ browser }) => {
  const page = await signedInAs(browser, MAINTAINER)
  await openThread(page, url(ISSUE), MARKER)
  const card = page.getByTestId('timeline-comment').filter({ hasText: MARKER })
  // A rerun against the same repo finds it public already (a bundle can't be undone).
  if ((await card.getAttribute('data-audience')) === 'members') {
    const sent = broadcasts(page)
    await card.getByTestId('make-others-public').click()
    const dialog = page.getByRole('dialog', { name: 'Make 1 post public?' })
    await expect(dialog).toContainText(/Words by \S+ become public\. They'll be notified\..*This can't be undone\./, { timeout: 120_000 })
    await shot(page, 'maintainer-comment-dialog')
    expect(sent).toEqual([])
    // the quote check may warn (the reader's comments share words): the button then says so
    await confirm(dialog)
  }
  const after = page.getByTestId('timeline-comment').filter({ hasText: MARKER })
  await expect(after).toHaveAttribute('data-audience', 'public', { timeout: 240_000 })
  await expect(after.getByTestId('made-public-by')).toBeVisible()
  await shot(page, 'maintainer-comment-after', true)
  await page.context().close()
})

test('maintainer: makes a whole members-only thread public, with its earlier edits', async ({ browser }) => {
  const page = await signedInAs(browser, MAINTAINER)
  await openThread(page, url(THREAD), V3)
  const sent = broadcasts(page)
  await page.getByTestId('make-thread-public').click()
  // the issue, the reader's reply and the maintainer's own, in one bundle
  const dialog = page.getByRole('dialog', { name: 'Make 3 posts public?' })
  await expect(dialog).toContainText(/Words by .+ become public\. They'll be notified\./, { timeout: 120_000 })
  const earlier = dialog.getByTestId('publish-earlier-edits')
  await expect(earlier).toContainText('Also publish earlier edits (2)')
  await earlier.getByRole('checkbox').check()
  await shot(page, 'maintainer-thread-dialog')
  expect(sent).toEqual([])
  await confirm(dialog)
  await expect(page.getByTestId('made-public-by').first()).toBeVisible({ timeout: 240_000 })
  await shot(page, 'maintainer-thread-after', true)
  await page.context().close()
})

/** What a logged-out visitor reads of the scratch repo (desktop or phone). */
async function anonReads(page: Page, label: string): Promise<void> {
  await page.goto(url(ISSUE), { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page, 120_000)
  const card = page.getByTestId('timeline-comment').filter({ hasText: MARKER })
  await expect(card).toBeVisible({ timeout: 240_000 })
  await expect(card).toHaveAttribute('data-audience', 'public')
  await expect(card.getByTestId('made-public-by')).toBeVisible()
  // the lying entry is said once; neither bundle that should not count opened its post
  await expect(page.getByTestId('bundle-alerts')).toContainText("make-public entry for a post by", { timeout: 120_000 })
  const html = await page.content()
  for (const hidden of [KEEP, WRITER_MARKER, LYING_MARKER]) expect(html).not.toContain(hidden)
  await shot(page, `anon-${label}-issue`, true)
  if (label === 'desktop') expect(await runAxe(page, 'issue with a comment a maintainer made public (anon)')).toEqual([])

  await page.goto(url(THREAD), { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page, 120_000)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(V3, { timeout: 240_000 })
  await expect(page.getByTestId('made-public-by').first()).toBeVisible()
  await expect(page.getByTestId('members-only-placeholder')).toHaveCount(0)
  const versions = page.getByTestId('earlier-versions')
  await expect(versions).toContainText('Earlier versions made public (2)')
  await versions.locator('summary').click()
  await expect(versions.getByTestId('earlier-version')).toHaveCount(2)
  await expect(versions).toContainText(V1)
  await expect(versions).toContainText(V2)
  await shot(page, `anon-${label}-thread`, true)
  if (label === 'desktop') expect(await runAxe(page, 'a thread a maintainer made public (anon)')).toEqual([])
}

test('anon: reads the comment and the thread made public; ignored bundles stay ignored', async ({ page }) => {
  await anonReads(page, 'desktop')
})

test('anon on a phone: the same', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['iPhone 13'] })
  const page = await context.newPage()
  await anonReads(page, 'phone')
  await context.close()
})

test("reader: their inbox says a maintainer made their comment public, and an edit of it is public", async ({ browser }) => {
  const page = await signedInAs(browser, READER)
  await page.goto('/notifications/', { waitUntil: 'domcontentloaded' })
  const item = page.getByText(/made (your comment|\d+ of your posts) public/).first()
  const refresh = page.getByRole('button', { name: /refresh|check now/i }).first()
  for (let i = 0; i < 6 && !(await item.isVisible()); i++) {
    if (await refresh.isVisible()) await refresh.click()
    await page.waitForTimeout(10_000)
  }
  await expect(item).toBeVisible({ timeout: 120_000 })
  await shot(page, 'reader-inbox')

  await openThread(page, url(ISSUE), MARKER)
  const card = page.getByTestId('timeline-comment').filter({ hasText: MARKER })
  await card.getByRole('button', { name: /^edit$/i }).first().click()
  await expect(page.getByTestId('public-edit-hint')).toContainText('made this public, so your edit is public too.')
  await shot(page, 'reader-edit-hint')
  await page.context().close()
})

test("writer (the thread's author): not a maintainer, so no thread action", async ({ browser }) => {
  const page = await signedInAs(browser, WRITER)
  await openThread(page, url(ISSUE), MARKER)
  // someone else's members-only post: the writer is told to ask a maintainer, nothing is read
  const kept = page.getByTestId('timeline-comment').filter({ has: page.getByTestId('make-others-public') }).first()
  if ((await kept.count()) > 0) {
    await kept.getByTestId('make-others-public').click()
    await expect(page.getByRole('dialog')).toContainText("Only maintainers can make other people's posts public. Ask a maintainer.")
    await shot(page, 'writer-ask-a-maintainer')
  }
  await page.goto(url(THREAD), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1 })).toContainText(V3, { timeout: 240_000 })
  await expect(page.getByTestId('make-thread-public')).toHaveCount(0)
  await page.context().close()
})
