import { test, expect, type Page } from '@playwright/test'
import { expectLanded, repoUrl } from './helpers'

/**
 * Keyboard access and theming (D-046 / D-047): the skip link, `/` to search, modal focus
 * (trapped while open, returned on close, landing on the autoFocus field), and the
 * dark / light / system theme — applied before first paint, persisted, and honoured.
 */

/** Where focus is: a short description, and whether it is inside the open modal. */
async function focusInfo(page: Page): Promise<{ desc: string; inDialog: boolean }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    const dialog = document.querySelector('[aria-modal="true"]')
    return {
      desc: el ? `${el.tagName}:${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}` : 'none',
      inDialog: dialog !== null && el !== null && dialog.contains(el),
    }
  })
}

test.describe('keyboard', () => {
  test('the first Tab stop is a skip link that moves focus to the page content', async ({ page, browserName }) => {
    await page.goto('/explore/', { waitUntil: 'domcontentloaded' })
    // Safari's Tab reaches only form fields unless the user turns on "Press Tab to highlight
    // each item"; Option+Tab reaches links (and so the skip link) either way.
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab')
    const skip = page.getByRole('link', { name: 'Skip to content' })
    await expect(skip).toBeFocused()
    await expect(skip).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.locator('main#main')).toBeFocused()
  })

  test('"/" focuses the jump box, but not while typing in a field', async ({ page }) => {
    await page.goto('/explore/', { waitUntil: 'domcontentloaded' })
    await page.locator('body').click({ position: { x: 5, y: 300 } })
    await page.keyboard.press('/')
    const box = page.locator('input[data-jump-box]:visible')
    await expect(box).toBeFocused()
    await page.keyboard.type('a/b')
    await expect(box).toHaveValue('a/b')
    await page.keyboard.press('Escape')
    await expect(box).not.toBeFocused()
  })

  test('the sign-in modal traps Tab and Shift+Tab, and returns focus to its trigger', async ({ page }) => {
    await page.goto('/explore/', { waitUntil: 'domcontentloaded' })
    const trigger = page.getByRole('banner').getByRole('button', { name: 'Sign in' })
    await trigger.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Sign in to Dash Forge' })
    await expect(dialog).toBeVisible()
    expect((await focusInfo(page)).inDialog).toBe(true)
    // Far more stops than the dialog has: focus must never reach the page behind.
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab')
      const f = await focusInfo(page)
      expect(f.inDialog, `Tab ${i + 1} left the dialog for ${f.desc}`).toBe(true)
    }
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Shift+Tab')
      const f = await focusInfo(page)
      expect(f.inDialog, `Shift+Tab ${i + 1} left the dialog for ${f.desc}`).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(trigger).toBeFocused()
  })

  test('a repo-page dialog traps focus and restores it', async ({ page }) => {
    await page.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
    const trigger = page.getByTestId('clone-box').getByRole('button', { name: /install/i }).first()
    await expectLanded(page, trigger, 60_000)
    await trigger.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: /Install git-remote-dash/ })
    await expect(dialog).toBeVisible()
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Tab')
      expect((await focusInfo(page)).inDialog).toBe(true)
    }
    await dialog.getByRole('button', { name: 'Close dialog' }).click()
    await expect(dialog).toBeHidden()
    await expect(trigger).toBeFocused()
  })
})

test.describe('theme', () => {
  const htmlClass = (page: Page): Promise<string> => page.evaluate(() => document.documentElement.className)

  test('a first visit follows the OS: light when it prefers light, dark when it prefers dark (L-66)', async ({ browser }) => {
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({ colorScheme: scheme })
      const page = await context.newPage()
      await page.goto('/explore/', { waitUntil: 'domcontentloaded' })
      await expect(page.getByTestId('theme-toggle')).toHaveAttribute('data-theme-choice', 'system')
      await expect.poll(() => htmlClass(page)).toContain(scheme)
      expect(await htmlClass(page)).not.toContain(scheme === 'light' ? 'dark' : 'light')
      await context.close()
    }
  })

  test('the toggle cycles system → dark → light, persists, and survives a reload', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/explore/', { waitUntil: 'domcontentloaded' })
    const toggle = page.getByTestId('theme-toggle')
    await expect(toggle).toHaveAttribute('data-theme-choice', 'system')
    expect(await htmlClass(page)).toContain('light')

    await toggle.click()
    await expect(toggle).toHaveAttribute('data-theme-choice', 'dark')
    expect(await htmlClass(page)).toContain('dark')
    expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('dark')

    await toggle.click()
    await expect(toggle).toHaveAttribute('data-theme-choice', 'light')
    expect(await htmlClass(page)).toContain('light')
    expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('light')
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(bg).toBe('rgb(250, 250, 249)') // anvil-50: really rendered light

    // The explicit choice wins over the OS, across a reload.
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('theme-toggle')).toHaveAttribute('data-theme-choice', 'light')
    expect(await htmlClass(page)).toContain('light')

    // Back to System: follows the OS preference, live.
    await page.getByTestId('theme-toggle').click()
    await expect(page.getByTestId('theme-toggle')).toHaveAttribute('data-theme-choice', 'system')
    await expect.poll(() => htmlClass(page)).toContain('dark')
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => htmlClass(page)).toContain('light')
  })

  test('a stored light theme is applied before first paint (no flash of dark)', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('theme', 'light'))
    // Record the <html> class the moment the parser inserts the first painted element (the
    // header), before hydration or any bundle runs: only next-themes' inline script can have set it.
    await page.addInitScript(() => {
      const w = window as unknown as { __firstClass?: string }
      new MutationObserver((_, obs) => {
        if (document.querySelector('header')) {
          w.__firstClass = document.documentElement.className
          obs.disconnect()
        }
      }).observe(document, { childList: true, subtree: true })
    })
    await page.goto('/explore/', { waitUntil: 'domcontentloaded' })
    const first = await page.evaluate(() => (window as unknown as { __firstClass?: string }).__firstClass ?? '')
    expect(first).toContain('light')
    expect(first).not.toContain('dark')
  })

  test('the color-blind diff palette recolors the changed-file letters and line markers', async ({ page }) => {
    await page.addInitScript(() =>
      localStorage.setItem('forge.prefs.v1', JSON.stringify({ diffLayout: 'unified', ignoreWhitespace: false, palette: 'colorblind' })),
    )
    // The fixture's second commit on main adds files (A letters) and changes others.
    await page.goto(repoUrl('commit', '&oid=b35c50122cd51b2cc0345760721e6398fa0c31f5'), { waitUntil: 'domcontentloaded' })
    const marker = page.locator('td span.text-blue-700, td span.text-orange-800').first()
    await expectLanded(page, marker, 60_000)
    // The A / D letters of the changed-file list and the file headers follow the palette too.
    const letters = page.locator('span[title="added"], span[title="deleted"]')
    await expect(letters.first()).toBeVisible()
    for (const cls of await letters.evaluateAll((els) => els.map((e) => e.className))) {
      expect(cls).toMatch(/text-(blue-700|orange-800)/)
      expect(cls).not.toMatch(/text-(green|red)-/)
    }
  })
})
