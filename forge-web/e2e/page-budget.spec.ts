import { test, expect, type Page, type Request } from '@playwright/test'
import { collectPageErrors, DAPI_METHOD, DAPI_RESEND_SLACK, decodeDocumentsRequest, DEMO, E2E_DEVNET, EMPTY, repoUrl, shot, showcaseRepo, waitForRepoResolved } from './helpers'
import { quorumGuardLong } from './quorum-sync'
import { loadSeedPulls } from './seed-summary'

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
/** A profile page, cold (pb-5): measured 9 on sakura, P1-7's profile document included. */
const PROFILE_COLD = 10 + DAPI_RESEND_SLACK
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

  test('pb-3. a deep link to a file has no rail; the empty repo\'s About card shows no placeholder', async ({ page }) => {
    // A deep link to a file: no rail (the code gets the width), so no About card and no facts to
    // work out; the Verification card leads the page instead.
    await page.goto(repoUrl('blob', '&path=README.md'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(page.locator('main').getByText(/forge|README/i).first()).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('verification-card')).toBeVisible({ timeout: 60_000 })
    await page.waitForTimeout(3_000)
    await expect(page.getByRole('region', { name: 'About' })).toHaveCount(0)
    await expect(page.getByTestId('facts-skeleton')).toHaveCount(0)
    await shot(page, 'pb-05-blob-deep-link-no-rail')

    // The empty repo: no tip, nothing to work out.
    await page.goto(repoUrl('', '', EMPTY), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(page.getByRole('region', { name: 'Empty repository' })).toBeVisible({ timeout: 60_000 })
    await page.getByRole('region', { name: 'About' }).scrollIntoViewIfNeeded()
    await page.waitForTimeout(3_000)
    await expect(page.getByTestId('facts-skeleton')).toHaveCount(0)
    await shot(page, 'pb-06-empty-repo-rail')
  })

  /**
   * P1-7: a profile, cold, by `?id=` (D-222). Measured on sakura (2026-10-02): 9 requests (the
   * contracts, the quorum cross-check, and 7 documents: DPNS, owned repos, member repos, the
   * two follow counts and the `profile` document, which is the one P1-7 adds).
   */
  test('pb-5. a profile by ?id=, cold, ≤ budget, with its profile document read once', async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    const { errors } = collectPageErrors(page)
    const dapi = recordDapi(page)
    await page.goto(`/u/?id=${DEMO.owner}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible({ timeout: 90_000 })
    await expect(page.getByTestId('profile-card')).toBeVisible()
    await settle(page)
    const all = dapi.all()
    test.info().annotations.push({ type: 'dapi', description: `profile cold: ${all.length} ${summary(all)}` })
    const profileReads = all.filter((r) => r.method === 'getDocuments' && decodeDocumentsRequest(r.body)?.documentType === 'profile')
    expect(profileReads.length, 'the profile document is read once').toBe(1)
    expect(all.length, summary(all)).toBeLessThanOrEqual(PROFILE_COLD)
    expect(errors, errors.join('\n')).toEqual([])
    await shot(page, 'pb-07-profile-cold')
    await context.close()
  })

  /**
   * A branch's Activity page (E5): its history comes from the repo chrome timelines the page
   * reads anyway, and the force-push check walks the browse reader, bounded per move.
   */
  test('pb-7. a branch Activity page, cold, ≤ budget', async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    const { errors } = collectPageErrors(page)
    const dapi = recordDapi(page)
    await page.goto(repoUrl('activity', '&branch=main'), { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('ref-activity')).toBeVisible({ timeout: 90_000 })
    await settle(page)
    const all = dapi.all()
    test.info().annotations.push({ type: 'dapi', description: `activity of main: ${all.length} ${summary(all)}` })
    expect(all.length, summary(all)).toBeLessThanOrEqual(COLD_BUDGET)
    expect(errors, errors.join('\n')).toEqual([])
    await shot(page, 'pb-08-activity-cold')
    await context.close()
  })

  /**
   * Bot badges (UPDATE-1 `profile.bot`): a thread reads its participants' profiles in one batch
   * once its data is in (one `$ownerId in` query, and one more for the operators any of them
   * name), never once per author or per render wave.
   */
  test('pb-6. an issue thread and a PR conversation read the bot badges in at most 2 profile queries', async ({ browser }) => {
    const merged = loadSeedPulls().merged
    for (const [label, url, ready] of [
      ['issue #3', repoUrl('issue', '&number=3'), (p: Page) => p.getByText('Done in docs/rules.md; closing.')],
      [`PR #${merged}`, repoUrl('pull', `&number=${merged}`), (p: Page) => p.locator('main h1').first()],
    ] as const) {
      const context = await browser.newContext()
      const page = await context.newPage()
      const { errors } = collectPageErrors(page)
      const dapi = recordDapi(page)
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await expect(ready(page)).toBeVisible({ timeout: 90_000 })
      await settle(page)
      const all = dapi.all()
      const profileReads = all.filter((r) => r.method === 'getDocuments' && decodeDocumentsRequest(r.body)?.documentType === 'profile')
      test.info().annotations.push({ type: 'dapi', description: `${label}: ${all.length} ${summary(all)}; profile reads ${profileReads.length}` })
      expect(profileReads.length, `${label}: the bot badges' profile reads`).toBeLessThanOrEqual(2)
      expect(all.length, summary(all)).toBeLessThanOrEqual(COLD_BUDGET)
      expect(errors, errors.join('\n')).toEqual([])
      await context.close()
    }
  })

  /**
   * P1-7, signed-commit badges: the signers (memberships and one `profile` query) are read only
   * once a page shows a signed commit. The fixture's commits are unsigned, so its commits list
   * queries no profile at all.
   */
  test('sg-1. an unsigned history reads no signing keys', async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    const dapi = recordDapi(page)
    await page.goto(repoUrl('commits'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(page.locator('main a[href*="/repo/commit/"]').first()).toBeVisible({ timeout: 90_000 })
    await settle(page)
    const profiles = dapi.all().filter((r) => r.method === 'getDocuments' && decodeDocumentsRequest(r.body)?.documentType === 'profile')
    expect(profiles.length, summary(dapi.all())).toBe(0)
    await expect(page.getByTestId('signature-badge')).toHaveCount(0)
    await context.close()
  })

  /**
   * A history of signed commits (set `E2E_SIGNED_REPO=<owner>/<name>`: on sakura, the P1-7 QA
   * repo `J9AeWAQUx5JKWBbZ3oiB82di8DmhoswkwfoYJL8eJwJ6/p17-signed`, six commits signed every way).
   * Measured on sakura (2026-10-02): the commits list 12 requests cold with every badge, a commit
   * page 9; the signers add the two membership reads (shared with the checks) and one `profile`.
   */
  test('sg-2. signed commits: badges within S-1, the signers read once', async ({ browser }) => {
    const signed = process.env['E2E_SIGNED_REPO']
    test.skip(signed === undefined, 'set E2E_SIGNED_REPO=<owner>/<name> to a repository with signed commits')
    const [owner, name] = (signed as string).split('/') as [string, string]
    for (const path of ['commits']) {
      const context = await browser.newContext()
      const page = await context.newPage()
      const dapi = recordDapi(page)
      await page.goto(repoUrl(path, '', { owner, name }), { waitUntil: 'domcontentloaded' })
      await expect(page.getByTestId('signature-badge').first()).toBeVisible({ timeout: 120_000 })
      await expect(page.getByTestId('signature-checking')).toHaveCount(0, { timeout: 60_000 })
      await settle(page)
      const all = dapi.all()
      test.info().annotations.push({ type: 'dapi', description: `signed ${path}, cold: ${all.length} ${summary(all)}` })
      const profiles = all.filter((r) => r.method === 'getDocuments' && decodeDocumentsRequest(r.body)?.documentType === 'profile')
      expect(profiles.length, 'the signers are read once').toBe(1)
      expect(all.length, summary(all)).toBeLessThanOrEqual(COLD_BUDGET)
      await shot(page, `sg-02-${path}-badges`)
      await context.close()
    }
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
 * The browse index on a large repo (QW3-001), on the dash mirror: a cold code page reads the
 * chunks of its index that hold the rows of the objects it shows, not the whole index. dash's is
 * 9.65 MB in 657 chunk documents; every cold home, tree, file or log page read all of them before
 * its first row (80-160 s on a slow devnet). Measured on bonsia (2026-09-30): the home 13 chunk
 * documents in all, the branch list 42 (most of them its tips' commits). The budgets are a few
 * times that, so a resent query passes and a return of the whole-index read (657 and up) fails.
 *
 * Run where the dash mirror is: sakura (once it is imported there), or elsewhere with its owner in `E2E_SHOWCASE_DASHPAY`.
 */
const DASH_HOME_CHUNK_DOCS = 60
const DASH_BRANCHES_CHUNK_DOCS = 120

/** Chunk documents `page` asks DAPI for from now on (resends included), by summing the `seq in` lists. */
function recordChunkDocs(page: Page): () => number {
  let docs = 0
  page.on('request', (r: Request) => {
    if (DAPI_METHOD.exec(r.url())?.[1] !== 'getDocuments') return
    const q = decodeDocumentsRequest(r.postDataBuffer())
    if (q?.documentType === 'chunk') docs += q.where.find((w) => w.field === 'seq')?.inCount ?? 0
  })
  return () => docs
}

test.describe('the browse index on the dash mirror (QW3-001)', () => {
  test.describe.configure({ timeout: 240_000 })

  test('bi-1. a cold home and branch list read a sliver of the 657-chunk index', async ({ browser }) => {
    const dash = await showcaseRepo('DASHPAY', 'dash').catch(() => null)
    test.skip(dash === null, `the dash mirror is not imported on ${E2E_DEVNET}`)
    if (dash === null) return

    const context = await browser.newContext()
    const page = await context.newPage()
    const { errors } = collectPageErrors(page)
    const chunkDocs = recordChunkDocs(page)
    const dapi = recordDapi(page)
    await page.goto(repoUrl('', '', dash), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(fileRows(page).first()).toBeVisible({ timeout: 90_000 })
    await expect(page.locator('section[aria-label=README]')).toBeVisible({ timeout: 90_000 })
    await settle(page)
    test.info().annotations.push({ type: 'dapi', description: `dash cold home: ${chunkDocs()} chunk documents, ${dapi.all().length} requests ${summary(dapi.all())}` })
    expect(errors, errors.join('\n')).toEqual([])
    expect(chunkDocs()).toBeLessThanOrEqual(DASH_HOME_CHUNK_DOCS)
    await shot(page, 'bi-01-dash-home-cold')
    await context.close()

    // The branch list: every row's tip commit date, the index rows for them read side by side.
    const fresh = await browser.newContext()
    const list = await fresh.newPage()
    const listDocs = recordChunkDocs(list)
    await list.goto(repoUrl('branches', '', dash), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(list)
    await expect(list.locator('[data-testid=ref-updated][data-source=commit]').first()).toBeVisible({ timeout: 90_000 })
    await settle(list)
    test.info().annotations.push({ type: 'dapi', description: `dash cold branch list: ${listDocs()} chunk documents` })
    expect(listDocs()).toBeLessThanOrEqual(DASH_BRANCHES_CHUNK_DOCS)
    await shot(list, 'bi-02-dash-branches-cold')
    await fresh.close()
  })
})

/**
 * The issue list on a large repo (QW2-002), on the dash mirror: every state tab, cold, within
 * S-1. The list used to read every issue whose tab was not full (the Open tab's 10 of 320 issues:
 * all four chunks) and the Closed tab every close transition before its first row; it now reads
 * the newest chunks until the page is full or the tab's proved count is reached, at most three
 * per load, and a row's labels from its own events. The page-count indicator is the proved count.
 *
 * Run where the dash mirror is: sakura (once it is imported there), or elsewhere with its owner in `E2E_SHOWCASE_DASHPAY`.
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
 * Since the index is read a chunk at a time (QW3-001), re-measured on sakura (2026-10-02, QW4):
 * the language bar 24 requests and 753 chunk documents (was 31-33 and 1,811-1,846: a 256 KiB block
 * per tree, QW4-002); compare listed in 18-20 s and 92-97 requests (was 180-184: a query per commit
 * past each block edge and per delta of an earlier commit, QW4-003), counted in 14 s and 43-44.
 *
 * Run where the dash mirror is: `E2E_DEVNET=moutai`, or elsewhere with its owner in
 * `E2E_SHOWCASE_DASHPAY` (on bonsia it was 7A1MEuLjzcHZq8bLBzGYSUkpb2VM9dv7gtNuNYrPxKt3; on sakura,
 * where the mirror has no DPNS name, CI sets H3xi5biFj6wbxmpbdhHx1D2D3ofKJJ7anDG58ixhqvry:
 * `.github/workflows/web-e2e.yml`).
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
/**
 * The language bar's chunk documents: the whole index (657, which sizes every file) and the trees
 * read a range each (~100). A block per tree read 1,811-1,846 (QW4-002).
 */
const LANGUAGES_CHUNK_DOCS = 900
const COMPARE_LISTED_MS = 40_000
const COMPARE_LISTED_REQUESTS = 150
const COMPARE_COUNT_MS = 40_000
const COMPARE_COUNT_REQUESTS = 90
/** What a page that shows history may read past S-1 on a large repo (cb-3, QW4-017). */
const HISTORY_PAGE_ALLOWANCE = 10
const HISTORY_PAGE_BUDGET = COLD_BUDGET + HISTORY_PAGE_ALLOWANCE
/** Each page a `?pages=` restore reads past the first: its commits' check states, and an index or pack block now and then. */
const RESTORED_PAGE_REQUESTS = 3

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
    const langDocs = recordChunkDocs(lang)
    await lang.goto(repoUrl('', '', dash), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(lang)
    await expect(fileRows(lang).first()).toBeVisible({ timeout: 60_000 })
    await expect(lang.getByTestId('commit-count')).toContainText(/\d/, { timeout: 60_000 })
    await settle(lang)
    const beforeLang = langDapi.all().length
    const beforeLangDocs = langDocs()
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
    const langChunkDocs = langDocs() - beforeLangDocs
    test.info().annotations.push({ type: 'dapi', description: `language bar: ${langMs} ms, ${langReads} requests, ${langChunkDocs} chunk documents` })
    expect(langReads).toBeLessThanOrEqual(LANGUAGES_REQUESTS)
    expect(langChunkDocs).toBeLessThanOrEqual(LANGUAGES_CHUNK_DOCS)
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

  /**
   * QW4-017: the pages that show history, cold. Each object they show costs an index query besides
   * its pack query on a repo whose index is read a chunk at a time, and dash's long ref timeline
   * is 8 key ranges where a small repo's is 1: S-1 plus {@link HISTORY_PAGE_ALLOWANCE}, the budget
   * the History page has had since the history index (`history-index.spec.ts` hi-3).
   * Measured on sakura (2026-10-02): the commits list 26-27, src/validation.cpp's History 23-24
   * (was 33-34: every version's blob resolved through the index, 256 of them), commit c41035f
   * 29-30, and the list restored 20 pages deep 59-65 (was 126: a query per commit past a block edge).
   */
  test('cb-3. the commits list, a file’s History and a commit, cold, within S-1 plus the history allowance', async ({ browser }) => {
    const dash = await showcaseRepo('DASHPAY', 'dash')
    const pages = [
      ['commits list', repoUrl('commits', '', dash), HISTORY_PAGE_BUDGET],
      ['History of src/validation.cpp', repoUrl('commits', '&path=src/validation.cpp', dash), HISTORY_PAGE_BUDGET],
      ['commit c41035f', repoUrl('commit', '&oid=c41035f7d801a45b337efa24e3052f069ff6ef56', dash), HISTORY_PAGE_BUDGET],
      ['commits list, 20 pages', repoUrl('commits', '&pages=20', dash), HISTORY_PAGE_BUDGET + 19 * RESTORED_PAGE_REQUESTS],
    ] as const
    for (const [label, url, budget] of pages) {
      const context = await browser.newContext()
      const page = await context.newPage()
      const { errors } = collectPageErrors(page)
      const dapi = recordDapi(page)
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await waitForRepoResolved(page)
      await expect(page.locator('main a[href*="/repo/commit/"], main [data-testid=commit-subject]').first()).toBeVisible({ timeout: 90_000 })
      await settle(page)
      const all = dapi.all()
      test.info().annotations.push({ type: 'dapi', description: `dash ${label}, cold: ${all.length} ${summary(all)}` })
      expect(errors, errors.join('\n')).toEqual([])
      expect(all.length, `${label}: ${summary(all)}`).toBeLessThanOrEqual(budget)
      await context.close()
    }
  })

  /**
   * QW4-004: a home at a ref no history index covers walks the column 400 commits back. Measured on
   * sakura (2026-10-02): v22.1.3 49-54 requests (was 180: each commit's trees read one after the
   * other, each an index query and a pack query). Held to S-1 plus the column walk's allowance
   * (pb-2's {@link COLUMN_WALK_MAX}).
   */
  test('cb-4. a home at a release tag, cold, within S-1 plus the column walk', async ({ browser }) => {
    const dash = await showcaseRepo('DASHPAY', 'dash')
    const context = await browser.newContext()
    const page = await context.newPage()
    const { errors } = collectPageErrors(page)
    const dapi = recordDapi(page)
    await page.goto(repoUrl('', '&ref=v22.1.3', dash), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(fileRows(page).first()).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('commit-cell-pending').filter({ hasText: '…' })).toHaveCount(0, { timeout: 120_000 })
    await settle(page)
    const all = dapi.all()
    test.info().annotations.push({ type: 'dapi', description: `dash home at v22.1.3, cold: ${all.length} ${summary(all)}` })
    expect(errors, errors.join('\n')).toEqual([])
    expect(all.length, summary(all)).toBeLessThanOrEqual(COLD_BUDGET + COLUMN_WALK_MAX)
    await shot(page, 'cb-04-dash-home-tag')
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
