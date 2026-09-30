import { test, expect, type Page, type Request } from '@playwright/test'
import { collectPageErrors, DAPI_METHOD, DAPI_RESEND_SLACK, decodeDocumentsRequest, E2E_DEVNET, EMPTY, repoUrl, shot, showcaseRepo, waitForRepoResolved } from './helpers'
import { quorumGuardLong } from './quorum-sync'

// Not inside bonsia's quorum-service lag (#212): these specs count requests or read Verification.
test.beforeEach(quorumGuardLong)

/**
 * S-1 (`platform-parity-spec.md`): every page ≤ 25 DAPI requests cold and ≤ 8 warm, counted
 * per request at the network (every kind, the connect included), in a fresh browser context:
 *
 *   E2E_DEVNET=moutai pnpm exec playwright test page-budget.spec.ts
 *
 * - pb-1: the read fixture's cold home, issues list, and a warm file-and-back navigation.
 * - pb-2 (showcase repos): a mirrored repo's cold home. The file list's last-commit column is a
 *   history walk (its own agent is replacing it with a push-time index): its chunk reads are
 *   counted apart and budgeted on their own, so the rest of the home is held to S-1.
 * - pb-4 (the dash mirror, QW2-002): the issue list's every state tab, cold, however many issues
 *   the mirror holds (the PR list's tabs are `pulls-budget.spec.ts` prb-2).
 *
 * The budget covers what the page shows on load, plus the About card's release count and repo
 * size (read once their row scrolls into view, but on this fixture that happens within the fold
 * pb-1 already scrolls for). Further below the fold, the LICENSE and language bar, and the
 * latest release, are read only when scrolled to (skeletons until then): pb-1 checks that
 * scrolling there reads them, separately from the cold count above.
 */

/** S-1's cold page budget. */
const COLD_BUDGET = 25
/** S-1's warm budget: a page of a repo already open in the tab. */
const WARM_BUDGET = 8
/**
 * The read fixture's cold home (measured 8: the chrome composite, counts, locator, objects; then
 * +2 for the About card's release count and repo size, two proved sums read once it is in view).
 */
const DEMO_COLD_HOME = 12
/**
 * The read fixture's issues list, cold (`issues/client.tsx` passes `rail={false}`: no About card,
 * so none of the home's rail sums). 9 reads: measured 8, plus the key cross-check the app shell added. Request by request:
 *   - the contract fetch, the owner's DPNS name, and the repo chrome composite (3);
 *   - the transition counts by kind (1); the issue and PR totals are the chrome composite's own,
 *     seeded for the next count read (`seedTargetCounts`), so they cost nothing here;
 *   - the index's first composite: the issue page with its counts, names, the member `event`
 *     feed and the labels (1). The fixture's feed is 7 events, far from the 100-row page that
 *     would add a continuation, and nothing writes to the read fixture;
 *   - the mirror-source probe, one `author`-index read per trusted author (the fixture's owner
 *     and its one maintainer, 2);
 *   - the page rows' state sums (1);
 *   - the quorum-key cross-check's second source, DAPI's `getCurrentQuorumsInfo` (1). The app
 *     shell runs it on every connected page, rail or not, so a key mismatch heads every page
 *     (QW-004); it runs once per session, so a warm page never repeats it.
 * The header's open-count tabs, the list's total and the index each used to read the three
 * counts themselves (12-13 here); they now share one read (`sharedRepoCounts`). A return of that
 * duplication fails pb-1 by mechanism, not by count: the totals are then read with count requests
 * of their own, which pb-1 allows none of. The counts do not depend on how much the rest of the
 * devnet grows.
 */
const DEMO_COLD_ISSUES = 9 + DAPI_RESEND_SLACK
/**
 * The commit column's walk on a showcase repo: one chunk read per 256 KiB of pack history it
 * crosses (preact 12, dashpay/dash 20). Owned by the last-change index work; tracked, not S-1.
 */
const COLUMN_WALK_MAX = 30

type DapiRequest = { readonly method: string; readonly body: Buffer | null }

/** Requests `page` sends to DAPI from now on, each with its body (decoded where a check needs it). */
function recordDapi(page: Page): { readonly all: () => DapiRequest[] } {
  const seen: DapiRequest[] = []
  page.on('request', (r: Request) => {
    const method = DAPI_METHOD.exec(r.url())?.[1]
    if (method !== undefined) seen.push({ method, body: r.postDataBuffer() })
  })
  return { all: () => seen }
}

