import { test, expect } from '@playwright/test'
import { SNAPSHOT_KEYS } from '../lib/sdk/contract-seed'
import { E2E_DEVNET, collectPageErrors, countDapi, loadSeedPulls, repoUrl as url, shot, waitForRepoResolved } from './helpers'
import { quorumGuard } from './quorum-sync'

// Not inside bonsia's quorum-service lag (#212): these specs count requests or read Verification.
test.beforeEach(quorumGuard)

/**
 * P-1: the shared DAPI request budget (`lib/sdk/budget.ts`) and the seeded contracts
 * (`lib/sdk/contract-seed.ts`), against the moutai read fixture:
 *
 *   E2E_DEVNET=sakura pnpm exec playwright test rate-budget.spec.ts
 *
 *  - A rate-limited node (a gateway `ResourceExhausted` reply with `ratelimit-reset`, mocked
 *    here) makes the page wait, showing "Platform is busy — waiting Ns", and then finish. It
 *    never ends in "no available addresses" (D-102, D-902).
 *  - Repo home, issues and a PR page make zero `getDataContract` requests: the contracts come
 *    from the bundled snapshot.
 */

/**
 * The gateway's over-limit reply to a grpc-web client, as dashmate's envoy sends it
 * (`local_reply_config`: HTTP 200, `grpc-status: 8`, `grpc-message: rate limited`, the
 * ratelimit headers with `remaining: 0`, no body, CORS exposing them).
 */
function overLimitReply(resetS: number) {
  return {
    status: 200,
    headers: {
      'content-type': 'application/grpc-web+proto',
      'grpc-status': '8',
      'grpc-message': 'rate limited',
      'ratelimit-limit': '150',
      'ratelimit-remaining': '0',
      'ratelimit-reset': String(resetS),
      'x-envoy-ratelimited': 'true',
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'grpc-status,grpc-message,ratelimit-reset,ratelimit-limit,ratelimit-remaining',
    },
    body: '',
  }
}

test.describe('DAPI request budget', () => {
  test('rb-1a. a rate-limited node: the read fails over to another node at once', async ({ page }) => {
    const { errors } = collectPageErrors(page)
    // One node answers every document read with the gateway's over-limit reply and a 30 s
    // reset. The page must not wait 30 s for it, nor fail: the next attempt goes elsewhere.
    let limited: string | null = null
    let refused = 0
    await page.route(/\/org\.dash\.platform\.dapi\.v0\.Platform\/getDocuments$/, async (route) => {
      const node = new URL(route.request().url()).origin
      limited ??= node
      if (node !== limited) return route.continue()
      refused++
      await route.fulfill(overLimitReply(30))
    })
    const t0 = Date.now()
    await page.goto(url('issues'), { waitUntil: 'domcontentloaded' })
    await expect(page.locator('main a[href*="/repo/issue/"][href*="number="]').first()).toBeVisible({ timeout: 25_000 })
    expect(Date.now() - t0).toBeLessThan(25_000)
    expect(refused).toBeGreaterThan(0)
    await expect(page.getByText(/no available addresses|did not land/i)).toHaveCount(0)
    expect(errors, errors.join('\n')).toEqual([])
  })

  test('rb-1b. every node rate-limited: "Platform is busy — waiting Ns", then the page finishes', async ({ page }) => {
    const { errors } = collectPageErrors(page)
    // The IP is over the limit on every node for a few seconds (a CLI import next to the tab):
    // the first document read to each node is refused with a 4 s reset.
    const refusedNodes = new Set<string>()
    await page.route(/\/org\.dash\.platform\.dapi\.v0\.Platform\/getDocuments$/, async (route) => {
      const node = new URL(route.request().url()).origin
      if (refusedNodes.has(node)) return route.continue()
      refusedNodes.add(node)
      await route.fulfill(overLimitReply(4))
    })
    await page.goto(url('issues'), { waitUntil: 'domcontentloaded' })
    const busy = page.getByTestId('platform-busy')
    await expect(busy).toBeVisible({ timeout: 60_000 })
    await expect(busy).toContainText(/Platform is busy — waiting \d+s/)
    await shot(page, 'rb-01-platform-busy')
    // Then the list lands, the status goes away, and nothing reads as an error.
    await expect(page.locator('main a[href*="/repo/issue/"][href*="number="]').first()).toBeVisible({ timeout: 60_000 })
    await expect(busy).toBeHidden({ timeout: 30_000 })
    await expect(page.getByText(/no available addresses|did not land/i)).toHaveCount(0)
    await shot(page, 'rb-02-after-wait')
    expect(errors, errors.join('\n')).toEqual([])
  })

  for (const [id, path, extra, ready] of [
    ['home', '', '', 'section[aria-label=README]'],
    ['issues', 'issues', '', 'main a[href*="/repo/issue/"][href*="number="]'],
    // Any real PR works here (only "no getDataContract" is checked): the number is resolved
    // lazily below, since #1 is now an issue, not a PR (dense shared numbering, forge-v2.md §6.2).
    ['pull', 'pull', '', 'main h1'],
  ] as const) {
    test(`rb-2 (${id}). no getDataContract request: the contracts are seeded`, async ({ page }) => {
      // Expected until the wipe runbook step 5 (dash-forge-qa/WIPE-PLAN.md §3): the beta.6 snapshot was dropped with the beta.7
      // schema (beta.7 cannot parse its bytes), and snapshot-contracts.mjs re-adds it after the
      // fresh registration. Without a snapshot every page fetches its contracts.
      test.skip(!SNAPSHOT_KEYS.includes(`devnet-${E2E_DEVNET}`), `no contract snapshot for devnet-${E2E_DEVNET} yet`)
      const counts = countDapi(page)
      const resolvedExtra = id === 'pull' ? `&number=${loadSeedPulls().approved}` : extra
      await page.goto(url(path, resolvedExtra), { waitUntil: 'domcontentloaded' })
      await waitForRepoResolved(page)
      await expect(page.locator(ready).first()).toBeVisible({ timeout: 60_000 })
      // Let the page's trailing reads (rail, counts) go out before counting.
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined)
      const total = [...counts.values()].reduce((a, n) => a + n, 0)
      expect(total, 'the page made DAPI requests').toBeGreaterThan(0)
      expect(counts.get('getDataContract') ?? 0, JSON.stringify(Object.fromEntries(counts))).toBe(0)
      expect(counts.get('getDataContracts') ?? 0).toBe(0)
    })
  }
})
