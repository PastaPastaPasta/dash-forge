import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { test, expect, type Page } from '@playwright/test'

/**
 * A tap before the app hydrates is not lost (lib/prehydration.ts). The page's scripts are held
 * back until the test has clicked, so the click lands on the static HTML without its handler
 * every time (on a slow phone the window is a second or more). No devnet writes; the sign-in
 * sheet only has to open. Runs in Chromium and WebKit, on the static export.
 */

/** scripts/csp-hashes.mjs, an ES module (the specs are compiled to CommonJS). */
const cspHashes = (): Promise<typeof import('../scripts/csp-hashes.mjs')> => import(pathToFileURL(join(__dirname, '../scripts/csp-hashes.mjs')).href)

const CHUNKS = /\/_next\/static\/chunks\/.*\.js(\?|$)/

/** Hold every Next.js chunk until `release()`; the static HTML is served at once. */
async function holdScripts(page: Page): Promise<() => void> {
  let release!: () => void
  const released = new Promise<void>((r) => (release = r))
  await page.route(CHUNKS, async (route) => {
    await released
    await route.continue()
  })
  return release
}

/** Console errors that a Content-Security-Policy refusal produces (in Chromium and WebKit). */
function cspErrors(page: Page): string[] {
  const seen: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && /content security policy|refused to (execute|load)/i.test(m.text())) seen.push(m.text())
  })
  return seen
}

/** How many times the sign-in sheet opened (its dialog attached), counted in the page. */
async function countSheetOpens(page: Page): Promise<() => Promise<number>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __sheetOpens: number }
    w.__sheetOpens = 0
    new MutationObserver(() => {
      const open = [...document.querySelectorAll('[role=dialog]')].some((d) => /sign in to dash forge/i.test(d.textContent ?? ''))
      const was = (document.documentElement.dataset['sheetOpen'] ?? '') === '1'
      if (open && !was) w.__sheetOpens += 1
      document.documentElement.dataset['sheetOpen'] = open ? '1' : '0'
    }).observe(document, { childList: true, subtree: true })
  })
  return () => page.evaluate(() => (window as unknown as { __sheetOpens: number }).__sheetOpens)
}

/**
 * The header's sign-in button: before hydration the static page shows the session-check
 * placeholder, then "Sign in" (or "Unlock"); each carries the sign-in intent.
 */
const signInButton = (page: Page) => page.getByRole('banner').locator('button[data-replay="sign-in"]')
const sheet = (page: Page) => page.getByRole('dialog', { name: /sign in to dash forge/i })

