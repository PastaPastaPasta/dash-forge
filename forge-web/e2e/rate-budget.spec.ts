import { test, expect, type Page, type Request } from '@playwright/test'
import { collectPageErrors, repoUrl as url, shot, waitForRepoResolved } from './helpers'

/**
 * P-1: the shared DAPI request budget (`lib/sdk/budget.ts`) and the seeded contracts
 * (`lib/sdk/contract-seed.ts`), against the moutai read fixture:
 *
 *   E2E_DEVNET=moutai pnpm exec playwright test rate-budget.spec.ts
 *
 *  - A rate-limited node (a gateway `ResourceExhausted` reply with `ratelimit-reset`, mocked
 *    here) makes the page wait, showing "Platform is busy — waiting Ns", and then finish. It
 *    never ends in "no available addresses" (D-102, D-902).
 *  - Repo home, issues and a PR page make zero `getDataContract` requests: the contracts come
 *    from the bundled snapshot.
 */

const DAPI_METHOD = /\/org\.dash\.platform\.dapi\.v0\.Platform\/(\w+)$/

/** Count the DAPI requests of `page` by gRPC method. */
function countDapi(page: Page): Map<string, number> {
  const counts = new Map<string, number>()
  page.on('request', (request: Request) => {
    const method = DAPI_METHOD.exec(request.url())?.[1]
    if (method !== undefined) counts.set(method, (counts.get(method) ?? 0) + 1)
  })
  return counts
}

test.describe('DAPI request budget', () => {
  test('rb-1. a rate-limited node makes the page wait, then it finishes', async ({ page }) => {
    const { errors } = collectPageErrors(page)
    // The first two document reads get the gateway's over-limit reply: HTTP 200 +
    // grpc-status 8 + ratelimit-reset, no body (dashmate envoy `local_reply_config`).
    let refused = 0
    await page.route(/\/org\.dash\.platform\.dapi\.v0\.Platform\/getDocuments$/, async (route) => {
      if (refused >= 2) return route.continue()
      refused++
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'application/grpc-web+proto',
          'grpc-status': '8',
          'grpc-message': 'Some resource has been exhausted',
          'ratelimit-limit': '150',
          'ratelimit-remaining': '0',
          'ratelimit-reset': '4',
          'access-control-allow-origin': '*',
          'access-control-expose-headers': 'grpc-status,grpc-message,ratelimit-reset,ratelimit-limit,ratelimit-remaining',
        },
        body: '',
      })
    })
    await page.goto(url('issues'), { waitUntil: 'domcontentloaded' })
    const busy = page.getByTestId('platform-busy')
    await expect(busy).toBeVisible({ timeout: 60_000 })
    await expect(busy).toContainText(/Platform is busy — waiting \d+s/)
    await shot(page, 'rb-01-platform-busy')
    // Then the list lands, the status goes away, and nothing reads as an error.
    await expect(page.locator('main a[href*="/repo/issue"]').first()).toBeVisible({ timeout: 60_000 })
    await expect(busy).toBeHidden({ timeout: 30_000 })
    await expect(page.getByText(/no available addresses/i)).toHaveCount(0)
    await expect(page.getByText(/did not land/i)).toHaveCount(0)
    expect(refused).toBe(2)
    await shot(page, 'rb-02-after-wait')
    expect(errors, errors.join('\n')).toEqual([])
  })

  for (const [id, path, extra, ready] of [
    ['home', '', '', 'section[aria-label=README]'],
    ['issues', 'issues', '', 'main a[href*="/repo/issue"]'],
    ['pull', 'pull', '&number=1', 'main h1'],
  ] as const) {
    test(`rb-2 (${id}). no getDataContract request: the contracts are seeded`, async ({ page }) => {
      const counts = countDapi(page)
      await page.goto(url(path, extra), { waitUntil: 'domcontentloaded' })
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
