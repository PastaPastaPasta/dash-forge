import { test, expect, type Page } from '@playwright/test'
import { PUSH_COST_DASH } from '../lib/sdk/cost'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectPageErrors, DEMO, E2E_DEVNET, EMPTY, readErrorBanner, runAxe, SCREENSHOT_DIR, shot, waitForRepoResolved } from './helpers'

/**
 * Repo home launch UX against the moutai forge-v2 fixture (read-only; nothing is signed):
 * the Verification card and its quorum-key cross-check, the rail, the five-tab header, the
 * clone box (zip + install sheet), the empty repo, short URLs through the 404 shim, the
 * Releases tab, axe, and a 390px phone.
 *
 *   E2E_DEVNET=bonsia E2E_PORT=4322 pnpm exec playwright test v2-home.spec.ts
 */


const OWNER = DEMO.owner
const MAINTAINER = EMPTY.owner
const NAME = process.env['E2E_V2_NAME'] ?? 'forge-v2-demo'

function url(path = '', extra = '', owner = OWNER, name = NAME): string {
  const q = `owner=${owner}&name=${name}${extra}`
  return path === '' ? `/repo/?${q}` : `/repo/${path}/?${q}`
}

async function expectLanded(page: Page, success: ReturnType<Page['getByText']>): Promise<void> {
  await expect(success.or(readErrorBanner(page))).toBeVisible({ timeout: 60_000 })
  if (await readErrorBanner(page).isVisible()) throw new Error(`read error: ${await readErrorBanner(page).innerText()}`)
}

async function expectNoSeriousA11y(page: Page, label: string): Promise<void> {
  const serious = await runAxe(page, label)
  expect(serious, serious.map((v) => `${v.id}: ${v.help}`).join('\n')).toEqual([])
}