/** Tap Sign in before hydration on `path`, then let the app load: the sheet opens exactly once. */
async function tapBeforeHydration(page: Page, path: string): Promise<void> {
  const opens = await countSheetOpens(page)
  const release = await holdScripts(page)
  await page.goto(path, { waitUntil: 'domcontentloaded' })
  const signIn = signInButton(page)
  await expect(signIn).toBeVisible()
  // The button itself is not hydrated: this is the click that used to be lost.
  expect(await signIn.evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps')))).toBe(false)
  // A finger taps what it sees: the placeholder is inert (aria-disabled), not disabled, so the tap lands.
  await signIn.click({ force: true })
  await expect(signIn).toHaveAttribute('data-prehydrate-pending', '')
  release()
  await expect(sheet(page)).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(1500)
  expect(await opens()).toBe(1)
  await expect(signInButton(page)).not.toHaveAttribute('data-prehydrate-pending', '')
}

test.describe('a tap before hydration', () => {
  test('the static export keeps JavaScript eval and unhashed inline scripts out of its CSP', async ({ page }) => {
    await page.goto('/start/', { waitUntil: 'load' })
    const policies = await page.locator('meta[http-equiv="Content-Security-Policy"]').evaluateAll((metas) => metas.map((m) => m.getAttribute('content') ?? ''))
    const scriptSrc = policies.map((p) => p.split(';').find((directive) => directive.trim().startsWith('script-src '))?.trim())
    // A browser enforces both: first the page's own inline scripts by hash (scripts/csp-hashes.mjs),
    // then the layout's policy, whose 'unsafe-inline' the first one overrules.
    expect(scriptSrc).toHaveLength(2)
    expect(scriptSrc[0]).toMatch(/^script-src 'self' 'wasm-unsafe-eval'( 'sha256-[A-Za-z0-9+/]{43}=')+$/)
    expect(scriptSrc[1]).toBe("script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'")
  })

  test('every exported page allows exactly its own inline scripts', async ({ request }) => {
    const { cspProblem } = await cspHashes()
    for (const path of ['/', '/start/', '/explore/', '/repo/', '/u/', '/settings/', '/404.html']) {
      const response = await request.get(path)
      expect(response.ok(), path).toBe(true)
      expect(cspProblem(await response.text(), path)).toBeNull()
    }
  })

  test('the head script runs under the page CSP (no refusal)', async ({ page }) => {
    const csp = cspErrors(page)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.goto('/explore/', { waitUntil: 'domcontentloaded' })
    expect(await page.evaluate((k) => typeof (window as unknown as Record<string, unknown>)[k], '__forgePrehydration')).toBe('object')
    await expect(signInButton(page)).toBeVisible()
    await page.waitForLoadState('load')
    // `frame-ancestors` in a <meta> CSP is only ignored with a console error: not a refusal. The
    // host's own analytics beacon (Cloudflare injects it on forge.dashhq.org) is refused by the
    // page CSP on purpose; it is not the app's.
    expect(csp.filter((t) => !/frame-ancestors/i.test(t) && !/static\.cloudflareinsights\.com/.test(t))).toEqual([])
    expect(errors).toEqual([])
  })

  test('Sign in on a static page opens the sheet once the app is ready', async ({ page }) => {
    await tapBeforeHydration(page, '/explore/')
  })

  // Query-string pages render their content on the client only; the header is outside that, in
  // the exported HTML, and hydrates with the page (where shared links land).
  test('Sign in on a repo page (?owner=&name=)', async ({ page }) => {
    await tapBeforeHydration(page, '/repo/?owner=2QAEbMtEUQJGra1Fv3XKH72VHSfhpME3vEBFS8sHNTwj&name=anything')
  })

  test('Sign in on a profile page (?name=)', async ({ page }) => {
    await tapBeforeHydration(page, '/u/?name=2QAEbMtEUQJGra1Fv3XKH72VHSfhpME3vEBFS8sHNTwj')
  })

  test('a button without an intent is not caught, and a tap after hydration works as before', async ({ page }) => {
    // The theme follows the OS until chosen (L-66): pin the OS to dark, so a toggle would show.
    await page.emulateMedia({ colorScheme: 'dark' })
    const release = await holdScripts(page)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    const theme = page.getByTestId('theme-toggle')
    await theme.click()
    await expect(theme).not.toHaveAttribute('aria-busy', 'true')
    release()
    // The theme was not toggled by anything: no intent was recorded for it.
    await expect(signInButton(page)).toBeVisible()
    await page.waitForLoadState('load')
    await expect(page.locator('html')).toHaveClass(/dark/)
    expect(await page.evaluate(() => localStorage.getItem('theme'))).toBeNull()
    await expect(sheet(page)).toBeHidden()
    // After hydration the catcher is gone: a normal click works directly.
    await expect.poll(() => signInButton(page).evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps'))), { timeout: 60_000 }).toBe(true)
    await signInButton(page).click()
    await expect(sheet(page)).toBeVisible()
  })

  test("a script the host injects, refused by the CSP, does not stop the catcher (forge.dashhq.org)", async ({ page }) => {
    // Cloudflare adds its analytics beacon to every page; the CSP refuses it, which fires a script
    // error before the app loads. The tap must still be caught and replayed.
    await page.route(/\/explore\/(\?.*)?$/, async (route) => {
      const res = await route.fetch()
      const html = (await res.text()).replace('</body>', '<script defer src="https://static.cloudflareinsights.com/beacon.min.js/v1"></script></body>')
      await route.fulfill({ response: res, body: html })
    })
    await tapBeforeHydration(page, '/explore/')
  })

  test('an inline script the host injects does not run; the page still hydrates', async ({ page }) => {
    // The refusals, counted from the page's own `securitypolicyviolation` events: every engine
    // fires them, while only Chromium also reports them to Playwright as console errors.
    await page.addInitScript(() => {
      const w = window as unknown as { __inlineRefused: number }
      w.__inlineRefused = 0
      document.addEventListener('securitypolicyviolation', (e) => {
        if (e.blockedURI === 'inline' && e.effectiveDirective.startsWith('script-src')) w.__inlineRefused += 1
      })
    })
    await page.route(/\/explore\/(\?.*)?$/, async (route) => {
      const res = await route.fetch()
      const html = (await res.text()).replace('</head>', '<script>window.__injected=1</script></head>').replace('</body>', '<script>window.__injected=2</script></body>')
      await route.fulfill({ response: res, body: html })
    })
    await page.goto('/explore/', { waitUntil: 'load' })
    await expect.poll(() => signInButton(page).evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps'))), { timeout: 60_000 }).toBe(true)
    expect(await page.evaluate(() => (window as unknown as { __injected?: number }).__injected)).toBeUndefined()
    expect(await page.evaluate(() => (window as unknown as { __inlineRefused: number }).__inlineRefused)).toBeGreaterThanOrEqual(2)
  })

  test('a script that fails to load clears the busy look (not only the timer)', async ({ page }) => {
    // Hold the chunks, tap, then fail them: the tap is caught first, the error clears it.
    let fail!: () => void
    const failed = new Promise<void>((r) => (fail = r))
    await page.route(CHUNKS, async (route) => {
      await failed
      await route.abort()
    })
    await page.goto('/explore/', { waitUntil: 'domcontentloaded' })
    const signIn = signInButton(page)
    await signIn.click({ force: true })
    await expect(signIn).toHaveAttribute('data-prehydrate-pending', '')
    fail()
    // Well inside the 12 s timer: it is the load error that stops the catcher, and the button's
    // own busy state (the session check) is what remains.
    await expect(signIn).not.toHaveAttribute('data-prehydrate-pending', '', { timeout: 3_000 })
    expect(await signIn.getAttribute('aria-busy')).toBe('true')
  })

  test('a link is never caught: it navigates on its own', async ({ page }) => {
    const release = await holdScripts(page)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.getByRole('main').getByRole('link', { name: /explore/i }).first().click()
    release()
    await page.waitForURL(/\/explore\/?$/, { timeout: 60_000 })
  })
})
