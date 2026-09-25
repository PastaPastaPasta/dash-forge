import { test, expect } from '@playwright/test'
import { ON_TESTNET, repoUrl, runAxe, waitForRepoResolved, M1 } from './helpers'

// The v1 read fixture lives on testnet; a devnet build runs v2-reads.spec.ts instead.
test.skip(!ON_TESTNET, 'testnet fixture; this build targets a devnet')

/**
 * Scenario 6 — Accessibility smoke via axe-core.
 *
 * Target: 0 serious/critical violations on the landing + repo home. We report all serious &
 * critical findings; moderate/minor are logged but not gated (v1 acceptance is "0 serious").
 */

test('6a. landing has no serious/critical axe violations', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: /no server to trust/i })).toBeVisible()
  await page.waitForTimeout(3000)
  const serious = await runAxe(page, 'landing')
  expect(
    serious,
    'serious/critical a11y violations on landing:\n' +
      serious.map((v) => `${v.id}: ${v.help}`).join('\n'),
  ).toEqual([])
})

test('6b. repo home has no serious/critical axe violations', async ({ page }) => {
  await page.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page)
  await page.getByText(M1.name, { exact: false }).first().waitFor({ timeout: 30_000 }).catch(() => {})
  const serious = await runAxe(page, 'repo-home')
  expect(
    serious,
    'serious/critical a11y violations on repo home:\n' +
      serious.map((v) => `${v.id}: ${v.help}`).join('\n'),
  ).toEqual([])
})
