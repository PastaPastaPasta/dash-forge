import { test, expect, type Page, type Route } from '@playwright/test'
import { collectPageErrors, repoUrl, shot } from './helpers'

/**
 * The network does not have this build's contracts (devnet moutai reset to beta.6, 2026-09-28):
 * one clear app-wide state instead of every view's "That read did not land" with a raw gRPC
 * string and a Try again that can never succeed.
 *
 * Hermetic: nothing reaches the chain. The quorum service answers with empty quorum lists (an
 * error reply carries no proof, so no key is needed), and every DAPI call gets the refusal a
 * reset devnet sends for a read against a contract it no longer has: gRPC InvalidArgument,
 * "contract not found error: …". The build's bundled contract snapshots make the reads go out
 * without a contract fetch, exactly as on forge.dashhq.org.
 *
 *   E2E_SKIP_BUILD=1 E2E_PORT=<port> pnpm exec playwright test contracts-missing.spec.ts
 */

const QUORUMS = /^https:\/\/quorums\.[a-z0-9-]+\.networks\.dash\.org\//
const DAPI = /\/org\.dash\.platform\.dapi\.v0\.Platform\/\w+$/
const DRIVE_MESSAGE = 'contract not found error: contract not found when querying from value with contract info'
/** What the owner saw on forge.dashhq.org, inside the old error state. */
const RAW =
  'transport error: grpc error: code: \'Client specified an invalid argument\', message: "contract not found error: contract not found when querying from value with contract info"'

async function cors(route: Route): Promise<Record<string, string>> {
  return {
    'access-control-allow-origin': (await route.request().headerValue('origin')) ?? '*',
    'access-control-expose-headers': 'grpc-status,grpc-message',
  }
}

/** Serve the chain a reset devnet is: quorums answer, every contract is gone. */
async function resetDevnet(page: Page): Promise<{ refused: number }> {
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

const STATE = (page: Page) => page.getByTestId('contracts-missing')

async function expectContractsMissing(page: Page): Promise<void> {
  await expect(STATE(page)).toBeVisible({ timeout: 60_000 })
  await expect(STATE(page).getByRole('heading')).toHaveText("Dash Forge isn't deployed on devnet moutai right now")
  await expect(STATE(page)).toContainText('devnets are reset from time to time')
  // Not the generic read failure, not the outage banner, and no endless retry.
  await expect(page.getByText('That read did not land')).toHaveCount(0)
  await expect(page.getByTestId('platform-unreachable')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0)
  // The raw error is behind Details only.
  const raw = STATE(page).getByText(RAW, { exact: true })
  await expect(raw).toBeHidden()
  await STATE(page).getByText('Details', { exact: true }).click()
  await expect(raw).toBeVisible()
}

test.describe("the network does not have this build's contracts", () => {
  test('cm-1. home: one clear state, raw error under Details, no Try again', async ({ page }) => {
    const { errors } = collectPageErrors(page)
    const stats = await resetDevnet(page)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(STATE(page)).toBeVisible({ timeout: 60_000 })
    await shot(page, 'cm-1-home-contracts-missing')
    await expectContractsMissing(page)
    await shot(page, 'cm-1-home-contracts-missing-details')
    expect(stats.refused).toBeGreaterThan(0)
    expect(errors, errors.join('\n')).toEqual([])
  })

  test('cm-2. a repo page and explore show the same state, not their own read errors', async ({ page }) => {
    await resetDevnet(page)
    await page.goto(repoUrl('issues'), { waitUntil: 'domcontentloaded' })
    await expectContractsMissing(page)
    await shot(page, 'cm-2-repo-contracts-missing')
    await page.goto('/explore/', { waitUntil: 'domcontentloaded' })
    await expectContractsMissing(page)
  })
})
