import { test, expect, type Page } from '@playwright/test'
import { shot } from './helpers'

/**
 * A first visit on a bad link (mainnet QA 2026-11-24, "Cold load, Fast/Slow 3G"): the home page
 * downloads the 26.5 MB Platform verifier (9 MB gzipped) before it can read anything. Read-only,
 * no fixture needed.
 *
 *  - cl-1 The connection is gone when the download starts: the page says "You're offline" (not
 *    that Platform or the quorum key service is down), and once the connection is back the
 *    download starts again and the page connects, with no reload.
 *  - cl-2 The download receives nothing: the download view says it stalled, and the download
 *    starts again by itself and finishes.
 */

const WASM = /\.wasm$/

/** The live connection's generation (`lib/sdk/service.ts` sets it on each connect). */
const generation = (page: Page): Promise<number> =>
  page.evaluate(() => Number(document.documentElement.dataset['sdkGeneration'] ?? 0))

test.describe('cold load on a bad link', () => {
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('cl-1. offline when the verifier download starts: says so, then loads once back online', async ({ page, context }) => {
    test.setTimeout(4 * 60_000)
    let offline = true
    let wasmDone = 0
    page.on('requestfinished', (r) => {
      if (WASM.test(r.url())) wasmDone++
    })
    await page.route(WASM, async (route) => {
      if (!offline) return route.continue()
      await context.setOffline(true)
      return route.abort('internetdisconnected')
    })
    await page.goto('/')
    // Set once, read after the connection is back: the recovery must not reload the page.
    await page.evaluate(() => ((window as unknown as { coldLoadMarker: number }).coldLoadMarker = 1))

    await expect(page.getByText("You're offline").first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/Can't reach|quorum key service/)).toHaveCount(0)
    // No countdown that would fire into a dead network.
    await expect(page.getByText(/Trying again in/)).toHaveCount(0)
    await shot(page, 'cl-1-offline')

    offline = false
    await context.setOffline(false)
    await expect.poll(() => generation(page), { timeout: 3 * 60_000 }).toBeGreaterThan(0)
    expect(wasmDone).toBeGreaterThan(0)
    await expect(page.getByText("You're offline")).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { coldLoadMarker?: number }).coldLoadMarker)).toBe(1)
  })

  test('cl-2. a download that receives nothing: says it stalled, then starts again by itself', async ({ page }) => {
    test.setTimeout(4 * 60_000)
    let requests = 0
    await page.route(WASM, (route) => {
      // The first request never answers; the download's own stall timer gives up and retries.
      if (requests++ === 0) return new Promise<void>(() => undefined)
      return route.continue()
    })
    await page.goto('/')

    await expect(page.getByRole('progressbar', { name: /Platform verifier download/ })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('sdk-download-note')).toHaveText(/^The download has stalled\. Check your connection/, { timeout: 30_000 })
    await shot(page, 'cl-2-stalled')

    await expect.poll(() => generation(page), { timeout: 3 * 60_000 }).toBeGreaterThan(0)
    expect(requests).toBeGreaterThanOrEqual(2)
  })
})
