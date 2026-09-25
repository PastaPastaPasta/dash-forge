import { test, expect, type Page } from '@playwright/test'
import { collectPageErrors, E2E_DEVNET, readErrorBanner, runAxe, shot, waitForRepoResolved } from './helpers'

/**
 * forge-v2 read paths against a real devnet (protocol 14): the fixture
 * `forge-contracts/scripts/seed-v2-fixture.mjs` seeds on moutai. Runs only on a devnet build:
 *
 *   E2E_DEVNET=moutai pnpm exec playwright test v2-reads.spec.ts
 *
 * The fixture: repo `forge-v2-demo` owned by OWNER (maintainers OWNER + MAINTAINER, writer
 * COLLAB), main = 3 files + docs/, a feature branch, tag v0.1.0; issue #1 open + labelled by a
 * writer, #2 closed by its author (`authorEvent`), #3 closed + labelled by a maintainer; PR #1
 * open with a maintainer approval, PR #2 merged; one star. `forge-v2-empty` (MAINTAINER) has
 * nothing pushed.
 */

test.skip(E2E_DEVNET === '', 'the forge-v2 fixture lives on a devnet; set E2E_DEVNET=moutai')

const OWNER = process.env['E2E_V2_OWNER'] ?? '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const MAINTAINER = 'GKBTXUdo3MpRYAUqgZvTZGTav9mXGqfJfR5822K2tp79'
const NAME = process.env['E2E_V2_NAME'] ?? 'forge-v2-demo'

function url(path = '', extra = '', owner = OWNER, name = NAME): string {
  const q = `owner=${owner}&name=${name}${extra}`
  return path === '' ? `/repo/?${q}` : `/repo/${path}/?${q}`
}

/** Fail fast with the app's read-error text instead of a bare timeout. */
async function expectLanded(page: Page, success: ReturnType<Page['getByText']>): Promise<void> {
  await expect(success.or(readErrorBanner(page))).toBeVisible({ timeout: 45_000 })
  if (await readErrorBanner(page).isVisible()) {
    throw new Error(`read error: ${await readErrorBanner(page).innerText()}`)
  }
}

test.describe('forge-v2 read paths (devnet fixture)', () => {
  test('v2-1. landing lists forge-v2 repos with provable counts', async ({ page }) => {
    const { errors } = collectPageErrors(page)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.getByText(`devnet-${E2E_DEVNET}`).first()).toBeVisible()
    const feed = page.locator('section').filter({ hasText: 'Recent repos' }).first()
    const card = feed.locator('a', { hasText: 'forge-v2 demo' }).first()
    await expectLanded(page, card)
    // The composite read brought the counts along (1 star, 3 issues).
    const row = card.locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]')
    await expect(row.getByTitle(/Stars/)).toContainText('1')
    await expect(row.getByTitle(/Issues/)).toContainText('3')
    // Nothing v2 says "not deployed" here.
    await expect(page.getByText(/not deployed/i)).toHaveCount(0)
    await shot(page, 'v2-01-landing')
    expect(errors, errors.join('\n')).toEqual([])
  })

  test('v2-2. repo home: README, tree, members-backed trust panel, clone box', async ({ page }) => {
    const { errors } = collectPageErrors(page)
    await page.goto(url(), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expectLanded(page, page.getByRole('heading', { name: 'forge-v2-demo' }))
    // The published locator serves the root tree and README from Platform chunks.
    for (const entry of ['README.md', 'src', 'lib', 'docs']) {
      await expect(page.getByRole('link', { name: entry, exact: true }).first()).toBeVisible()
    }
    await expect(page.getByText(/code, issues and pull requests in the shared contracts/i).first()).toBeVisible()
    await expect(page.getByText(`dash://${OWNER}/${NAME}`)).toBeVisible()
    // The assay panel attests the ref by FORGE_RULES_V2 and names the repo id.
    await page.getByRole('button', { name: /assay/i }).click()
    await expect(page.getByText(/FORGE_RULES_V2/).first()).toBeVisible()
    await shot(page, 'v2-02-repo-home')
    expect(errors, errors.join('\n')).toEqual([])
  })

  test('v2-3. tree and blob views read hash-checked objects', async ({ page }) => {
    await page.goto(url('tree', '&path=src'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expectLanded(page, page.getByRole('link', { name: 'main.rs' }).first())
    await page.getByRole('link', { name: 'main.rs' }).first().click()
    await expect(page.getByText('reads are proof-checked').first()).toBeVisible({ timeout: 45_000 })
    await shot(page, 'v2-03-blob')
  })

  test('v2-4. issues list folds event + authorEvent', async ({ page }) => {
    await page.goto(url('issues'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expectLanded(page, page.getByText('README should explain the event split'))
    await expect(page.getByText('question').first()).toBeVisible()
    await page.getByRole('button', { name: /Closed/ }).click()
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
    await page.goto(url('pull', '&number=1'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expectLanded(page, page.getByRole('heading', { name: /Greet by name/ }))
    const approvals = page.getByRole('region', { name: 'Approvals' })
    await expect(approvals.getByText(/approved · maintainer/)).toBeVisible()
    await expect(page.getByText(/Objects live in this repo/)).toBeVisible()
    // The diff reads both sides through the browse plane.
    await expect(page.getByText('src/main.rs').first()).toBeVisible({ timeout: 45_000 })
    await expect(page.getByText(/hello, \{name\}/).first()).toBeVisible({ timeout: 45_000 })
    await shot(page, 'v2-06-pull')

    await page.goto(url('pull', '&number=2'), { waitUntil: 'domcontentloaded' })
    await expectLanded(page, page.getByRole('heading', { name: /Document the fold rules/ }))
    await expect(page.getByText('Merged', { exact: true }).first()).toBeVisible()
  })

  test('v2-7. settings list members from membership documents', async ({ page }) => {
    await page.goto(url('settings'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expectLanded(page, page.getByRole('heading', { name: 'Members' }))
    await expect(page.getByText('MAINTAINER').first()).toBeVisible()
    await expect(page.getByText('WRITER').first()).toBeVisible()
    await shot(page, 'v2-07-settings')
  })

  test('v2-8. profile lists owned and member repos; ?repo= pins; empty repo', async ({ page }) => {
    await page.goto(`/u/?name=${MAINTAINER}`, { waitUntil: 'domcontentloaded' })
    await expectLanded(page, page.getByRole('heading', { name: 'Member of' }))
    await expect(page.getByRole('link', { name: 'forge-v2-empty' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'forge-v2 demo' })).toBeVisible()
    await shot(page, 'v2-08-profile')

    await page.goto(url('', '', MAINTAINER, 'forge-v2-empty'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expectLanded(page, page.getByText(/no commits yet/i))
  })

  test('v2-9. a11y: no serious/critical violations on the v2 pages', async ({ page }) => {
    const pages: [string, string, ReturnType<Page['getByText']>][] = [
      ['landing', '/', page.getByRole('link', { name: 'forge-v2 demo' }).first()],
      ['repo-home', url(), page.getByRole('link', { name: 'README.md' }).first()],
      ['issues', url('issues'), page.getByText('README should explain the event split')],
      ['pull', url('pull', '&number=1'), page.getByRole('region', { name: 'Approvals' })],
    ]
    for (const [label, href, ready] of pages) {
      await page.goto(href, { waitUntil: 'domcontentloaded' })
      await expectLanded(page, ready)
      const serious = await runAxe(page, `v2-${label}`)
      expect(serious, `${label}:\n${serious.map((v) => `${v.id}: ${v.help}`).join('\n')}`).toEqual([])
    }
  })
})