const summary = (rows: readonly { method: string }[]): string => {
  const by = new Map<string, number>()
  for (const r of rows) by.set(r.method, (by.get(r.method) ?? 0) + 1)
  return JSON.stringify(Object.fromEntries(by))
}

/** Wait for the page's trailing reads (counts, rail) to go out and settle. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined)
  await page.waitForTimeout(2_500)
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
}

const fileRows = (page: Page) => page.locator('main a[href*="/repo/tree/"], main a[href*="/repo/blob/"]')

test.describe('page request budget (S-1)', () => {
  test('pb-1. the fixture: cold home ≤ budget, the issues list ≤ budget, warm file-and-back ≤ 8', async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    const { errors } = collectPageErrors(page)
    const dapi = recordDapi(page)

    await page.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(fileRows(page).first()).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('section[aria-label=README]')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('commit-count')).toContainText(/\d/, { timeout: 30_000 })
    const about = page.getByRole('complementary', { name: 'About this repository' })
    // The release count and repo size are proved sums read only once their row is scrolled into
    // view (useInView, repo-rail.tsx). Scroll it in now, before the cold snapshot, so those +2
    // reads land in the cold budget below rather than silently never firing.
    await about.getByTestId('repo-releases').scrollIntoViewIfNeeded()
    await expect(about.getByTestId('repo-releases')).toContainText(/\d/, { timeout: 30_000 })
    // Latest release must still be an unread skeleton here, or its reads have already landed in
    // the cold count above rather than the "below the fold, on scroll" one further down — a
    // layout change (a shorter rail, a different fixture, font metrics) could otherwise pull it
    // into view together with the releases row and silently zero out the `scrolled` check below.
    await expect(about.getByTestId('latest-release-skeleton')).toBeVisible()
    await settle(page)
    const cold = dapi.all().length
    test.info().annotations.push({ type: 'dapi', description: `fixture cold home: ${cold} ${summary(dapi.all())}` })
    expect(cold, summary(dapi.all())).toBeLessThanOrEqual(DEMO_COLD_HOME)
    // Nothing the home shows went missing: counts, stars, members, the owner's name.
    await expect(about.getByRole('link', { name: /Stars/ })).toContainText(/\d/)
    await expect(about.getByTestId('rail-members')).toBeVisible()
    await shot(page, 'pb-01-fixture-home-cold')

    // Below the fold: read on scroll, with skeletons until then.
    const release = about.getByRole('region', { name: 'Latest release' })
    await release.scrollIntoViewIfNeeded()
    await expect(release).toContainText(/No releases yet|v\d/, { timeout: 45_000 })
    await settle(page)
    const scrolled = dapi.all().length - cold
    test.info().annotations.push({ type: 'dapi', description: `below the fold, on scroll: ${scrolled}` })
    expect(scrolled, 'the deferred cards read on scroll').toBeGreaterThan(0)
    await shot(page, 'pb-02-fixture-home-scrolled')

    // Warm: a file, then back. The repo is open in the tab: no page re-reads what it has.
    await page.evaluate(() => window.scrollTo(0, 0))
    const beforeWarm = dapi.all().length
    await page.getByRole('link', { name: 'README.md', exact: true }).first().click()
    await expect(page).toHaveURL(/\/repo\/blob\//)
    await expect(page.locator('main').getByText(/forge|README/i).first()).toBeVisible({ timeout: 30_000 })
    await page.goBack()
    await expect(fileRows(page).first()).toBeVisible({ timeout: 30_000 })
    await settle(page)
    const warm = dapi.all().slice(beforeWarm)
    test.info().annotations.push({ type: 'dapi', description: `warm file and back: ${warm.length} ${summary(warm)}` })
    expect(warm.length, summary(warm)).toBeLessThanOrEqual(WARM_BUDGET)
    expect(errors, errors.join('\n')).toEqual([])
    await context.close()

    // The issues list, cold, in a context of its own.
    const issuesContext = await browser.newContext()
    const issues = await issuesContext.newPage()
    const issueDapi = recordDapi(issues)
    await issues.goto(repoUrl('issues'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(issues)
    await expect(issues.locator('main a[href*="/repo/issue/"][href*="number="]').first()).toBeVisible({ timeout: 60_000 })
    await settle(issues)
    const list = issueDapi.all()
    test.info().annotations.push({ type: 'dapi', description: `fixture cold issues: ${list.length} ${summary(list)}` })
    // The issue and PR totals come with the chrome composite (seeded for the one shared counts
    // read): a count request of its own for either means a reader reads them again.
    const totals = list.filter((r) => {
      const q = r.method === 'getDocuments' ? decodeDocumentsRequest(r.body) : null
      return q !== null && q.count && (q.documentType === 'issue' || q.documentType === 'patch')
    })
    expect(totals.length, 'the issue and PR totals are not read again').toBe(0)
    expect(list.length, summary(list)).toBeLessThanOrEqual(DEMO_COLD_ISSUES)
    await shot(issues, 'pb-03-fixture-issues-cold')
    await issuesContext.close()
  })

  test('pb-3. the About card shows no placeholder where no facts are worked out: a deep link to a file, the empty repo', async ({ page }) => {
    // A deep link to a file: the rail is there, but only the home works the facts out.
    await page.goto(repoUrl('blob', '&path=README.md'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    const about = page.getByRole('region', { name: 'About' })
    await about.scrollIntoViewIfNeeded({ timeout: 60_000 })
    await expect(page.locator('main').getByText(/forge|README/i).first()).toBeVisible({ timeout: 60_000 })
    await page.waitForTimeout(3_000)
    await expect(page.getByTestId('facts-skeleton')).toHaveCount(0)
    await shot(page, 'pb-05-blob-deep-link-rail')

    // The empty repo: no tip, nothing to work out.
    await page.goto(repoUrl('', '', EMPTY), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(page.getByRole('region', { name: 'Empty repository' })).toBeVisible({ timeout: 60_000 })
    await page.getByRole('region', { name: 'About' }).scrollIntoViewIfNeeded()
    await page.waitForTimeout(3_000)
    await expect(page.getByTestId('facts-skeleton')).toHaveCount(0)
    await shot(page, 'pb-06-empty-repo-rail')
  })

  test.describe('showcase repos', () => {
    test.skip(E2E_DEVNET !== 'moutai', 'the showcase repos are imported on moutai')

    test('pb-2. a mirrored repo, cold: the home ≤ 25 besides the commit column walk', async ({ browser }) => {
      const repo = await showcaseRepo('PREACTJS', 'preact')
      const context = await browser.newContext()
      const page = await context.newPage()
      const dapi = recordDapi(page)
      await page.goto(repoUrl('', '', repo), { waitUntil: 'domcontentloaded' })
      await waitForRepoResolved(page)
      await expect(fileRows(page).first()).toBeVisible({ timeout: 60_000 })
      await expect(page.getByTestId('commit-cell-pending').filter({ hasText: '…' })).toHaveCount(0, { timeout: 60_000 })
      await settle(page)
      const all = dapi.all()
      // The column walk's reads: chunk reads of the git pack whose seq window is 18-19 chunks (one
      // 256 KiB read-ahead block). The locator, root tree and README are read as other shapes.
      const columnish = all.filter((r) => r.method === 'getDocuments' && blockSized(r.body))
      const rest = all.length - columnish.length
      test.info().annotations.push({
        type: 'dapi',
        description: `preact cold home: ${all.length} in all, ${columnish.length} read-ahead blocks (commit walks), ${rest} the rest ${summary(all)}`,
      })
      expect(rest, summary(all)).toBeLessThanOrEqual(COLD_BUDGET)
      expect(columnish.length).toBeLessThanOrEqual(COLUMN_WALK_MAX)
      await shot(page, 'pb-04-preact-home-cold')
      await context.close()
    })
  })
})

/**
 * The issue list on a large repo (QW2-002), on the dash mirror: every state tab, cold, within
 * S-1. The list used to read every issue whose tab was not full (the Open tab's 10 of 320 issues:
 * all four chunks) and the Closed tab every close transition before its first row; it now reads
 * the newest chunks until the page is full or the tab's proved count is reached, at most three
 * per load, and a row's labels from its own events. The page-count indicator is the proved count.
 *
 * Run where the dash mirror is: bonsia, or elsewhere with its owner in `E2E_SHOWCASE_DASHPAY`.
 */
