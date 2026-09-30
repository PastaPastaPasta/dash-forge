import { test, expect, type Page, type Route } from '@playwright/test'
import { existsSync } from 'node:fs'
import { DEMO, EMPTY, collectPageErrors, idFile, repoUrl, shot, signedIn, unlock } from './helpers'

/**
 * Network resilience, against the moutai read fixture (e2e/helpers.ts `DEMO`):
 *
 *   E2E_DEVNET=bonsia pnpm exec playwright test network-resilience.spec.ts
 *
 *  - nr-1 (D-025) Slow 3G: the shell paints fast, the SDK download shows progress, and it
 *    completes instead of dying at a chunk-load timeout. The SDK's JS chunk stays small; the
 *    wasm is its own request.
 *  - nr-2 (D-058) The quorum service is down at connect: a plain-language banner with Try again,
 *    never the raw error page and never content marked verified; once the service is back,
 *    Try again reconnects and the repo renders.
 *  - nr-3 (D-702) Every Platform endpoint goes away mid-session, then comes back: Try again
 *    recovers without a reload. (A regression guard: `banFailedAddress: false` from the rate
 *    budget already fixed the ban half; this keeps the reconnect path from reintroducing it.)
 *  - nr-4 (D-024) The quorum list the SDK prefetched goes stale (a rotation): the first read
 *    fails with "Quorum not found in cache", the service reconnects once, and the read succeeds.
 *  - nr-5 (#80 review H1) Three repos are opened while the 5-minute refresh is in flight: the
 *    refresh still goes live, the app never reads "Can't reach Platform", and the next refresh
 *    is scheduled (before the fix a mount naming contracts dropped the refresh and stopped
 *    them for good).
 *  - nr-6 (#80 review M1, S1) A real write right after a forced refresh lands. Spends a little
 *    (one repo create) as a freshly minted identity:
 *      E2E_WRITE=1 E2E_IDENTITY_DIR=<dir with NRWRITER.identity.json> …
 */

const QUORUMS = /^https:\/\/quorums\.[a-z0-9-]+\.networks\.dash\.org\//
const README = (page: Page) => page.getByRole('link', { name: 'README.md' }).first()
const BANNER = (page: Page) => page.getByTestId('platform-unreachable')

/** The service's refresh period (lib/sdk/service.ts REFRESH_MS). */
const REFRESH_MS = 5 * 60_000

/** Navigate inside the app (no reload: the SDK connection and its state survive). */
async function navigate(page: Page, url: string): Promise<void> {
  await page.evaluate((u) => (window as unknown as { next: { router: { push(u: string): void } } }).next.router.push(u), url)
}

/** Let the quorum service answer, or fail it. Returns a switch. */
async function quorumSwitch(page: Page): Promise<{ down: boolean; hits: number }> {
  const state = { down: true, hits: 0 }
  await page.context().route(QUORUMS, (route: Route) => {
    state.hits++
    return state.down ? route.abort('connectionrefused') : route.continue()
  })
  return state
}

