import { test, expect } from '@playwright/test'
import { collectPageErrors, E2E_DEVNET, runAxe, shot } from './helpers'

/**
 * Explore, the header and the notifications page, signed out, on a devnet (reads only):
 *
 *   E2E_DEVNET=moutai E2E_PORT=4323 pnpm exec playwright test v2-explore.spec.ts
 *
 * The signed-in halves (my repos, the inbox, the key top-up) are in v2-inbox-topup.spec.ts,
 * gated on E2E_WRITE because signing in registers a key.
 */

test.skip(E2E_DEVNET === '', 'forge-v2 lives on a devnet; set E2E_DEVNET=moutai')

test('x1. explore lists recent repos and says what it cannot know', async ({ page }) => {
  const { errors } = collectPageErrors(page)
  await page.goto('/explore/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Explore', level: 1 })).toBeVisible()
  const recent = page.getByTestId('explore-recent-repos')
  await expect(recent.locator('a[href*="/repo"]').first()).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('trending-note')).toHaveText("Trending needs an indexer. Forge doesn't run one; you can (docs).")
  const released = page.getByTestId('explore-recently-released')
  await expect(released).toContainText('no cross-repo index')
  await expect(released.locator('[data-empty], li').first()).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(/sign in to see your repos/i)).toBeVisible()
  await shot(page, 'd-explore-signed-out')
  const serious = await runAxe(page, 'explore')
  expect(serious, serious.map((v) => `${v.id}: ${v.help}`).join('\n')).toEqual([])
  expect(errors, errors.join('\n')).toEqual([])
})

test('x2. the header: New menu, jump box, and the landing links Explore', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('link', { name: 'Explore' }).first()).toBeVisible()
  await page.getByRole('button', { name: 'New', exact: true }).click()
  const menu = page.getByRole('navigation', { name: 'New' })
  await expect(menu.getByRole('link', { name: /Repository/ })).toHaveAttribute('href', /\/new/)
  await expect(menu.getByRole('link', { name: /Mirror a GitHub repo/ })).toHaveAttribute('href', /mirror-a-github-repo\.md$/)
  await page.waitForTimeout(300)
  await shot(page, 'd-header-new-menu')
  await expect(page.getByRole('button', { name: 'New', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(page.getByRole('button', { name: 'New', exact: true })).toBeFocused()

  // #n outside a repo explains itself; owner/name jumps.
  const jump = page.getByLabel(/jump to a repo/i).first()
  await jump.fill('#1')
  await jump.press('Enter')
  await expect(page.getByRole('status').filter({ hasText: /inside a repo/ })).toBeVisible()
  await jump.fill('9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD/forge-v2-demo')
  await jump.press('Enter')
  await expect(page).toHaveURL(/\/repo\/?\?owner=9r27/)
})

test('x3. #n in a repo opens that issue', async ({ page }) => {
  await page.goto('/repo/?owner=9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD&name=forge-v2-demo', { waitUntil: 'domcontentloaded' })
  const jump = page.getByLabel(/jump to a repo/i).first()
  // The fixture has issue #1 and PR #1: both are offered.
  await jump.fill('#1')
  await jump.press('Enter')
  const note = page.getByRole('status').filter({ hasText: /#1 is both/ })
  await expect(note).toBeVisible({ timeout: 60_000 })
  await note.getByRole('link', { name: 'issue #1' }).click()
  await expect(page).toHaveURL(/\/repo\/issue\/?\?.*number=1/)
  // #3 is an issue only: straight there.
  await page.getByLabel(/jump to a repo/i).first().fill('#3')
  await page.getByLabel(/jump to a repo/i).first().press('Enter')
  await expect(page).toHaveURL(/\/repo\/issue\/?\?.*number=3/, { timeout: 60_000 })
})

test('x4. notifications, signed out, say what they are', async ({ page }) => {
  await page.goto('/notifications/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Notifications are computed in this browser from the chain. Nothing is sent to you; nothing leaves your device.', { exact: false })).toBeVisible()
  const serious = await runAxe(page, 'notifications-signed-out')
  expect(serious, serious.map((v) => `${v.id}: ${v.help}`).join('\n')).toEqual([])
})

test('x5. the header fits a 390 px phone', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  await page.goto('/explore/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Explore', level: 1 })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await expect(page.getByLabel(/jump to a repo/i).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'New', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^sign in$/i }).first()).toBeVisible()
  await page.getByRole('button', { name: 'New', exact: true }).click()
  await expect(page.getByRole('link', { name: /Mirror a GitHub repo/ })).toBeVisible()
  // The menu paints above the jump-box row: the point under its last item is the item.
  const item = page.getByRole('link', { name: /Mirror a GitHub repo/ })
  const box = await item.boundingBox()
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x ?? 0, y ?? 0)?.closest('a')?.textContent ?? '', [(box?.x ?? 0) + 20, (box?.y ?? 0) + 10])
  expect(hit).toContain('Mirror a GitHub repo')
  await page.getByTestId('explore-recent-repos').locator('a[href*="/repo"]').first().waitFor({ timeout: 60_000 })
  await page.waitForTimeout(300)
  await shot(page, 'd-header-mobile-390')
  const serious = await runAxe(page, 'header-mobile')
  expect(serious, serious.map((v) => `${v.id}: ${v.help}`).join('\n')).toEqual([])
  await context.close()
})