test.describe('list budgets on the dash mirror (QW2-002)', () => {
  test.describe.configure({ timeout: 240_000 })

  test('pb-4. the dash issue list, every state tab, cold, ≤ 25', async ({ browser }) => {
    const dash = await showcaseRepo('DASHPAY', 'dash').catch(() => null)
    test.skip(dash === null, `the dash mirror is not imported on ${E2E_DEVNET}`)
    if (dash === null) return
    for (const state of ['open', 'closed', 'all'] as const) {
      const context = await browser.newContext()
      const page = await context.newPage()
      const { errors } = collectPageErrors(page)
      const dapi = recordDapi(page)
      await page.goto(repoUrl('issues', state === 'open' ? '' : `&state=${state}`, dash), { waitUntil: 'domcontentloaded' })
      await waitForRepoResolved(page)
      await expect(page.locator('main a[href*="/repo/issue/"][href*="number="]').first()).toBeVisible({ timeout: 90_000 })
      await settle(page)
      const all = dapi.all()
      test.info().annotations.push({ type: 'dapi', description: `dash issues ${state}, cold: ${all.length} ${summary(all)}` })
      expect(errors, errors.join('\n')).toEqual([])
      expect(all.length, summary(all)).toBeLessThanOrEqual(COLD_BUDGET)
      await shot(page, `pb-07-dash-issues-${state}-cold`)
      await context.close()
    }
  })
})