test.describe('network resilience', () => {
  test('nr-1. Slow 3G: shell first, SDK download with progress, no chunk timeout', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'network throttling goes through the DevTools protocol, which only Chromium has')
    test.setTimeout(8 * 60_000)
    const { errors } = collectPageErrors(page)
    const cdp = await context.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
    // DevTools' Slow 3G: 400 kbps, 400 ms. The static server gzips like GitHub Pages, so the
    // bytes are the real site's: ~8 MB of wasm, ~3 minutes on this link.
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 400,
      downloadThroughput: (400 * 1000) / 8,
      uploadThroughput: (400 * 1000) / 8,
    })
    const sdkRequests: { url: string; failed?: string }[] = []
    page.on('requestfinished', (r) => { if (/evo-sdk|\.wasm/.test(r.url())) sdkRequests.push({ url: r.url() }) })
    page.on('requestfailed', (r) => { if (/evo-sdk|\.wasm/.test(r.url())) sdkRequests.push({ url: r.url(), failed: r.failure()?.errorText }) })

    const t0 = Date.now()
    await page.goto(repoUrl(), { waitUntil: 'commit' })
    // Budget 1: the app shell (header + loading state) paints within 20 s on Slow 3G.
    await expect(page.locator('header').first()).toBeVisible({ timeout: 20_000 })
    const shellMs = Date.now() - t0
    // Budget 2: download progress is on screen while the SDK loads, and it advances.
    const bar = page.getByRole('progressbar', { name: /Platform verifier download/ })
    await expect(bar).toBeVisible({ timeout: 60_000 })
    // L-54: the repo's name and tabs are there while the SDK still downloads (from the address).
    const shell = page.getByTestId('repo-shell-header')
    await expect(shell).toContainText(DEMO.name)
    await expect(shell.getByRole('link', { name: 'Issues' })).toBeVisible()
    const first = Number(await bar.getAttribute('aria-valuenow'))
    await expect.poll(async () => Number(await bar.getAttribute('aria-valuenow')), { timeout: 60_000 }).toBeGreaterThan(first)
    await shot(page, 'nr-1-slow3g-progress')
    // Budget 3: the repo renders within 5 minutes; it never ends in a chunk-load error (before
    // this fix every repo page died at ~130 s with "Loading chunk … failed (timeout)").
    await expect(README(page).or(page.getByText(/Loading chunk .* failed/))).toBeVisible({ timeout: 5 * 60_000 })
    await expect(README(page)).toBeVisible()
    const contentMs = Date.now() - t0
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })

    expect(sdkRequests.filter((r) => r.failed)).toEqual([])
    expect(sdkRequests.some((r) => /\.wasm$/.test(r.url))).toBe(true)
    // eslint-disable-next-line no-console
    console.log(`[nr-1] shell ${shellMs} ms, repo content ${contentMs} ms`)
    expect(errors).toEqual([])
  })

  test('nr-2. quorum service down at connect: banner + Try again, then recovery', async ({ page }) => {
    const quorum = await quorumSwitch(page)
    await page.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
    await expect(BANNER(page)).toBeVisible({ timeout: 60_000 })
    // It names the quorum key service, not Platform: DAPI is up (QW-056).
    await expect(BANNER(page)).toContainText("Can't reach the quorum key service right now")
    await expect(BANNER(page)).not.toContainText("Can't reach Dash Platform")
    await expect(BANNER(page)).toContainText(/Trying again in \d+ s/)
    // The alert announces the outage once; the per-second countdown sits outside it (M5).
    await expect(BANNER(page).getByRole('alert')).toContainText("Can't reach the quorum key service right now")
    await expect(BANNER(page).getByRole('alert')).not.toContainText(/Trying again in/)
    // The raw error is behind a disclosure, not the page.
    await expect(page.getByText('Could not reach Platform', { exact: true })).toHaveCount(0)
    // Fail closed: nothing reads as verified.
    await expect(page.getByText(/^Verified/)).toHaveCount(0)
    await shot(page, 'nr-2-quorum-down-banner')

    // Page mounts do not hammer: another route mounting inside the gap adds no attempt.
    const hitsAfterBanner = quorum.hits
    await page.waitForTimeout(1500)
    expect(quorum.hits).toBe(hitsAfterBanner)

    quorum.down = false
    await BANNER(page).getByRole('button', { name: 'Try again' }).click()
    await expect(README(page)).toBeVisible({ timeout: 60_000 })
    await expect(BANNER(page)).toHaveCount(0)
    await shot(page, 'nr-2-recovered')
  })

  test('nr-3. a full Platform outage mid-session: Try again recovers once it is back (D-702)', async ({ page }) => {
    await page.goto(repoUrl('issues'), { waitUntil: 'domcontentloaded' })
    const issue = page.getByRole('link', { name: /README should explain/ }).first()
    await expect(issue).toBeVisible({ timeout: 60_000 })
    // Every Platform endpoint refuses: the quorum service and all DAPI nodes.
    let blocked = true
    await page.context().route(
      (url) => QUORUMS.test(url.href) || url.port === '1443',
      (r) => (blocked ? r.abort('connectionrefused') : r.continue()),
    )
    // An issue page this tab has not read: it has to ask Platform.
    await issue.click()
    const retry = page.getByRole('button', { name: 'Try again' }).first()
    await expect(retry).toBeVisible({ timeout: 90_000 })
    // Nothing read before the outage is presented as verified while Platform is away (M4).
    await expect(page.getByText(/^Verified/)).toHaveCount(0)
    await shot(page, 'nr-3-outage')
    // Before the fix the SDK kept every node banned: Try again showed "no available
    // addresses" until a full reload.
    blocked = false
    await retry.click()
    await expect(page.getByText('The README does').first()).toBeVisible({ timeout: 60_000 })
    await shot(page, 'nr-3-recovered')
  })

  test('nr-4. a stale quorum list: one reconnect, then the read succeeds (D-024)', async ({ page }) => {
    const { errors } = collectPageErrors(page)
    let served = 0
    // The first connect gets a quorum list with every key removed, as if the list had been
    // fetched before a rotation: the prefetch succeeds, the first proof names a quorum the
    // SDK does not have. Later fetches (the reconnect) get the real list.
    await page.context().route(QUORUMS, async (route) => {
      served++
      if (served > 2) return route.continue()
      const response = await route.fetch()
      const json = (await response.json()) as { data: unknown }
      const data = Array.isArray(json.data) ? [] : { ...(json.data as object), quorums: [] }
      return route.fulfill({ response, json: { ...json, data } })
    })
    const quorumErrors: string[] = []
    page.on('console', (m) => { if (/Quorum not found in cache/.test(m.text())) quorumErrors.push(m.text()) })
    await page.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
    await expect(README(page)).toBeVisible({ timeout: 90_000 })
    // The first connect's two lists (current + previous) were stale; the reconnect fetched both again.
    expect(served).toBeGreaterThanOrEqual(4)
    await expect(page.getByText(/Quorum not found in cache/)).toHaveCount(0)
    await shot(page, 'nr-4-rotated-quorum-recovered')
    expect(errors).toEqual([])
  })
})

