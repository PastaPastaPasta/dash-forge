import { test, expect, type Page } from '@playwright/test'

/**
 * A tap before the app hydrates is not lost (lib/prehydration.ts). The page's scripts are held
 * back until the test has clicked, so the click lands on the static HTML without its handler
 * every time (on a slow phone the window is a second or more). No devnet writes; the sign-in
 * sheet only has to open.
 */

/** Hold every Next.js chunk until `release()`; the static HTML is served at once. */
async function holdScripts(page: Page): Promise<() => void> {
  let release!: () => void
  const released = new Promise<void>((r) => (release = r))
  await page.route(/\/_next\/static\/chunks\/.*\.js$/, async (route) => {
    await released
    await route.continue()
  })
  return release
}

/** Whether React has attached its handlers to `selector`'s element. */
async function hydrated(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).first().evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps')))
}

test.describe('a tap before hydration', () => {
  test('Sign in in the header opens the sign-in sheet once the app is ready', async ({ page }) => {
    const release = await holdScripts(page)
    await page.goto('/explore/', { waitUntil: 'domcontentloaded' })
    const signIn = page.getByRole('banner').getByRole('button', { name: /^sign in$/i })
    await expect(signIn).toBeVisible()
    // Not hydrated: this is the click that used to be lost.
    expect(await hydrated(page, 'header button')).toBe(false)
    await signIn.click()
    // It is kept and shown as pending until the app can act on it.
    await expect(signIn).toHaveAttribute('aria-busy', 'true')
    release()
    await expect(page.getByRole('dialog', { name: /sign in to dash forge/i })).toBeVisible({ timeout: 60_000 })
    await expect(signIn).not.toHaveAttribute('aria-busy', 'true')
  })

  test('only the newest tap is replayed, and a tap after hydration works as before', async ({ page }) => {
    const release = await holdScripts(page)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    // The theme toggle, then Sign in: only Sign in (the newest) is replayed.
    const theme = page.getByTestId('theme-toggle')
    const signIn = page.getByRole('banner').getByRole('button', { name: /^sign in$/i })
    await theme.click()
    await signIn.click()
    await expect(theme).not.toHaveAttribute('aria-busy', 'true')
    await expect(signIn).toHaveAttribute('aria-busy', 'true')
    release()
    const dialog = page.getByRole('dialog', { name: /sign in to dash forge/i })
    await expect(dialog).toBeVisible({ timeout: 60_000 })
    // The theme was not toggled by the replay.
    await expect(page.locator('html')).toHaveClass(/dark/)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    // After hydration the catcher is gone: a normal click works directly.
    await signIn.click()
    await expect(dialog).toBeVisible()
  })

  test('a link is never caught: it navigates on its own', async ({ page }) => {
    const release = await holdScripts(page)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.getByRole('main').getByRole('link', { name: /explore/i }).first().click()
    release()
    await page.waitForURL(/\/explore\/?$/, { timeout: 60_000 })
  })
})