/**
 * Code browsing on a large repo (QW-027, QW-028, QW-087), on the dash mirror: request and time
 * budgets for what used to take tens of seconds. Measured on bonsia (2026-09-30), and the budgets
 * are about twice that, so a slow devnet node passes and a return of the old serial reads fails:
 *
 * - the cold home's ref timeline (~700 updates): 8 key ranges in one round trip, where six
 *   `$createdAt` pages went one after the other (1.0–1.4 s before anything else could start);
 * - Go to file: first results from the history index with no read (measured 8 ms after typing,
 *   was 14.5 s), the exact walk after it in ~1.9 s and 17 requests (was 100–120, one at a time);
 * - the language bar: ~2.4 s and 19 requests once the About card is in view (was 12.8 s);
 * - compare v22.0.0...v23.0.0: listed in ~16 s and 74 requests (was 19–21 s and 257), its 1,530
 *   files (git's own count, renames paired) counted in ~14 s and 42 requests, complete (was 176 s,
 *   1,287 requests and still partial).
 *
 * Run where the dash mirror is: `E2E_DEVNET=moutai`, or elsewhere with its owner in
 * `E2E_SHOWCASE_DASHPAY` (on bonsia: 7A1MEuLjzcHZq8bLBzGYSUkpb2VM9dv7gtNuNYrPxKt3).
 */
/** `CHROME_KEYSET_SPLITS` (lib/repo/refs.ts): the key ranges the chrome reads a long ref timeline as. */
const DASH_HOME_REF_READS_MAX = 8 + DAPI_RESEND_SLACK
/** The ranges go out together: from the first to the last, well under one round trip's worth. */
const DASH_HOME_REF_SPREAD_MS = 600
const GOTO_FIRST_RESULTS_MS = 1_000
const GOTO_WALK_MS = 10_000
const GOTO_WALK_REQUESTS = 40
const LANGUAGES_MS = 10_000
const LANGUAGES_REQUESTS = 40
const COMPARE_LISTED_MS = 40_000
const COMPARE_LISTED_REQUESTS = 150
const COMPARE_COUNT_MS = 40_000
const COMPARE_COUNT_REQUESTS = 90

