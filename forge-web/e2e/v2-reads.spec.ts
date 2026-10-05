import { test, expect } from '@playwright/test'
import {
  collectPageErrors,
  DEMO,
  E2E_DEVNET,
  EMPTY,
  expectLanded,
  firstRecentCard,
  loadSeedPulls,
  MAINTAINER,
  repoUrl as url,
  shot,
  waitForRepoResolved,
} from './helpers'
import { quorumGuard } from './quorum-sync'

// Not inside bonsia's quorum-service lag (#212): these specs count requests or read Verification.
test.beforeEach(quorumGuard)

/**
 * forge-v2 read paths against a real devnet (protocol 14): the fixture
 * `forge-contracts/scripts/seed-v2-fixture.mjs` seeds on moutai (e2e/helpers.ts `DEMO`):
 *
 *   E2E_DEVNET=sakura pnpm exec playwright test v2-reads.spec.ts
 *
 * The fixture: repo `forge-v2-demo` owned by OWNER (maintainers OWNER + MAINTAINER, writer
 * COLLAB), main = 3 files + docs/, a feature branch, tag v0.1.0; issue #1 open + labelled by a
 * writer, #2 closed by its author (a `transition` written as the author), #3 closed + labelled by a
 * maintainer, #4 open; then, in the same dense shared sequence (forge-v2.md §6.2), three PRs
 * (numbers from the seed summary, see `loadSeedPulls`): the approved PR open with a maintainer
 * approval, the merged PR, and the review-parity fixture (below); a branch `policy`; one star.
 * `forge-v2-empty` (MAINTAINER) has nothing pushed. The axe checks over these pages live in
 * a11y.spec.ts.
 */

const { owner: OWNER, name: NAME } = DEMO

