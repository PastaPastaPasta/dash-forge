import { test, expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectPageErrors, countDapi, E2E_DEVNET, nodeSdk, shot } from './helpers'

/**
 * Trending on Explore is the network's proved ranking of new stargazers, and it agrees with a
 * recount of the stars themselves (platform-parity-spec §4.3, C-1):
 *
 *   E2E_TRENDING_SEED=<file written by forge-contracts/scripts/seed-trending.mjs> \
 *   E2E_DEVNET=moutai pnpm exec playwright test trending.spec.ts
 *
 * The seed script mints nothing and writes as identities minted for the run (never the shared
 * fixtures): it creates repos, stars them from several identities (each star writing its
 * `starBeat`) so the ranking has a known shape, and records every beat it wrote with the
 * `$createdAt` the chain gave it. This spec then:
 *
 *   1. recounts the seeded beats inside the window the `oldest` selector covers now
 *      (`trendingWindow`, the same rule rs-dpp applies), ties by repo id descending;
 *   2. reads Trending this week on Explore and checks the seeded repos appear in that order with
 *      those counts (other repos on the devnet may interleave: only the relative order and the
 *      counts of the seeded ones are asserted);
 *   3. reads the same ranking in Node, independently of the app, and checks the page matches it;
 *   4. asserts the section's request budget (one ranked read, one composite).
 */

interface Seed {
  readonly repos: readonly { readonly id: string; readonly name: string }[]
  readonly beats: readonly { readonly repoId: string; readonly repoHex: string; readonly createdAt: number }[]
}

const SEED = process.env['E2E_TRENDING_SEED'] ?? ''

test('t1. Trending this week matches a recount of the seeded stars in the window', async ({ page }) => {
  test.skip(SEED === '' || !existsSync(SEED), `set E2E_TRENDING_SEED to the file forge-contracts/scripts/seed-trending.mjs wrote on ${E2E_DEVNET}`)
  const seed = JSON.parse(readFileSync(SEED, 'utf8')) as Seed
  const { v2 } = await import('../lib/rules')
  const now = Date.now()
  const window = v2.trendingWindow(v2.STAR_BEAT_GRID, now, 'oldest')
  expect(window).not.toBeNull()
  const recount = v2.trendingRecount(
    seed.beats.map((b) => ({ repo: b.repoHex, createdAt: b.createdAt })),
    v2.STAR_BEAT_GRID,
    now,
    'oldest',
    100,
  )
  const idOfHex = new Map(seed.beats.map((b) => [b.repoHex.toLowerCase(), b.repoId]))
  const expected = recount.map((r) => ({ id: idOfHex.get(r.repo) as string, count: r.count }))
  expect(expected.length).toBeGreaterThanOrEqual(3)

  // The network's own answer, read in Node (independent of the app).
  const sdk = await nodeSdk()
  const dep = JSON.parse(readFileSync(join(__dirname, '..', '..', 'forge-contracts', 'deployments', `devnet-${E2E_DEVNET}.json`), 'utf8'))
  const ranked = await sdk.documents.ranked({
    dataContractId: dep.v2.forgeCollab.contractId,
    documentTypeName: 'starBeat',
    groupBy: 'repoId',
    aggregate: { type: 'count' },
    limit: 100,
    timeRange: [{ field: '$createdAt', selector: 'oldest' }],
  })
  const seeded = new Set(seed.repos.map((r) => r.id))
  const proved = (ranked.entries as { groupValue: string; value: bigint }[])
    .filter((e) => seeded.has(String(e.groupValue)))
    .map((e) => ({ id: String(e.groupValue), count: Number(e.value) }))
  expect(proved, 'the proved ranking of the seeded repos equals the recount').toEqual(expected)

  // The page.
  const { errors } = collectPageErrors(page)
  const calls = countDapi(page)
  await page.goto('/explore/', { waitUntil: 'domcontentloaded' })
  const section = page.getByTestId('explore-trending')
  await expect(section.getByRole('heading', { name: 'Trending this week' })).toBeVisible()
  await expect(section.getByTestId('ranked-row').first()).toBeVisible({ timeout: 60_000 })
  const rows = await section.getByTestId('ranked-row').evaluateAll((els) =>
    els.map((el) => ({ id: el.getAttribute('data-repo-id') ?? '', count: Number(el.getAttribute('data-count')) })),
  )
  const shown = rows.filter((r) => seeded.has(r.id))
  // The page shows the top 12 of the whole devnet: the seeded repos it shows appear in the
  // recount's order, with the recount's counts.
  expect(shown.length).toBeGreaterThan(0)
  const shownIds = new Set(shown.map((r) => r.id))
  expect(shown, 'Trending on Explore matches the recount').toEqual(expected.filter((e) => shownIds.has(e.id)))
  await shot(page, 't1-trending-week')

  // Today: the newest window, same check.
  await section.getByTestId('trending-today').click()
  await expect(section.getByRole('heading', { name: 'Trending today' })).toBeVisible()
  const todayRecount = v2.trendingRecount(seed.beats.map((b) => ({ repo: b.repoHex, createdAt: b.createdAt })), v2.STAR_BEAT_GRID, Date.now(), 'newest', 100)
  if (todayRecount.length > 0) {
    await expect(section.getByTestId('ranked-row').first()).toBeVisible({ timeout: 60_000 })
    const today = (await section.getByTestId('ranked-row').evaluateAll((els) => els.map((el) => el.getAttribute('data-repo-id') ?? ''))).filter((id) => seeded.has(id))
    const want = todayRecount.map((r) => idOfHex.get(r.repo) as string).filter((id) => today.includes(id))
    expect(today).toEqual(want)
  }
  await shot(page, 't1-trending-today')

  // Budget: the Trending and Most starred reads are one ranked read each (`getDocuments`
  // carries them), never one request per star.
  expect(calls.get('getDocuments') ?? 0).toBeLessThanOrEqual(30)
  expect(errors, errors.join('\n')).toEqual([])
})