test.describe('code browsing budgets on the dash mirror (QW-027, QW-028, QW-087)', () => {
  test.skip(E2E_DEVNET !== 'moutai' && !process.env['E2E_SHOWCASE_DASHPAY'], 'the dash mirror is imported on moutai (elsewhere, set E2E_SHOWCASE_DASHPAY)')
  test.describe.configure({ timeout: 240_000 })

  test('cb-1. the cold home reads its ref timeline in one round trip; Go to file and the language bar answer in seconds', async ({ browser }) => {
    const dash = await showcaseRepo('DASHPAY', 'dash')
    const context = await browser.newContext()
    const page = await context.newPage()
    const refReads: number[] = []
    page.on('request', (r) => {
      if (DAPI_METHOD.exec(r.url())?.[1] !== 'getDocuments') return
      if (decodeDocumentsRequest(r.postDataBuffer())?.documentType === 'refUpdate') refReads.push(Date.now())
    })
    const dapi = recordDapi(page)
    await page.goto(repoUrl('', '', dash), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(fileRows(page).first()).toBeVisible({ timeout: 60_000 })
    const spread = refReads.length === 0 ? 0 : Math.max(...refReads) - Math.min(...refReads)
    test.info().annotations.push({ type: 'dapi', description: `dash cold home: ${refReads.length} refUpdate reads over ${spread} ms` })
    expect(refReads.length).toBeLessThanOrEqual(DASH_HOME_REF_READS_MAX)
    expect(spread, 'the ref ranges go out side by side').toBeLessThanOrEqual(DASH_HOME_REF_SPREAD_MS)
    await expect(page.getByTestId('commit-count')).toContainText(/\d/, { timeout: 60_000 })
    await settle(page)

    // Go to file: `t` focuses it; results from the history index at once, fuzzy and ranked.
    await page.locator('main').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('t')
    const box = page.getByTestId('go-to-file')
    await expect(box).toBeFocused()
    const beforeGoto = dapi.all().length
    const typed = Date.now()
    await box.fill('validation.cpp')
    await expect(page.getByTestId('go-to-file-result').first()).toHaveText('src/validation.cpp', { timeout: GOTO_FIRST_RESULTS_MS })
    await box.fill('netproc')
    await expect(page.getByTestId('go-to-file-result').first()).toContainText('net_processing')
    await expect(page.getByText('Listing files')).toHaveCount(0, { timeout: GOTO_WALK_MS })
    await settle(page)
    const walk = dapi.all().length - beforeGoto
    test.info().annotations.push({ type: 'dapi', description: `Go to file: walk done in ${Date.now() - typed} ms (settled), ${walk} requests` })
    expect(walk).toBeLessThanOrEqual(GOTO_WALK_REQUESTS)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/repo\/blob\/.*net_processing/)
    await shot(page, 'cb-01-goto-file-enter')
    await context.close()

    // The language bar, in a fresh context (its walk not shared with Go to file's).
    const fresh = await browser.newContext()
    const lang = await fresh.newPage()
    const langDapi = recordDapi(lang)
    await lang.goto(repoUrl('', '', dash), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(lang)
    await expect(fileRows(lang).first()).toBeVisible({ timeout: 60_000 })
    await expect(lang.getByTestId('commit-count')).toContainText(/\d/, { timeout: 60_000 })
    await settle(lang)
    const beforeLang = langDapi.all().length
    const scrolled = Date.now()
    const bar = lang.getByTestId('language-bar')
    for (let y = 0; y < 4_000 && !(await bar.isVisible()); y += 400) {
      await lang.evaluate((top) => window.scrollTo(0, top), y)
      await lang.waitForTimeout(150)
    }
    await expect(bar.getByRole('img')).toBeVisible({ timeout: LANGUAGES_MS })
    const langMs = Date.now() - scrolled
    await settle(lang)
    const langReads = langDapi.all().length - beforeLang
    test.info().annotations.push({ type: 'dapi', description: `language bar: ${langMs} ms, ${langReads} requests` })
    expect(langReads).toBeLessThanOrEqual(LANGUAGES_REQUESTS)
    await shot(lang, 'cb-02-language-bar')
    await fresh.close()
  })

  test('cb-2. compare v22.0.0...v23.0.0: listed, then every line counted, within budget', async ({ browser }) => {
    const dash = await showcaseRepo('DASHPAY', 'dash')
    const context = await browser.newContext()
    const page = await context.newPage()
    const dapi = recordDapi(page)
    const opened = Date.now()
    await page.goto(repoUrl('compare', '&base=v22.0.0&head=v23.0.0', dash), { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('compare-summary')).toContainText('1,530 files changed', { timeout: COMPARE_LISTED_MS })
    const listed = dapi.all().length
    test.info().annotations.push({ type: 'dapi', description: `compare listed: ${Date.now() - opened} ms, ${listed} requests` })
    expect(listed).toBeLessThanOrEqual(COMPARE_LISTED_REQUESTS)
    const counting = Date.now()
    await page.getByTestId('count-lines').click()
    await expect(page.getByTestId('diff-totals')).toBeVisible({ timeout: COMPARE_COUNT_MS })
    const counted = dapi.all().length - listed
    test.info().annotations.push({ type: 'dapi', description: `compare counted: ${Date.now() - counting} ms, ${counted} requests` })
    // git diff -M --shortstat v22.0.0...v23.0.0, and nothing left out.
    await expect(page.getByTestId('diff-totals')).toContainText('+112,310 −69,084')
    await expect(page.getByTestId('diff-totals-partial')).toHaveCount(0)
    expect(counted).toBeLessThanOrEqual(COMPARE_COUNT_REQUESTS)
    await shot(page, 'cb-03-compare-counted')
    await context.close()
  })
})

/**
 * Whether a request is one read-ahead block of a history walk: a `chunk` read of 17-19 seqs
 * (256 KiB / 14,700 B per chunk). The locator is read 100 seqs at a time, an object alone 1-2.
 */
function blockSized(body: Buffer | null): boolean {
  const q = decodeDocumentsRequest(body)
  if (q?.documentType !== 'chunk') return false
  const seqs = q.where.find((w) => w.field === 'seq')?.inCount ?? 0
  return seqs >= 17 && seqs <= 19
}