test.describe('forge-v2 read paths (devnet fixture)', () => {
  test('v2-1. landing: hero, header chrome, forge-v2 repos with provable counts', async ({ page }) => {
    const { errors } = collectPageErrors(page)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    // Foundry hero, header chrome (wordmark link, network badge, sign-in, search) and the
    // verification chip.
    await expect(page.getByRole('heading', { name: /no server to trust/i })).toBeVisible()
    await expect(page.locator('header a[href="/"]').first()).toBeVisible()
    await expect(page.getByTestId('network-badge')).toContainText(E2E_DEVNET)
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible()
    await expect(page.getByLabel(/jump to a repo/i).first()).toBeVisible()
    await expect(page.getByRole('group', { name: /verification status/i })).toBeVisible()
    // The live write specs keep creating repos, so the fixture may have scrolled off the
    // newest 24: assert on whatever is newest, then on the fixture's counts by name.
    const card = await firstRecentCard(page)
    // The composite read brought the counts along for every row.
    const row = card.locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]')
    await expect(row.getByTitle(/Stars/)).toBeVisible()
    await expect(row.getByTitle(/Issues/)).toBeVisible()
    // The fixture is featured on sakura (above the feed, which then leaves it out).
    const demo = page.locator('main a', { hasText: 'forge-v2 demo' }).first()
    if (await demo.count()) {
      const demoRow = demo.locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]')
      // Issues #1-#4 (seed-v2-fixture.mjs; #4 came with the review-parity fixture).
      await expect(demoRow.getByTitle(/Issues/)).toHaveText(/(^|\D)4(\D|$)/)
    }
    // Nothing v2 says "not deployed" here.
    await expect(page.getByText(/not deployed/i)).toHaveCount(0)
    await shot(page, 'v2-01-landing')
    expect(errors, errors.join('\n')).toEqual([])
  })

  test('v2-2. repo home: README, tree, members-backed trust panel, clone box', async ({ page }) => {
    const { errors } = collectPageErrors(page)
    await page.goto(url(), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    // The repo title (the README's own "forge-v2-demo" heading may already be there too).
    await expectLanded(page, page.getByTestId('repo-title').filter({ hasText: NAME }))
    // The published locator serves the root tree and README from Platform chunks.
    for (const entry of ['README.md', 'src', 'lib', 'docs']) {
      await expect(page.getByRole('link', { name: entry, exact: true }).first()).toBeVisible()
    }
    await expect(page.getByText(/code, issues and pull requests in the shared contracts/i).first()).toBeVisible()
    await expect(page.getByText(`dash://${OWNER}/${NAME}`, { exact: true })).toBeVisible()
    await expect(page.getByText(/\bmain\b/).first()).toBeVisible()
    // The Verification card says the ref was built from proof-checked history.
    await page.getByRole('button', { name: /verification/i }).click()
    await expect(page.getByText(/checked against Platform proofs/).first()).toBeVisible()
    await shot(page, 'v2-02-repo-home')
    expect(errors, errors.join('\n')).toEqual([])
  })

  test('v2-3. tree and blob views read hash-checked objects', async ({ page }) => {
    await page.goto(url('tree', '&path=src'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expectLanded(page, page.getByRole('link', { name: 'main.rs' }).first())
    await page.getByRole('link', { name: 'main.rs' }).first().click()
    await expect(page.getByText('Your browser verifies what it shows').first()).toBeVisible({ timeout: 45_000 })
    await shot(page, 'v2-03-blob')
  })

  test('v2-4. issues list reads state from transitions and labels from events', async ({ page }) => {
    await page.goto(url('issues'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expectLanded(page, page.getByRole('list', { name: 'Issues', exact: true }).getByText('README should explain the event split'))
    await expect(page.getByText('question').first()).toBeVisible()
    // The fixture pins #1 (member event kind 19): it is also shown above the list.
    await expect(page.getByTestId('pinned-issue').filter({ hasText: 'README should explain the event split' })).toBeVisible()
    await page.getByRole('tab', { name: /Closed/ }).click()
    await expect(page.getByText('Duplicate of #1')).toBeVisible()
    await expect(page.getByText('Add a rules page')).toBeVisible()
    await shot(page, 'v2-04-issues')
  })

  test('v2-5. issue detail shows the author close and the thread', async ({ page }) => {
    await page.goto(url('issue', '&number=2'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expectLanded(page, page.getByRole('heading', { name: /Duplicate of #1/ }))
    await expect(page.getByText('Closed', { exact: true }).first()).toBeVisible()
    await expect(page.getByText(/closed this/).first()).toBeVisible()

    await page.goto(url('issue', '&number=3'), { waitUntil: 'domcontentloaded' })
    await expectLanded(page, page.getByRole('heading', { name: /Add a rules page/ }))
    await expect(page.getByText('Done in docs/rules.md; closing.')).toBeVisible()
    await shot(page, 'v2-05-issue')
  })

  test('v2-6. PR detail: counted approval, diff, merged PR', async ({ page }) => {
    const pulls = loadSeedPulls()
    await page.goto(url('pull', `&number=${pulls.approved}`), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expectLanded(page, page.getByRole('heading', { name: /Greet by name/ }))
    const approvals = page.getByRole('region', { name: 'Approvals' })
    // MAINTAINER's seeded approval; the write spec (v2-writes w6) may have added OWNER's.
    await expect(approvals.getByText(/approved · maintainer/).first()).toBeVisible()
    await expect(page.getByText(/Objects live in this repo/)).toBeVisible()
    // The diff (the Files changed tab) reads both sides through the browse plane.
    await page.getByRole('tab', { name: /Files changed/ }).click()
    await expect(page.getByText('src/main.rs').first()).toBeVisible({ timeout: 45_000 })
    await expect(page.getByText(/hello, \{name\}/).first()).toBeVisible({ timeout: 45_000 })
    await shot(page, 'v2-06-pull')

    await page.goto(url('pull', `&number=${pulls.merged}`), { waitUntil: 'domcontentloaded' })
    await expectLanded(page, page.getByRole('heading', { name: /Document the fold rules/ }))
    await expect(page.getByText('Merged', { exact: true }).first()).toBeVisible()
  })

  test('v2-7. settings list members from membership documents', async ({ page }) => {
    await page.goto(url('settings'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    // Settings → Members (the glossary's term for people with a role; #66 had called it Collaborators).
    const collaborators = page.getByRole('region', { name: 'Members' })
    await expectLanded(page, collaborators.getByText('WRITER', { exact: true }))
    await expect(collaborators.getByText('MAINTAINER', { exact: true })).toHaveCount(2)
    await expect(collaborators.getByText('owner', { exact: true })).toBeVisible()
    await shot(page, 'v2-07-settings')
  })

  test('v2-8. profile lists owned and member repos; ?repo= pins; empty repo', async ({ page }) => {
    await page.goto(`/u/?name=${MAINTAINER}`, { waitUntil: 'domcontentloaded' })
    await expectLanded(page, page.getByRole('heading', { name: 'Member of' }))
    await expect(page.getByRole('link', { name: EMPTY.name })).toBeVisible()
    await expect(page.getByRole('link', { name: 'forge-v2 demo' })).toBeVisible()
    await shot(page, 'v2-08-profile')

    await page.goto(url('', '', EMPTY), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expectLanded(page, page.getByRole('region', { name: 'Empty repository' }))
    await expect(page.getByText(/remote add origin dash:\/\//)).toBeVisible()
  })

  test('v2-9. landing is usable at a 375px mobile viewport with no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: /no server to trust/i })).toBeVisible()
    // Header stays usable at mobile width: the icon-only home link and sign-in are reachable
    // (the "Dash Forge" wordmark text is intentionally hidden below the sm breakpoint); a
    // devnet badge shows at every width.
    await expect(page.locator('header a[href="/"]').first()).toBeVisible()
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible()
    await expect(page.getByTestId('network-badge')).toBeVisible()
    // Measure once the feed has settled on its terminal state (cards, not the skeleton).
    await firstRecentCard(page)
    const overflow = await page.evaluate(() => {
      const de = document.documentElement
      return { scrollW: de.scrollWidth, clientW: de.clientWidth }
    })
    expect(
      overflow.scrollW,
      `horizontal overflow: scrollWidth ${overflow.scrollW} > clientWidth ${overflow.clientW}`,
    ).toBeLessThanOrEqual(overflow.clientW + 1)
    await shot(page, 'v2-09-landing-mobile')
  })
})