test.describe('network resilience: refresh under navigation and writes', () => {
  test('nr-5. three repos opened while a refresh is in flight: no stuck state, refreshes continue', async ({ page }) => {
    test.setTimeout(4 * 60_000)
    const { errors } = collectPageErrors(page)
    await page.clock.install()
    await page.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
    await expect(README(page)).toBeVisible({ timeout: 90_000 })

    // Hold the quorum service from here on: the refresh stays in flight until released.
    let held = true
    let hits = 0
    const waiting: (() => void)[] = []
    await page.context().route(QUORUMS, async (route) => {
      hits++
      if (held) await new Promise<void>((r) => waiting.push(r))
      return route.continue()
    })
    await page.clock.fastForward(REFRESH_MS)
    await expect.poll(() => hits, { timeout: 30_000 }).toBeGreaterThan(0)

    // Three repo pages mount (each names its contracts) while that refresh waits.
    await navigate(page, repoUrl('', '', EMPTY))
    await expect(page.getByRole('region', { name: 'Empty repository' })).toBeVisible({ timeout: 60_000 })
    await navigate(page, repoUrl('issues'))
    await expect(page.getByRole('link', { name: /README should explain/ }).first()).toBeVisible({ timeout: 60_000 })
    await navigate(page, repoUrl('pulls'))
    await expect(page.getByRole('main')).toContainText(/pull/i, { timeout: 60_000 })
    await shot(page, 'nr-5-navigated-during-refresh')

    held = false
    waiting.splice(0).forEach((r) => r())
    await navigate(page, repoUrl())
    await expect(README(page)).toBeVisible({ timeout: 60_000 })
    await page.waitForTimeout(5_000)
    await expect(BANNER(page)).toHaveCount(0)
    await expect(page.getByText(/Connecting to Platform/)).toHaveCount(0)

    // The next refresh still runs: the service did not strand its config.
    const before = hits
    await page.clock.fastForward(REFRESH_MS)
    await expect.poll(() => hits, { timeout: 30_000 }).toBeGreaterThan(before)
    await expect(README(page)).toBeVisible()
    await expect(BANNER(page)).toHaveCount(0)
    await shot(page, 'nr-5-after-refresh')
    expect(errors).toEqual([])
  })

  test('nr-6. a real write right after a forced refresh lands', async ({ browser }) => {
    test.skip(process.env['E2E_WRITE'] !== '1', 'live devnet write: set E2E_WRITE=1')
    test.skip(!existsSync(idFile('NRWRITER')), 'set E2E_IDENTITY_DIR to a directory holding NRWRITER.identity.json')
    test.setTimeout(6 * 60_000)
    const page = await signedIn(browser, 'NRWRITER', '/new/')
    // Fake timers from a fresh load, so the refresh can be forced; the vault unlocks again.
    await page.clock.install()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await unlock(page)

    // The write starts only once the refreshed connection is live (the service marks each
    // connection it installs on <html data-sdk-generation>).
    const generation = (): Promise<number> => page.evaluate(() => Number(document.documentElement.dataset['sdkGeneration'] ?? 0))
    await expect.poll(generation, { timeout: 60_000 }).toBeGreaterThan(0)
    const before = await generation()
    await page.clock.fastForward(REFRESH_MS)
    await expect.poll(generation, { timeout: 90_000 }).toBeGreaterThan(before)

    const name = `nr6-${Date.now().toString(36)}`
    await page.getByLabel('Repository name').fill(name)
    await page.getByRole('button', { name: 'Create repository' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByTestId('cost-preview')).toBeVisible()
    await dialog.getByRole('button', { name: /sign & create/i }).click()
    await expect(dialog).toBeHidden({ timeout: 120_000 })
    await expect(page.getByRole('region', { name: 'Empty repository' })).toBeVisible({ timeout: 120_000 })
    await shot(page, 'nr-6-write-after-refresh')
  })
})
