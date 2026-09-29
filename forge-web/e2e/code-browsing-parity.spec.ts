import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectPageErrors, countDapi, countDocumentQueries, DEMO, E2E_DEVNET, repoUrl, shot, showcaseRepo, waitForRepoResolved } from './helpers'

/**
 * F-5 code browsing parity with GitHub, on moutai:
 *
 *   E2E_DEVNET=moutai pnpm exec playwright test code-browsing-parity.spec.ts
 *
 * The first group reads the forge-v2 read fixture (e2e/helpers.ts `DEMO`: main = c1 "Initial
 * import" → c2 "Document the fold rules"; `src/main.rs` has 4 lines on main). The "showcase repos"
 * group reads the imported mirrors (ripgrep, fzf, jq), owners resolved by DPNS name.
 */

const MAIN_RS = 'src/main.rs'

/** Every DAPI request, summed. */
const total = (counts: Map<string, number>): number => [...counts.values()].reduce((a, n) => a + n, 0)

async function openBlob(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page)
  await expect(page.locator('table[data-lines]')).toBeVisible({ timeout: 60_000 })
}

test.describe('permalinks and line anchors (read fixture)', () => {
  test('pl-1. a short URL with #L2-L3 expands, selects and keeps the range after a reload', async ({ page }) => {
    const { errors } = collectPageErrors(page)
    await openBlob(page, `/${DEMO.owner}/${DEMO.name}/blob/main/${MAIN_RS}#L2-L3`)
    await expect(page).toHaveURL(/\/repo\/blob\/\?.*ref=main.*#L2-L3$/)
    await expect(page.getByText('Lines 2–3 selected')).toBeVisible()
    await expect(page.locator('tr[data-selected]')).toHaveCount(2)
    await expect(page.locator('#L2')).toHaveAttribute('data-selected', 'true')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('table[data-lines]')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('tr[data-selected]')).toHaveCount(2)
    await expect(page.locator('#L3')).toHaveAttribute('data-selected', 'true')
    expect(errors, errors.join('\n')).toEqual([])
  })

  test('pl-2. a click selects a line, shift-click extends it, and the URL follows', async ({ page }) => {
    await openBlob(page, repoUrl('blob', `&path=${MAIN_RS}`))
    await page.locator('#L1 a').click()
    await expect(page).toHaveURL(/#L1$/)
    await page.locator('#L4 a').click({ modifiers: ['Shift'] })
    await expect(page).toHaveURL(/#L1-L4$/)
    await expect(page.getByText('Lines 1–4 selected')).toBeVisible()
    await expect(page.locator('tr[data-selected]')).toHaveCount(4)
  })

  test('pl-3. y pins the address to the commit, keeps the selection and reads nothing new', async ({ page }) => {
    await openBlob(page, repoUrl('blob', `&path=${MAIN_RS}`) + '#L2')
    await expect(page.locator('tr[data-selected]')).toHaveCount(1)
    // The copied link is the short form at the commit, with the range.
    const permalink = page.getByTestId('copy-permalink')
    const href = String(await permalink.getAttribute('data-href'))
    const oid = /\/blob\/([0-9a-f]{40})\//.exec(href)?.[1] ?? ''
    expect(href).toBe(`${new URL(page.url()).origin}/${DEMO.owner}/${DEMO.name}/blob/${oid}/${MAIN_RS}#L2`)

    // `y` typed into a field is a y, not a shortcut.
    const jump = page.locator('input[data-jump-box]:visible').first()
    await jump.focus()
    await page.keyboard.press('y')
    await expect(jump).toHaveValue('y')
    expect(page.url()).not.toContain(oid)
    await jump.fill('')
    await jump.blur()

    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
    const counts = countDapi(page)
    await page.locator('body').press('y')
    await expect(page).toHaveURL(new RegExp(`ref=${oid}.*#L2$`))
    await expect(page.locator('tr[data-selected]')).toHaveCount(1)
    await expect(page.getByText('Line 2 selected')).toBeVisible()
    // The ref switcher now names the pinned commit.
    await expect(page.locator('main').getByText(oid.slice(0, 7)).first()).toBeVisible()
    await page.waitForTimeout(1500)
    test.info().annotations.push({ type: 'dapi', description: `y: ${total(counts)} DAPI requests ${JSON.stringify(Object.fromEntries(counts))}` })
    expect(total(counts), 'y re-reads nothing: the pinned commit is the one on screen').toBe(0)
    await shot(page, 'f5-pl-03-y-permalink')

    // The copied short link opens the same file at the same commit, range selected.
    await openBlob(page, new URL(href).pathname + '#L2')
    await expect(page).toHaveURL(new RegExp(`/repo/blob/\\?.*ref=${oid}.*#L2$`))
    await expect(page.getByText('Line 2 selected')).toBeVisible()
  })

  test('pl-4. y on a directory and on the repo home pins the tree', async ({ page }) => {
    await page.goto(repoUrl('tree', '&path=src'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(page.getByRole('link', { name: 'main.rs' })).toBeVisible({ timeout: 60_000 })
    await page.locator('body').press('y')
    await expect(page).toHaveURL(/\/repo\/tree\/\?.*path=src.*ref=[0-9a-f]{40}|\/repo\/tree\/\?.*ref=[0-9a-f]{40}.*path=src/)
    await expect(page.getByRole('link', { name: 'main.rs' })).toBeVisible()

    await page.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(page.getByRole('link', { name: 'README.md' }).first()).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('section[aria-label=README]')).toBeVisible({ timeout: 60_000 })
    await page.locator('body').press('y')
    // The home stays the home (README included), at the commit, as GitHub's /tree/<oid> does.
    await expect(page).toHaveURL(/\/repo\/\?.*ref=[0-9a-f]{40}/)
    await expect(page.getByRole('link', { name: 'README.md' }).first()).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('section[aria-label=README]')).toBeVisible()
  })
})

/** The fixture's main: c1 "Initial import" wrote src/main.rs (3 lines), c2 "Document the fold rules" added line 3. */
test.describe('commits, History and Blame (read fixture)', () => {
  test('hb-1. a file’s History lists the commits that changed it; the directory History too', async ({ page }) => {
    await page.goto(repoUrl('blob', `&path=${MAIN_RS}`), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await page.getByTestId('history-link').click()
    await expect(page).toHaveURL(/\/repo\/commits\/\?.*path=src%2Fmain\.rs/)
    const rows = page.getByTestId('commit-row')
    await expect(rows).toHaveCount(2, { timeout: 60_000 })
    await expect(rows.nth(0)).toContainText('Document the fold rules')
    await expect(rows.nth(1)).toContainText('Initial import')
    await expect(page.getByTestId('log-status')).toContainText('the whole history')
    // docs/ was added by c2 only.
    await page.goto(`/${DEMO.owner}/${DEMO.name}/commits/main/docs`, { waitUntil: 'domcontentloaded' })
    await expect(page).toHaveURL(/\/repo\/commits\/\?.*path=docs/)
    await expect(page.getByTestId('commit-row')).toHaveCount(1, { timeout: 60_000 })
    await expect(page.getByTestId('commit-row')).toContainText('Document the fold rules')
    await shot(page, 'f5-hb-01-path-history')
  })

  test('hb-2. blame of the 3-commit file names each line’s commit, as git blame does', async ({ page }) => {
    const { errors } = collectPageErrors(page)
    const counts = countDapi(page)
    await page.goto(`/${DEMO.owner}/${DEMO.name}/blame/main/${MAIN_RS}#L3`, { waitUntil: 'domcontentloaded' })
    await expect(page).toHaveURL(/\/repo\/blame\/\?.*path=src%2Fmain\.rs.*#L3$/)
    const table = page.getByTestId('blame-table')
    await expect(table).toBeVisible({ timeout: 60_000 })
    // Lines 1, 2 and 4 are c1's, line 3 is c2's (git blame --first-parent on the seeded history).
    const subjects = await page.locator('tr[id^="L"]').evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-oid')))
    expect(subjects).toHaveLength(4)
    const [a, b, c, d] = subjects
    expect(a).toBe(b)
    expect(a).toBe(d)
    expect(c).not.toBe(a)
    await expect(page.locator('#L3')).toHaveAttribute('data-selected', 'true')
    await expect(page.getByTestId('blame-commit').filter({ hasText: 'Document the fold rules' })).toHaveCount(1)
    await expect(page.getByTestId('blame-summary')).toContainText('4 lines · 2 commits')
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
    const total = [...counts.values()].reduce((x, n) => x + n, 0)
    test.info().annotations.push({ type: 'dapi', description: `blame (cold page): ${total} DAPI requests ${JSON.stringify(Object.fromEntries(counts))}` })
    // Measured 19 (connect, refs, browse resolve, a few chunk reads).
    expect(total, JSON.stringify(Object.fromEntries(counts))).toBeLessThanOrEqual(40)
    await shot(page, 'f5-hb-02-blame-fixture')
    expect(errors, errors.join('\n')).toEqual([])
  })

  test('hb-3. History then Blame of the same file reads no more from Platform', async ({ page }) => {
    await openBlob(page, repoUrl('blob', `&path=${MAIN_RS}`))
    await page.getByTestId('history-link').click()
    await expect(page.getByTestId('commit-row')).toHaveCount(2, { timeout: 60_000 })
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
    // In-app navigation to Blame (the file's Code view, then its Blame link): the session's reader
    // and History memo are kept, so the walk re-reads no commit or tree, and no pack chunk.
    await page.goBack()
    await expect(page.locator('table[data-lines]')).toBeVisible({ timeout: 60_000 })
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
    const counts = countDapi(page)
    const chunks = countDocumentQueries(page, 'chunk')
    await page.getByTestId('blame-link').click()
    await expect(page.getByTestId('blame-table')).toBeVisible({ timeout: 60_000 })
    await page.waitForTimeout(1500)
    test.info().annotations.push({ type: 'dapi', description: `blame after history: ${JSON.stringify(Object.fromEntries(counts))}, chunk queries ${chunks.count()}` })
    expect(chunks.count(), 'blame reuses what History read').toBe(0)
  })
})

test.describe('commits paging, History and Blame (showcase repos)', () => {
  test.skip(E2E_DEVNET !== 'moutai', 'the showcase repos are imported on moutai')
  let FZF: { readonly owner: string; readonly name: string }
  let JQ: { readonly owner: string; readonly name: string }
  test.beforeAll(async () => {
    FZF = await showcaseRepo('JUNEGUNN', 'fzf')
    JQ = await showcaseRepo('JQLANG', 'jq')
  })

  test('hb-4. the commit log pages past the first 40, within a request budget per page', async ({ page }) => {
    await page.goto(repoUrl('commits', '', JQ), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    const rows = page.getByTestId('commit-row')
    await expect(rows).toHaveCount(40, { timeout: 60_000 })
    const firstPage = await rows.evaluateAll((els) => els.map((e) => e.textContent))
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
    const counts = countDapi(page)
    await page.getByTestId('older-commits').click()
    await expect(rows).toHaveCount(80, { timeout: 60_000 })
    await page.getByTestId('older-commits').click()
    await expect(rows).toHaveCount(120, { timeout: 60_000 })
    const all = await rows.evaluateAll((els) => els.map((e) => e.textContent))
    expect(all.slice(0, 40)).toEqual(firstPage)
    expect(new Set(all).size).toBe(120)
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
    const total = [...counts.values()].reduce((x, n) => x + n, 0)
    test.info().annotations.push({ type: 'dapi', description: `2 older pages: ${total} DAPI requests ${JSON.stringify(Object.fromEntries(counts))}` })
    // Commits are read in 256 KiB blocks (~15 platform chunks each): two pages of 40 are one or two blocks.
    // Measured 1.
    expect(total, JSON.stringify(Object.fromEntries(counts))).toBeLessThanOrEqual(6)
    await shot(page, 'f5-hb-04-jq-commits-page-3')
  })

  test('hb-5. blame of fzf main.go matches git blame --first-parent line for line; cancel stops a run', async ({ page }) => {
    test.setTimeout(240_000)
    const want = readFileSync(join(__dirname, 'fixtures/fzf-main-go-blame.txt'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.split(' ')[0])
    const counts = countDapi(page)
    const t0 = Date.now()
    await page.goto(repoUrl('blame', '&path=main.go&ref=b1be3a8be1b833ce5b92fbbac11637643d60a046', FZF), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(page.getByTestId('blame-progress').or(page.getByTestId('blame-table'))).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('blame-table')).toBeVisible({ timeout: 180_000 })
    const ms = Date.now() - t0
    const got = await page.locator('tr[id^="L"]').evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-oid')))
    expect(got).toEqual(want)
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
    const total = [...counts.values()].reduce((x, n) => x + n, 0)
    test.info().annotations.push({ type: 'dapi', description: `fzf main.go blame: ${ms} ms, ${total} DAPI requests ${JSON.stringify(Object.fromEntries(counts))}` })
    // Measured 48 for 64 versions of the file, cold (the page load included).
    expect(total, JSON.stringify(Object.fromEntries(counts))).toBeLessThanOrEqual(90)
    await shot(page, 'f5-hb-05-fzf-blame')

    // A fresh run, cancelled: it stops and offers to start again.
    await page.goto(repoUrl('blame', '&path=src/terminal.go', FZF), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    const cancel = page.getByTestId('blame-cancel')
    await expect(cancel).toBeVisible({ timeout: 60_000 })
    await cancel.click()
    await expect(page.getByRole('heading', { name: 'Blame stopped' })).toBeVisible()
    await expect(page.getByTestId('blame-table')).toHaveCount(0)
  })
})

/**
 * LICENSE and the language bar in the About card (F-5), against GitHub's own answers for the
 * mirrored repos (its licenses and languages APIs, 2026-09-28): ripgrep MIT + Unlicense (GitHub
 * names the Unlicense only), Rust first; fzf MIT, Go first; jq a bundled COPYING (GitHub:
 * NOASSERTION), C first. The bar is worked out after the page settles, from the tree walk Go to file
 * shares (tree reads only), and costs no request on a warm revisit.
 */
test.describe('LICENSE and languages (showcase repos)', () => {
  test.skip(E2E_DEVNET !== 'moutai', 'the showcase repos are imported on moutai')

  const CASES = [
    ['BURNTSUSHI', 'ripgrep', /MIT or Unlicense/, 'Rust'],
    ['JUNEGUNN', 'fzf', /^MIT$/, 'Go'],
    ['JQLANG', 'jq', /^Other$/, 'C'],
  ] as const

  for (const [key, name, license, first] of CASES) {
    test(`lb-${name}. the About card names the license and the largest language`, async ({ page }) => {
      const repo = await showcaseRepo(key, name)
      const counts = countDapi(page)
      await page.goto(repoUrl('', '', repo), { waitUntil: 'domcontentloaded' })
      await waitForRepoResolved(page)
      const about = page.getByRole('complementary', { name: 'About this repository' })
      // The facts are worked out once the About card is in view (S-1).
      await about.getByRole('region', { name: 'About' }).scrollIntoViewIfNeeded({ timeout: 90_000 })
      await expect(about.getByTestId('repo-license')).toBeVisible({ timeout: 90_000 })
      await expect(about.getByTestId('repo-license').locator('span').last()).toHaveText(license)
      const bar = about.getByTestId('language-bar')
      await expect(bar).toBeVisible({ timeout: 90_000 })
      await expect(bar.getByTestId('language').first()).toContainText(first)
      await expect(bar.getByTestId('language-note')).toContainText('≈ by stored (compressed) size')
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
      const cold = [...counts.values()].reduce((a, n) => a + n, 0)
      test.info().annotations.push({
        type: 'dapi',
        description: `${name} cold home with the About facts: ${cold} DAPI requests ${JSON.stringify(Object.fromEntries(counts))}; ${await bar.getByTestId('language-note').innerText()}`,
      })
      // A cold home with the facts worked out (the About card scrolled into view): the home's
      // budget plus the facts' walk (repo-home-latency rhl-1).
      expect(cold, JSON.stringify(Object.fromEntries(counts))).toBeLessThanOrEqual(80)
      await shot(page, `f5-lb-${name}`)

      // The license row opens the license file.
      expect(String(await about.getByTestId('repo-license').getAttribute('href'))).toMatch(/\/repo\/blob\/\?.*path=(LICENSE|COPYING|UNLICENSE)/)

      // Warm: back to the home in the tab, the facts are shown at once and read nothing.
      await page.getByRole('link', { name: /^Issues/ }).first().click()
      await expect(page).toHaveURL(/\/repo\/issues\//)
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
      const warm = countDocumentQueries(page, 'chunk')
      await page.getByRole('link', { name: /^Code$/ }).first().click()
      await expect(about.getByTestId('language-bar')).toBeVisible({ timeout: 10_000 })
      await page.waitForTimeout(1500)
      test.info().annotations.push({ type: 'dapi', description: `${name} warm revisit: ${warm.count()} chunk queries` })
      expect(warm.count(), 'the walk is not repeated on a warm revisit').toBe(0)
    })
  }

  test('lb-go-to-file. Go to file lists from the same walk, with no new reads', async ({ page }) => {
    const repo = await showcaseRepo('JUNEGUNN', 'fzf')
    await page.goto(repoUrl('', '', repo), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await page.getByRole('region', { name: 'About' }).scrollIntoViewIfNeeded({ timeout: 90_000 })
    await expect(page.getByTestId('language-bar')).toBeVisible({ timeout: 90_000 })
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
    const chunks = countDocumentQueries(page, 'chunk')
    const dapi = countDapi(page)
    await page.getByLabel('Go to file').fill('terminal.go')
    await expect(page.getByRole('option').filter({ hasText: 'src/terminal.go' })).toBeVisible({ timeout: 10_000 })
    expect(chunks.count()).toBe(0)
    expect([...dapi.values()].reduce((a, n) => a + n, 0)).toBe(0)
  })
})
