import { test, expect, type Page, type Route } from '@playwright/test'
import { collectPageErrors, E2E_NETWORK, repoUrl } from './helpers'

test.skip(E2E_NETWORK === 'testnet', 'uses the devnet build and its bundled contract snapshots')

/**
 * Unproved contract-not-found refusals are retryable, even when every contacted node refuses.
 * Hermetic: the quorum service returns empty lists and every DAPI request (including the
 * fresh proved-contract fetch) gets gRPC InvalidArgument, "contract not found error: …".
 * That cannot prove absence, so home, repo and explore retain "A node is behind; try again."
 * and Try again, never the permanent contracts-missing state or reset/update advice.
 * The bounded request count guards against automatic retry loops. A hermetic refusal mock
 * cannot sign a proof of absence; proved-None classification and its UI are unit/component
 * tested in lib/sdk/contract-missing.test.ts and components/ui/contracts-missing.test.tsx.
 *
 *   pnpm exec playwright test e2e/contracts-missing.spec.ts --project chromium
 */

const QUORUMS = /^https:\/\/quorums\.[a-z0-9-]+\.networks\.dash\.org\//
const DAPI = /\/org\.dash\.platform\.dapi\.v0\.Platform\/\w+$/
const DRIVE_MESSAGE = 'contract not found error: contract not found when querying from value with contract info'
// Explore is the busiest page: featured, trending (with its star-shape read), most starred and
// most forked in parallel, about 4-6 Forge reads. Each read is refused at most four times (the
// transport does not retry InvalidArgument), plus one shared absence check and the seeded-version
// revalidation: about 20-30 refusals. 40 leaves room without allowing a retry loop.
const MAX_REFUSALS_PER_PAGE = 40

async function cors(route: Route): Promise<Record<string, string>> {
  return {
    'access-control-allow-origin': (await route.request().headerValue('origin')) ?? '*',
    'access-control-expose-headers': 'grpc-status,grpc-message',
  }
}

/** Refuse every read without proving anything about whether the contracts exist. */
async function refuseContracts(page: Page): Promise<{ refused: number }> {
  const stats = { refused: 0 }
  await page.context().route(QUORUMS, async (route) => {
    const previous = new URL(route.request().url()).pathname.endsWith('/previous')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: await cors(route),
      body: JSON.stringify(previous ? { success: true, data: { height: 10, quorums: [] } } : { success: true, data: [] }),
    })
  })
  await page.context().route(DAPI, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: { ...(await cors(route)), 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' },
      })
    }
    stats.refused++
    return route.fulfill({
      status: 200,
      body: '',
      headers: {
        ...(await cors(route)),
        'content-type': 'application/grpc-web+proto',
        'grpc-status': '3',
        'grpc-message': encodeURIComponent(DRIVE_MESSAGE),
      },
    })
  })
  return stats
}

async function expectRetryableRefusal(page: Page, stats: { refused: number }, previous = 0): Promise<void> {
  await expect(page.getByText('A node is behind; try again.', { exact: true }).first()).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('button', { name: 'Try again', exact: true }).first()).toBeVisible()
  await expect(page.getByTestId('contracts-missing')).toHaveCount(0)
  await expect(page.getByTestId('platform-unreachable')).toHaveCount(0)
  await expect(page.getByText(/probably reset|Reload for a newer build|re-push your repos/)).toHaveCount(0)
  // Let the remaining parallel reads and the longest backoff finish before checking the bound.
  await page.waitForTimeout(2_000)
  const refused = stats.refused - previous
  expect(refused).toBeGreaterThan(0)
  expect(refused).toBeLessThanOrEqual(MAX_REFUSALS_PER_PAGE)
  // No automatic retry loop: nothing more is refused while the page sits on the advice.
  await page.waitForTimeout(6_000)
  expect(stats.refused - previous, 'refusals after the advice settled').toBe(refused)
  await expect(page.getByTestId('contracts-missing')).toHaveCount(0)
}

test.describe('unproved contract refusals', () => {
  test('cm-1. home keeps retry advice and bounds the refused requests', async ({ page }) => {
    const { errors } = collectPageErrors(page)
    const stats = await refuseContracts(page)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expectRetryableRefusal(page, stats)
    expect(errors, errors.join('\n')).toEqual([])
  })

  test('cm-2. repo and explore keep retry advice without claiming contracts are missing', async ({ page }) => {
    const { errors } = collectPageErrors(page)
    const stats = await refuseContracts(page)
    await page.goto(repoUrl('issues'), { waitUntil: 'domcontentloaded' })
    await expectRetryableRefusal(page, stats)
    const repoRefusals = stats.refused
    await page.goto('/explore/', { waitUntil: 'domcontentloaded' })
    await expectRetryableRefusal(page, stats, repoRefusals)
    expect(errors, errors.join('\n')).toEqual([])
  })
})
