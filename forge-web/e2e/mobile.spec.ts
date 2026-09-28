import { test, expect, devices, type Browser, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { PASSPHRASE, expectLanded, repoUrl, waitForRepoResolved } from './helpers'

/**
 * Phones and tablets, on the forge-v2 read fixture (e2e/helpers.ts `DEMO`; read only).
 *
 *   E2E_DEVNET=moutai pnpm exec playwright test --project=mobile                         # Chromium
 *   E2E_DEVNET=moutai E2E_ALL_ENGINES=1 pnpm exec playwright test --project=mobile-webkit   # WebKit
 *   E2E_DEVNET=moutai E2E_ALL_ENGINES=1 pnpm exec playwright test --project=mobile-firefox  # Firefox
 *
 * On iPhone SE (375×667), Pixel 7 and iPad Mini, a representative set of routes, each checked
 * once its real content has landed: nothing wider than the screen, every visible control at
 * least 44×44 CSS px to tap (WCAG 2.5.5; inline links inside prose are exempt, WCAG 2.5.8), and
 * the repo tabs reachable. The PR page shows a unified diff on a phone even with a saved "split"
 * preference. Signed in with a low balance (E2E_MOBILE_LOW_ID, an identity file minted with
 * < 0.01 DASH), the phone header shows the funds cue and the low-balance banner names the fix.
 */

const DEVICES = {
  'iPhone SE': devices['iPhone SE (3rd gen)'],
  'Pixel 7': devices['Pixel 7'],
  'iPad Mini': devices['iPad Mini'],
} as const
type DeviceName = keyof typeof DEVICES

/** A device's context options for this project's engine (Firefox has no `isMobile`). */
function contextFor(device: DeviceName, browserName: string, theme: 'dark' | 'light' = 'dark'): Parameters<Browser['newContext']>[0] {
  const { defaultBrowserType: _engine, ...d } = DEVICES[device]
  const opts: Record<string, unknown> = { ...d, colorScheme: theme }
  if (browserName === 'firefox') delete opts['isMobile']
  return opts
}

const ROUTES: [label: string, href: string, ready: (page: Page) => ReturnType<Page['getByRole']>][] = [
  ['repo', repoUrl(), (page) => page.getByRole('link', { name: 'README.md' }).first()],
  ['tree', repoUrl('tree', '&path=src'), (page) => page.getByRole('link', { name: 'main.rs' }).first()],
  // F-5: the file view with a selected range (permalink, Raw, the line numbers exempt as code lines).
  ['blob', `${repoUrl('blob', '&path=src/main.rs')}#L2-L3`, (page) => page.getByTestId('copy-permalink')],
  ['history', repoUrl('commits', '&path=src/main.rs'), (page) => page.getByTestId('commit-row').first()],
  ['blame', repoUrl('blame', '&path=src/main.rs'), (page) => page.getByTestId('blame-table')],
  ['commits', repoUrl('commits'), (page) => page.getByRole('link', { name: 'Initial import' }).first()],
  ['issues', repoUrl('issues'), (page) => page.getByRole('link', { name: 'README should explain the event split' })],
  ['pull', repoUrl('pull', '&number=3&tab=files'), (page) => page.getByRole('heading', { name: /Files changed/ })],
  ['explore', '/explore/', (page) => page.getByRole('heading', { name: 'Explore' })],
  ['repo settings', repoUrl('settings'), (page) => page.getByRole('navigation', { name: 'Settings sections' })],
]

/** Every visible control smaller than 44×44 (its ::after hit area counts), minus the exemptions. */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>('a[href], button, input:not([type=hidden]), select, textarea, [role=button], summary')) {
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none') continue
      const b = el.getBoundingClientRect()
      if (b.width < 2 || b.height < 2) continue // sr-only
      if (el.closest('[aria-hidden="true"], [inert], [data-tap-exempt]')) continue
      // A checkbox or radio inside its label: the label is what a finger taps.
      const label = el instanceof HTMLInputElement && /^(checkbox|radio)$/.test(el.type) ? el.closest('label') : null
      if (label) {
        const lb = label.getBoundingClientRect()
        if (lb.width >= 43.5 && lb.height >= 43.5) continue
      }
      // The tap box: the element, grown by an absolute ::after hit area (centred), then clipped
      // by every ancestor that hides overflow (a clipped hit area is not a bigger target).
      let { left, right, top, bottom } = b
      const after = getComputedStyle(el, '::after')
      if (after.position === 'absolute' && after.content !== 'none' && after.content !== 'normal') {
        const aw = parseFloat(after.width) || 0
        const ah = parseFloat(after.height) || 0
        const cx = (left + right) / 2
        const cy = (top + bottom) / 2
        left = Math.min(left, cx - aw / 2)
        right = Math.max(right, cx + aw / 2)
        top = Math.min(top, cy - ah / 2)
        bottom = Math.max(bottom, cy + ah / 2)
      }
      // (Only hidden/clip: a scroller's content that is out of view is reachable by scrolling.)
      const clips = (v: string): boolean => v === 'hidden' || v === 'clip'
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const s = getComputedStyle(p)
        const r = p.getBoundingClientRect()
        if (clips(s.overflowX)) {
          left = Math.max(left, r.left)
          right = Math.min(right, r.right)
        }
        if (clips(s.overflowY)) {
          top = Math.max(top, r.top)
          bottom = Math.min(bottom, r.bottom)
        }
      }
      const w = right - left
      const h = bottom - top
      if (w < 43.5 || h < 43.5) {
        const name = (el.getAttribute('aria-label') || el.innerText || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40)
        out.push(`${el.tagName.toLowerCase()} "${name}" ${Math.round(w)}×${Math.round(h)}`)
      }
    }
    return out
  })
}

