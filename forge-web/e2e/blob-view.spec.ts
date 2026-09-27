import { test, expect } from '@playwright/test'
import { collectPageErrors, E2E_DEVNET, repoUrl, shot, showcaseRepo, waitForRepoResolved } from './helpers'

/**
 * The blob view on showcase repos imported on moutai (their code is stable):
 *
 *   E2E_DEVNET=moutai pnpm exec playwright test blob-view.spec.ts
 */

// Owners resolve by DPNS name (helpers.ts `showcaseRepo`), so a devnet reset that re-mints them
// under new ids does not break these specs.
let FD: { readonly owner: string; readonly name: string }
let JQ: { readonly owner: string; readonly name: string }

test.describe('blob view (showcase repos)', () => {
  test.skip(E2E_DEVNET !== 'moutai', 'the showcase repos are imported on moutai')

  test.beforeAll(async () => {
    FD = await showcaseRepo('SHARKDP', 'fd')
    JQ = await showcaseRepo('JQLANG', 'jq')
  })

  test('bv-1. PNG and SVG blobs are previewed as images, never as inline SVG (D-054)', async ({ page }) => {
    const errors = collectPageErrors(page)
    for (const [path, src] of [
      ['doc/logo.png', /^blob:/],
      // Never a same-origin blob: URL for SVG: opened in a tab, that would run its script here.
      ['doc/logo.svg', /^data:image\/svg\+xml;base64,/],
    ] as const) {
      await page.goto(repoUrl('blob', `&path=${path}`, FD), { waitUntil: 'domcontentloaded' })
      await waitForRepoResolved(page)
      const img = page.getByTestId('blob-image')
      await expect(img).toBeVisible({ timeout: 60_000 })
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
      expect(await img.getAttribute('src')).toMatch(src)
      await expect(page.getByText(/Binary file/)).toHaveCount(0)
    }
    // An SVG can be read as source too.
    await page.getByRole('button', { name: 'Code' }).click()
    await expect(page.locator('#L1')).toContainText('<?xml')
    // The SVG's own markup is never put in the document.
    await expect(page.locator('svg[viewBox="0 0 66 66.000001"]')).toHaveCount(0)
    await shot(page, 'bv-01-svg-preview')
    expect(errors.errors).toEqual([])
  })

  test('bv-2. #L10-L20 highlights the range; clicks update the anchor and a commit permalink (D-054)', async ({ page }) => {
    await page.goto(repoUrl('blob', '&path=src/main.rs', FD) + '#L10-L20', { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(page.getByText('Lines 10–20 selected')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('tr[data-selected]')).toHaveCount(11)

    const before = await page.evaluate(() => window.scrollY)
    await page.locator('#L3 a').click()
    // A click selects; it does not scroll the page.
    expect(await page.evaluate(() => window.scrollY)).toBe(before)
    await page.locator('#L5 a').click({ modifiers: ['Shift'] })
    await expect(page).toHaveURL(/#L3-L5$/)
    await expect(page.locator('tr[data-selected]')).toHaveCount(3)
    // The permalink pins the commit, not the branch.
    const href = (await page.getByTestId('copy-permalink').getAttribute('data-href')) as string
    expect(href).toMatch(/[?&]ref=[0-9a-f]{40}.*#L3-L5$/)

    const url = new URL(href)
    await page.goto(`${url.pathname}${url.search}${url.hash}`, { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(page.getByText('Lines 3–5 selected')).toBeVisible({ timeout: 60_000 })
    await shot(page, 'bv-02-line-anchor')
  })

  test('bv-2b. a deep #L link in a non-windowed file lands on the line (rows are exactly 20 px)', async ({ page }) => {
    await page.goto(repoUrl('blob', '&path=src/main.rs', FD) + '#L500', { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(page.locator('tr[data-selected]')).toHaveCount(1, { timeout: 60_000 })
    await expect(page.locator('#L500')).toBeInViewport()
    expect(await page.locator('#L1').evaluate((el) => el.getBoundingClientRect().height)).toBe(20)
  })

  test('bv-3. a long file renders only the rows in view (D-055)', async ({ page }) => {
    await page.goto(repoUrl('blob', '&path=vendor/decNumber/decNumber.c', JQ) + '#L8000', { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(page.locator('table[data-lines="8144"]')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('#L8000')).toBeInViewport()
    expect(await page.locator('tr[id^="L"]').count()).toBeLessThan(300)
    // Before: 35,410 DOM elements for this 388 KB file.
    expect(await page.evaluate(() => document.getElementsByTagName('*').length)).toBeLessThan(3000)
    await page.evaluate(() => window.scrollTo(0, 0))
    await expect(page.locator('#L1')).toBeAttached()
  })
})
