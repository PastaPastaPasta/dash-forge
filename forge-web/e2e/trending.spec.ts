import { test, expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectPageErrors, countDocumentQueries, E2E_DEVNET, nodeSdk, shot } from './helpers'

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
 *   4. asserts the section's request budget: one ranked `starBeat` read per window.
 */

interface Seed {
  readonly repos: readonly { readonly id: string; readonly name: string }[]
  readonly beats: readonly { readonly repoId: string; readonly repoHex: string; readonly createdAt: number }[]
}

const SEED = process.env['E2E_TRENDING_SEED'] ?? ''

/**
 * The recount, as FORGE_RULES_V2 `trendingWindow` / `trendingRecount` define it (vectors
 * `trending__*`; restated here because the Playwright transform cannot load `lib/rules`, whose
 * hashing imports are ESM-only). The weekly grid: range 7 d, step 1 d, phase 0.
 */
const DAY = 86_400_000
function recount(beats: readonly { repoHex: string; createdAt: number }[], now: number, selector: 'newest' | 'oldest'): { repo: string; count: number }[] {
  const newest = Math.floor(now / DAY) * DAY
  const start = selector === 'newest' ? newest : Math.max(newest - 6 * DAY, 0)
  const end = start + 7 * DAY
  const counts = new Map<string, number>()
  for (const b of beats) {
    if (b.createdAt < start || b.createdAt >= end) continue
    const repo = b.repoHex.toLowerCase()
    counts.set(repo, (counts.get(repo) ?? 0) + 1)
  }
  return [...counts.entries()].map(([repo, count]) => ({ repo, count })).sort((a, b) => b.count - a.count || (a.repo < b.repo ? 1 : a.repo > b.repo ? -1 : 0))
}

test('t1. Trending this week matches a recount of the seeded stars in the window', async ({ page }) => {
  test.skip(SEED === '' || !existsSync(SEED), `set E2E_TRENDING_SEED to the file forge-contracts/scripts/seed-trending.mjs wrote on ${E2E_DEVNET}`)
  const seed = JSON.parse(readFileSync(SEED, 'utf8')) as Seed
  const idOfHex = new Map(seed.beats.map((b) => [b.repoHex.toLowerCase(), b.repoId]))
  const expected = recount(seed.beats, Date.now(), 'oldest').map((r) => ({ id: idOfHex.get(r.repo) as string, count: r.count }))
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
  const beatReads = countDocumentQueries(page, 'starBeat')
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
  const todayRecount = recount(seed.beats, Date.now(), 'newest')
  if (todayRecount.length > 0) {
    await expect(section.getByTestId('ranked-row').first()).toBeVisible({ timeout: 60_000 })
    const today = (await section.getByTestId('ranked-row').evaluateAll((els) => els.map((el) => el.getAttribute('data-repo-id') ?? ''))).filter((id) => seeded.has(id))
    const want = todayRecount.map((r) => idOfHex.get(r.repo) as string).filter((id) => today.includes(id))
    expect(today).toEqual(want)
  }
  await shot(page, 't1-trending-today')

  // Budget: Trending is ONE proved ranked read per window (`getDocuments` carries it), whatever
  // the number of stars: this week, then today.
  expect(beatReads.count()).toBe(2)
  expect(errors, errors.join('\n')).toEqual([])
})