const overflowX = (page: Page): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)

for (const device of Object.keys(DEVICES) as DeviceName[]) {
  test.describe(device, () => {
    for (const [label, href, ready] of ROUTES) {
      test(`${label}: fits the screen, every control is 44 px to tap`, async ({ browser, browserName }) => {
        const context = await browser.newContext(contextFor(device, browserName))
        const page = await context.newPage()
        await page.goto(href, { waitUntil: 'domcontentloaded' })
        await expectLanded(page, ready(page), 60_000)
        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'a touch device').toBe(true)
        expect(await overflowX(page), 'nothing wider than the screen').toBeLessThanOrEqual(1)
        expect(await smallTargets(page)).toEqual([])
        await context.close()
      })
    }
  })
}

test('iPhone SE: every repo tab is reachable, the strip scrolls with a visible edge', async ({ browser, browserName }) => {
  const context = await browser.newContext(contextFor('iPhone SE', browserName))
  const page = await context.newPage()
  await page.goto(repoUrl('releases'), { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page)
  const nav = page.getByRole('navigation', { name: 'Repository' })
  await expect(nav.getByRole('link', { name: 'Releases' })).toHaveAttribute('aria-current', 'page')
  // The active tab (the last one) was scrolled into view, inside the screen.
  const box = await nav.getByRole('link', { name: 'Releases' }).boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x + box!.width).toBeLessThanOrEqual(375 + 1)
  // More tabs on the left now: the strip marks that side.
  await expect(nav.locator('..')).toHaveAttribute('data-more', /left/)
  // Every tab can be tapped.
  for (const name of ['Code', /^Issues/, /^Pull requests/, 'Releases']) {
    const tab = nav.getByRole('link', { name })
    await tab.scrollIntoViewIfNeeded()
    const b = await tab.boundingBox()
    expect(b && b.x >= -1 && b.x + b.width <= 376, `tab ${name} on screen`).toBe(true)
    expect(b!.height).toBeGreaterThanOrEqual(43.5)
  }
  expect(await overflowX(page)).toBeLessThanOrEqual(1)
  await context.close()
})

test('iPhone SE: Platform unreachable: the banner fits, Try again and Details are 44 px', async ({ browser, browserName }) => {
  const context = await browser.newContext(contextFor('iPhone SE', browserName))
  // Every Platform endpoint refuses (the quorum service and every DAPI node): nothing is sent.
  await context.route(
    (url) => /^quorums\.[a-z0-9-]+\.networks\.dash\.org$/.test(url.hostname) || url.port === '1443',
    (r) => r.abort('connectionrefused'),
  )
  const page = await context.newPage()
  await page.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
  const banner = page.getByTestId('platform-unreachable')
  await expect(banner).toBeVisible({ timeout: 90_000 })
  const retry = banner.getByRole('button', { name: 'Try again' })
  const b = await retry.boundingBox()
  expect(b!.height).toBeGreaterThanOrEqual(43.5)
  expect(b!.x + b!.width).toBeLessThanOrEqual(375 + 1)
  expect(await overflowX(page)).toBeLessThanOrEqual(1)
  expect(await smallTargets(page)).toEqual([])
  await context.close()
})

