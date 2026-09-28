import { test, expect, type Page } from '@playwright/test'
import { collectPageErrors, countDapi, DEMO, repoUrl, shot, waitForRepoResolved } from './helpers'

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