async function openHome(page: Page): Promise<void> {
  await page.goto(url(), { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page)
  await expectLanded(page, page.getByRole('link', { name: 'README.md', exact: true }).first())
}

/** The Verification card once its chain check settled (never green before). */
async function settledCard(page: Page) {
  const card = page.getByTestId('verification-card')
  await expect(card.getByTestId('verification-summary')).not.toHaveText('Checking…', { timeout: 45_000 })
  return card
}

test.describe('repo home launch UX (moutai fixture)', () => {
  // axe samples colours mid-fade otherwise; reduced motion is also the path a11y users take.
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
  })

  test('b-1. home: ref bar, lazy commit column, README, rail with Verification first', async ({ page }) => {
    const { errors } = collectPageErrors(page)
    await openHome(page)
    // Ref bar: switcher, n commits, Go to file.
    await expect(page.getByTestId('commit-count')).toHaveText(/\d+\+? commits/, { timeout: 45_000 })
    await expect(page.getByLabel('Go to file')).toBeVisible()
    // The commit column fills in after the list painted.
    const readmeRow = page.getByRole('link', { name: 'README.md', exact: true }).first().locator('xpath=..')
    await expect(readmeRow.locator('a[href*="/repo/commit"]')).toBeVisible({ timeout: 45_000 })
    await expect(page.getByRole('region', { name: 'README' })).toBeVisible()

    // Rail order: Verification, Clone, About, Members, Latest release.
    const rail = page.getByRole('complementary', { name: 'About this repository' })
    const titles = await rail.locator(':scope > section').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    expect(titles).toEqual(['Verification', 'Clone', 'About', 'Members', 'Latest release'])
    await expect(rail.getByTestId('rail-members').getByText('maintainer').first()).toBeVisible({ timeout: 45_000 })
    // Read once it is in view (S-1): a skeleton until then, the release once scrolled to.
    const release = rail.getByRole('region', { name: 'Latest release' })
    await release.scrollIntoViewIfNeeded()
    await expect(release).toContainText(/No releases yet|v\d/, { timeout: 45_000 })

    const card = await settledCard(page)
    await expect(card.getByTestId('verification-summary')).toHaveText(/^(Verified|Partly verified) · refs by proof/)
    await card.screenshot({ path: join(SCREENSHOT_DIR, 'b-verification-collapsed.png') })
    await shot(page, 'b-repo-home')
    expect(errors, errors.join('\n')).toEqual([])
  })

  test('b-2. Verification expanded: four rows and the quorum-key cross-check', async ({ page }) => {
    await openHome(page)
    const card = await settledCard(page)
    await card.getByRole('button', { name: /verification/i }).click()
    for (const row of ['Chain data', 'Branch tip', 'File contents', 'Where the bytes came from']) {
      await expect(card.getByText(row, { exact: true })).toBeVisible()
    }
    await expect(card.getByText(`Refs, issues and members were proven against Dash devnet-${E2E_DEVNET}.`)).toBeVisible()
    // The devnet records a DAPI list, so a second key source is asked and must agree.
    await expect(card.getByText(new RegExp(`quorums\\.${E2E_DEVNET}\\.networks\\.dash\\.org and .*\\(a DAPI node\\); both agreed on every one of the \\d+ quorums used`))).toBeVisible()
    await expect(card.getByText(/fetched the key list again to compare/)).toBeVisible()
    await expect(card.getByText(/^`?main`? =|main =/).first()).toBeVisible()
    await expect(card.getByText(/FORGE_RULES_V2/)).toBeVisible()
    await expect(card.getByText(/of [\d,]+ objects? read this session matched their git hash/)).toBeVisible({ timeout: 45_000 })
    await expect(card.getByText(/This app's code comes from/)).toBeVisible()
    await expect(card).toHaveAttribute('data-state', 'verified')
    await card.screenshot({ path: join(SCREENSHOT_DIR, 'b-verification-expanded.png') })
    // No "assay" left in the UI copy.
    await expect(page.getByText(/assay/i)).toHaveCount(0)
    await expectNoSeriousA11y(page, 'b-home-expanded')
  })

  test('b-3. five-tab header: Code · Issues (n) · Pull requests (n) · Releases (Settings for maintainers)', async ({ page }) => {
    await openHome(page)
    const nav = page.getByRole('navigation', { name: 'Repository' })
    // The tab counts are OPEN counts folded from the lists, so a number appears only once the
    // fixture's fold is complete (every row read, every state verified): b-3 and b-3b both
    // depend on that, hence the longer wait.
    await expect(nav.getByRole('link')).toHaveText([/^Code$/, /^Issues\s*\d+$/, /^Pull requests\s*\d+$/, /^Releases$/], {
      timeout: 60_000,
    })
    // Signed out: no Settings, and the old Commits tab is gone (commits live under Code).
    await expect(nav.getByRole('link', { name: /Settings|Commits/ })).toHaveCount(0)
    await expect(nav.getByRole('link', { name: 'Code' })).toHaveAttribute('aria-current', 'page')
    await page.getByTestId('commit-count').click()
    await expect(page).toHaveURL(/\/repo\/commits\//)
    await expect(nav.getByRole('link', { name: 'Code' })).toHaveAttribute('aria-current', 'page')
  })

  test('b-3b. the Issues and Pull requests tab counts are the lists’ OPEN counts, not totals', async ({ page }) => {
    // The fixture has closed issues (#2, #3) and a merged PR (#2): a total would overcount.
    // Like b-3, this needs the fixture's fold to be complete, or the tabs show no number.
    const nav = page.getByRole('navigation', { name: 'Repository' })
    const tabCount = async (label: RegExp): Promise<number> => {
      const tab = nav.getByRole('link', { name: label })
      await expect(tab).toHaveText(/\d+$/, { timeout: 60_000 })
      return Number((await tab.innerText()).match(/(\d+)\s*$/)?.[1])
    }

    await page.goto(url('issues'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    const openFilter = page.getByRole('tab', { name: /^\d+ Open$/ })
    await expectLanded(page, page.getByRole('list', { name: 'Issues', exact: true }).getByText('README should explain the event split'))
    const listOpen = Number((await openFilter.innerText()).match(/(\d+)/)?.[1])
    const listClosed = Number((await page.getByRole('tab', { name: /^\d+ Closed$/ }).innerText()).match(/(\d+)/)?.[1])
    expect(listClosed, 'the fixture has closed issues').toBeGreaterThan(0)
    expect(await tabCount(/^Issues/)).toBe(listOpen)

    // Pull requests: the list opens on its Open filter; count its rows.
    await nav.getByRole('link', { name: /^Pull requests/ }).click()
    await expect(page).toHaveURL(/\/repo\/pulls/)
    const rows = page.locator('main a[href*="/repo/pull?"], main a[href*="/repo/pull/?"]')
    await expect(rows.first().or(page.getByText('No pull requests'))).toBeVisible({ timeout: 60_000 })
    expect(await tabCount(/^Pull requests/)).toBe(await rows.count())
  })

  test('b-4. clone box: dash:// + commands, install sheet, and a hash-checked zip', async ({ page }) => {
    await openHome(page)
    const box = page.getByTestId('clone-box')
    await expect(box.getByText(`dash://${OWNER}/${NAME}`, { exact: true })).toBeVisible()
    // L-03 / L-21: pasted on a machine where nothing chose a network, a bare `git clone` goes to
    // testnet. Both commands name the build's devnet, which the clone keeps in its git config.
    await expect(
      box.getByText(`git clone -c dash.network=devnet -c dash.devnetName=${E2E_DEVNET} dash://${OWNER}/${NAME}`, { exact: true }),
    ).toBeVisible()
    await expect(box.getByText(`dg repo clone ${OWNER}/${NAME} --network devnet --devnet-name ${E2E_DEVNET}`, { exact: true })).toBeVisible()
    await expect(box.getByTestId('clone-network')).toContainText(`devnet-${E2E_DEVNET}`)
    await expect(box.getByText(/No https clone URL/)).toBeVisible()

    await box.getByRole('button', { name: 'install' }).click()
    const sheet = page.getByRole('dialog', { name: /Install git-remote-dash/ })
    await expect(sheet.getByText(/install\.sh \| sh/)).toBeVisible()
    await shot(page, 'b-clone-install')
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)

    const zip = box.getByTestId('zip-download')
    await expect(zip).toBeEnabled({ timeout: 45_000 })
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 90_000 }), zip.click()])
    expect(download.suggestedFilename()).toBe(`${NAME}-main.zip`)
    const path = await download.path()
    const bytes = readFileSync(path)
    expect(bytes.length).toBeGreaterThan(100)
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK')
    expect(bytes.includes(Buffer.from(`${NAME}-main/README.md`))).toBe(true)
    await expect(box.getByText(/Saved .*\.zip .* each hash-checked/)).toBeVisible()
  })

  test('b-5. empty repo: push commands, storage line, install link', async ({ page }) => {
    await page.goto(url('', '', MAINTAINER, 'forge-v2-empty'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    const empty = page.getByRole('region', { name: 'Empty repository' })
    await expectLanded(page, empty)
    await expect(empty.getByText(/is empty\./)).toBeVisible()
    await expect(empty.getByText(`git remote add origin dash://${MAINTAINER}/forge-v2-empty`)).toBeVisible()
    // The network goes into the repository's git config before the push (L-03), and the
    // from-scratch line clones on the build's network before its `cd` (L-21).
    const lines = await empty.locator('code').allInnerTexts()
    expect(lines).toEqual([
      `git remote add origin dash://${MAINTAINER}/forge-v2-empty`,
      `git config dash.network devnet && git config dash.devnetName ${E2E_DEVNET}`,
      'git push -u origin main',
      `dg repo clone ${MAINTAINER}/forge-v2-empty --network devnet --devnet-name ${E2E_DEVNET} && cd forge-v2-empty`,
    ])
    await expect(empty.getByTestId('empty-repo-network')).toContainText(`devnet-${E2E_DEVNET}`)
    await expect(empty.getByText(/Storage: packs go to/)).toBeVisible()
    // L-11: the ~0.0003 DASH per push copy was 5-10x low; the calibrated beta.5 figures show instead.
    await expect(empty.getByText(/0\.0003 DASH/)).toHaveCount(0)
    await expect(empty.getByText(/a small push ≈ 0\.003–0\.005 DASH/)).toBeVisible()
    // The rate comes from the cost module (the chunk fees `dg` and the docs quote), never a literal.
    await expect(empty.getByText(`~${PUSH_COST_DASH.perMib} DASH/MiB`)).toBeVisible()
    await expect(empty.getByRole('link', { name: 'Install →' })).toBeVisible()
    // With no storage configured, the amber note links to the storage settings.
    const note = empty.getByRole('note')
    if (await note.count()) await expect(note.getByRole('link', { name: 'Configure storage →' })).toHaveAttribute('href', /\/settings\/storage/)
    await shot(page, 'b-empty-repo')
    await expectNoSeriousA11y(page, 'b-empty-repo')
  })

  test('b-6. short URLs through the 404 shim', async ({ page }) => {
    await page.goto(`/${OWNER}/${NAME}`, { waitUntil: 'domcontentloaded' })
    await page.waitForURL(/\/repo\/\?owner=/)
    expect(new URL(page.url()).searchParams.get('name')).toBe(NAME)
    await expectLanded(page, page.getByRole('link', { name: 'README.md', exact: true }).first())
    // The header copies the short form.
    await expect(page.getByTestId('copy-link').first()).toHaveAttribute('data-href', new RegExp(`/${OWNER}/${NAME}$`))

    await page.goto(`/${OWNER}/${NAME}/issues/1`, { waitUntil: 'domcontentloaded' })
    await page.waitForURL(/\/repo\/issue\/\?owner=.*&number=1/)
    await page.goto(`/${OWNER}/${NAME}/tree/main/src`, { waitUntil: 'domcontentloaded' })
    await page.waitForURL(/\/repo\/tree\/\?owner=.*&ref=main&path=src/)
    await expectLanded(page, page.getByRole('link', { name: 'main.rs' }).first())
    // A reserved first segment is a real 404, not a repo.
    await page.goto('/settings/nope', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Nothing here' })).toBeVisible()
  })

  test('b-7. Releases tab', async ({ page }) => {
    await page.goto(url('releases'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expectLanded(page, page.getByRole('heading', { name: 'Releases', exact: true }))
    const nav = page.getByRole('navigation', { name: 'Repository' })
    await expect(nav.getByRole('link', { name: 'Releases' })).toHaveAttribute('aria-current', 'page')
    // The fixture publishes none yet; a published one lists "Published by".
    await expect(page.getByText('No releases yet').or(page.getByTestId('release').first())).toBeVisible({ timeout: 45_000 })
    if (await page.getByTestId('release').count()) await expect(page.getByText(/Published by/).first()).toBeVisible()
    await shot(page, 'b-releases')
    await expectNoSeriousA11y(page, 'b-releases')
  })

  test('b-8. 390px phone: rail under the content, Verification first, dash:// and zip only', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openHome(page)
    const card = page.getByTestId('verification-card')
    const list = page.getByRole('link', { name: 'README.md', exact: true }).first()
    const [cardBox, listBox] = [await card.boundingBox(), await list.boundingBox()]
    expect(cardBox && listBox && cardBox.y > listBox.y).toBe(true)
    const box = page.getByTestId('clone-box')
    await expect(box.getByText(`dash://${OWNER}/${NAME}`, { exact: true })).toBeVisible()
    await expect(box.getByText(`git clone dash://${OWNER}/${NAME}`)).toBeHidden()
    await expect(box.getByTestId('zip-download')).toBeVisible()
    // The page never scrolls sideways.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await settledCard(page)
    await shot(page, 'b-mobile-home')
    await expectNoSeriousA11y(page, 'b-mobile-home')
  })
})