test('Pixel 7: the PR diff is unified even with a saved split preference', async ({ browser, browserName }) => {
  const context = await browser.newContext(contextFor('Pixel 7', browserName))
  await context.addInitScript(() =>
    localStorage.setItem('forge.prefs.v1', JSON.stringify({ diffLayout: 'split', ignoreWhitespace: false, palette: 'standard' })),
  )
  const page = await context.newPage()
  await page.goto(repoUrl('pull', '&number=3&tab=files'), { waitUntil: 'domcontentloaded' })
  await expectLanded(page, page.locator('table[data-layout]').first(), 60_000)
  await expect(page.locator('table[data-layout="split"]')).toHaveCount(0)
  await expect(page.locator('table[data-layout="unified"]').first()).toBeVisible()
  // No Split/Unified switch on a phone: the choice would not apply.
  await expect(page.getByRole('toolbar', { name: 'Diff display' }).getByRole('button', { name: 'Split' })).toHaveCount(0)
  // The review's inline thread stays within the screen.
  const thread = page.getByTestId('inline-thread').first()
  if (await thread.count()) {
    const b = await thread.boundingBox()
    expect(b!.x + b!.width).toBeLessThanOrEqual(412 + 1)
  }
  expect(await overflowX(page)).toBeLessThanOrEqual(1)
  await context.close()
})

/**
 * An identity file minted with a balance under 0.01 DASH (the low state), for the funds cue.
 * Each run registers a limited key on it (~0.00027 DASH), which keeps it low.
 */
const LOW_ID_FILE = process.env['E2E_MOBILE_LOW_ID'] ?? ''

test.describe('signed in with a low balance', () => {
  test.skip(process.env['E2E_WRITE'] !== '1' || LOW_ID_FILE === '' || !existsSync(LOW_ID_FILE), 'registers a key (a live write): set E2E_WRITE=1 and E2E_MOBILE_LOW_ID')
  test.describe.configure({ timeout: 5 * 60_000 })

  for (const theme of ['dark', 'light'] as const) {
    test(`iPhone SE (${theme}): the header shows the low-funds cue and the banner names the fix`, async ({ browser, browserName }) => {
      const context = await browser.newContext(contextFor('iPhone SE', browserName, theme))
      await context.addInitScript((t) => localStorage.setItem('theme', t), theme)
      const page = await context.newPage()
      await page.goto('/', { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /^sign in$/i }).first().click()
      await page.getByTestId('tile-import').click()
      await page.setInputFiles('input[type="file"]', { name: 'id.json', mimeType: 'application/json', buffer: readFileSync(LOW_ID_FILE) })
      await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
      await page.getByLabel('Repeat passphrase').fill(PASSPHRASE)
      await page.getByRole('button', { name: /create this browser's key/i }).click()

      const pill = page.getByTestId('funds-pill')
      await expect(pill).toBeVisible({ timeout: 120_000 })
      expect(await page.evaluate(() => document.documentElement.className)).toContain(theme)
      await expect(pill).toHaveAttribute('data-level', 'low')
      const box = await pill.boundingBox()
      expect(box!.width).toBeGreaterThanOrEqual(43.5)
      expect(box!.height).toBeGreaterThanOrEqual(43.5)

      const banner = page.getByTestId('low-funds-banner')
      await expect(banner).toBeVisible()
      await expect(banner).toContainText('under 0.01 DASH')
      await expect(banner.getByRole('button', { name: 'Top up' })).toBeVisible()
      expect(await overflowX(page)).toBeLessThanOrEqual(1)

      // The cue opens the top-up sheet; the banner, dismissed, stays gone for the session.
      await pill.click()
      await expect(page.getByRole('dialog', { name: 'Top up credits' })).toBeVisible()
      await page.keyboard.press('Escape')
      await banner.getByRole('button', { name: 'Dismiss for this session' }).click()
      await expect(banner).toHaveCount(0)
      // Navigate in the app.
      await page.getByRole('link', { name: 'Explore' }).last().click()
      await expect(page.getByRole('heading', { name: 'Explore' })).toBeVisible()
      await expect(pill).toBeVisible()
      await expect(page.getByTestId('low-funds-banner')).toHaveCount(0)
      await context.close()
    })
  }
})
