import { test, expect, type Page } from '@playwright/test'
import { collectPageErrors, countDapi, countDocumentQueries, DEMO, nodeSdk, repoUrl, runAxe, shot } from './helpers'

/**
 * G14 (L-25, L-27, L-40): Explore search, the jump box, GitHub-style short URLs and the
 * Stargazers page, signed out, reads only, on moutai:
 *
 *   E2E_DEVNET=moutai E2E_PORT=<free port> pnpm exec playwright test discovery-urls.spec.ts
 *
 * The search and jump cases use the read fixture (`forge-v2-demo`), which every devnet has.
 * The showcase cases resolve the mirrors' owners by DPNS name, so they survive a devnet
 * re-mint; they skip (with the reason) where the showcase is not mirrored.
 */

/** Owner ids of showcase mirrors by DPNS label, read in Node (independent of the app). */
const showcaseOwners = new Map<string, Promise<string | null>>()
function showcaseOwner(label: string): Promise<string | null> {
  let owner = showcaseOwners.get(label)
  if (owner === undefined) {
    owner = nodeSdk()
      .then(async (sdk) => {
        const id = await sdk.dpns.resolveName(`${label}.dash`)
        return id ? String(id) : null
      })
      .catch(() => null)
    showcaseOwners.set(label, owner)
  }
  return owner
}

/** A repo card link in `scope` addressing `owner`'s repo `name`. */
function cardLink(page: Page, scope: string, owner: string, name: string) {
  return page.getByTestId(scope).locator(`a[href*="owner=${owner}"][href*="name=${name}"]`).first()
}

test('g1. Explore search finds the fixture repo by a name prefix, in one request per page', async ({ page }) => {
  const { errors } = collectPageErrors(page)
  const dapi = countDapi(page)
  // Only the search composite's page names the `repo` type with a `name` range; count it.
  const repoReads = countDocumentQueries(page, 'forge-v2-')
  await page.goto('/explore/?q=forge-v2-dem', { waitUntil: 'domcontentloaded' })
  const results = page.getByTestId('explore-search-results')
  await expect(results.getByRole('heading', { name: /Repos starting with “forge-v2-dem”/ })).toBeVisible()
  await expect(cardLink(page, 'explore-search-results', DEMO.owner, DEMO.name)).toBeVisible({ timeout: 60_000 })
  // The fixture has one star, read in the same composite (the card shows the proven count).
  await expect(results.locator('[title="Stars (provable count)"]').first()).toBeVisible()
  expect(repoReads.count(), 'the search is one composite (no per-repo reads)').toBe(1)
  await shot(page, 'g14-explore-search')
  test.info().annotations.push({ type: 'dapi', description: JSON.stringify(Object.fromEntries(dapi)) })

  // The box submits into ?q=: a new term replaces the results; an impossible one says so.
  const box = page.getByRole('searchbox', { name: /search repos by name/i })
  await expect(box).toHaveValue('forge-v2-dem')
  await box.fill('no such repo!')
  await box.press('Enter')
  await expect(page).toHaveURL(/\/explore\/?\?q=no\+such\+repo/)
  await expect(page.getByTestId('explore-search-invalid')).toContainText('no repo name starts with')
  await box.fill('zz-no-repo-starts-with-this')
  await box.press('Enter')
  await expect(page.getByTestId('explore-search-results').locator('[data-empty]')).toContainText('No repo name starts with', { timeout: 60_000 })

  const serious = await runAxe(page, 'explore-search')
  expect(serious, serious.map((v) => `${v.id}: ${v.help}`).join('\n')).toEqual([])
  expect(errors, errors.join('\n')).toEqual([])
})

test('g2. Explore: most starred (labelled with its bound), recently updated, and recent repos page', async ({ page }) => {
  const { errors } = collectPageErrors(page)
  const dapi = countDapi(page)
  await page.goto('/explore/', { waitUntil: 'domcontentloaded' })
  const starred = page.getByTestId('explore-most-starred')
  await expect(starred.locator('a[href*="/repo"], [data-empty]').first()).toBeVisible({ timeout: 60_000 })
  // Every ranked card shows its exact star count.
  const cards = starred.locator('a[href*="/repo"]')
  if ((await cards.count()) > 0) await expect(starred.locator('[title="Stars (provable count)"]').first()).toBeVisible()
  // The heading says how far the read went when it did not see every star.
  const partial = starred.locator('[data-partial]')
  if (await partial.isVisible()) await expect(starred.getByRole('heading')).toContainText(/Most starred among \d+ stars read/)

  const updated = page.getByTestId('explore-recently-updated')
  await expect(updated.getByRole('heading')).toContainText('among the repos on this page')
  await expect(updated.locator('a[href*="/repo"], [data-empty]').first()).toBeVisible({ timeout: 60_000 })

  const recent = page.getByTestId('explore-recent-repos')
  await expect(recent.locator('a[href*="/repo"]').first()).toBeVisible({ timeout: 60_000 })
  const firstPage = await recent.locator('a[href*="/repo"]').count()
  expect(firstPage).toBe(24)
  const more = recent.getByRole('button', { name: 'Load more repos' })
  await expect(more).toBeVisible()
  await more.click()
  await expect.poll(() => recent.locator('a[href*="/repo"]').count(), { timeout: 60_000 }).toBeGreaterThan(firstPage)
  await shot(page, 'g14-explore-sections')

  // Request budget: the signed-out page (recent + most starred + releases of 24 repos + one
  // more recent page) stays well under the old 52 (perf-scale), with no per-repo count reads.
  const docs = dapi.get('getDocuments') ?? 0
  test.info().annotations.push({ type: 'dapi', description: JSON.stringify(Object.fromEntries(dapi)) })
  expect(dapi.get('getDocumentsCount') ?? 0, 'counts ride in the composites').toBe(0)
  expect(docs, 'getDocuments on Explore (3 composites + 24 release reads + names)').toBeLessThanOrEqual(40)
  expect(errors, errors.join('\n')).toEqual([])
})

test('g3. the jump box: a bare repo name opens the repo, not "No such identity"', async ({ page }) => {
  const { errors } = collectPageErrors(page)
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const jump = page.getByLabel(/jump to a repo/i).first()
  await jump.fill(DEMO.name)
  await jump.press('Enter')
  // forge-v2-demo is one repo (no DPNS name of that label): straight there.
  await expect(page).toHaveURL(new RegExp(`/repo/?\\?owner=${DEMO.owner}&name=${DEMO.name}`), { timeout: 60_000 })
  await expect(page.getByText('No such identity')).toHaveCount(0)

  // A word that is neither: says so, and offers the Explore search.
  await jump.fill('zz-nothing-called-this')
  await jump.press('Enter')
  const note = page.getByRole('status').filter({ hasText: 'No repo or profile named zz-nothing-called-this' })
  await expect(note).toBeVisible({ timeout: 60_000 })
  await note.getByRole('link', { name: /Search repos for/ }).click()
  await expect(page).toHaveURL(/\/explore\/?\?q=zz-nothing-called-this/)

  // @name stays a profile, owner/name a repo (unchanged).
  await jump.fill(`${DEMO.owner}/${DEMO.name}`)
  await jump.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/repo/?\\?owner=${DEMO.owner}`))
  expect(errors, errors.join('\n')).toEqual([])
})

test('g4. short URLs: branches, tags, stargazers, commit, releases/tag, tree, pull files, issues ?q=', async ({ page }) => {
  const base = `/${DEMO.owner}/${DEMO.name}`
  const cases: [string, RegExp, RegExp][] = [
    [`${base}/branches`, /\/repo\/branches\/?\?owner=/, /main/],
    [`${base}/tags`, /\/repo\/tags\/?\?owner=/, /v0\.1\.0/],
    [`${base}/stargazers`, /\/repo\/stargazers\/?\?owner=/, /Stargazers/],
    [`${base}/releases/tag/v0.1.0`, /\/repo\/release\/?\?owner=.*tag=v0\.1\.0/, /v0\.1\.0/],
    [`${base}/tree/main/src`, /\/repo\/tree\/?\?owner=.*ref=main&path=src/, /main\.rs/],
    [`${base}/pull/1/files`, /\/repo\/pull\/?\?owner=.*number=1&tab=files/, /Files changed/],
    [`${base}/issues?q=is%3Aclosed`, /\/repo\/issues\/?\?owner=.*q=is%3Aclosed/, /closed/i],
  ]
  for (const [short, canonical, content] of cases) {
    await page.goto(short, { waitUntil: 'domcontentloaded' })
    await expect(page, short).toHaveURL(canonical, { timeout: 30_000 })
    await expect(page.getByText('Nothing here'), short).toHaveCount(0)
    await expect(page.locator('main').getByText(content).first(), short).toBeVisible({ timeout: 60_000 })
  }

  // /commit/<sha>: take the tip of main from the Branches page, open its short URL.
  await page.goto(`${base}/branches`, { waitUntil: 'domcontentloaded' })
  const tip = page.locator('main a[href*="/repo/commit"]').first()
  await expect(tip).toBeVisible({ timeout: 60_000 })
  const oid = new URL(String(await tip.getAttribute('href')), page.url()).searchParams.get('oid') ?? ''
  expect(oid).toMatch(/^[0-9a-f]{40}$/)
  await page.goto(`${base}/commit/${oid.slice(0, 12)}`, { waitUntil: 'domcontentloaded' })
  await expect(page).toHaveURL(new RegExp(`/repo/commit/?\\?owner=.*oid=${oid.slice(0, 12)}`))
  await expect(page.locator('main h1').first()).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Nothing here')).toHaveCount(0)
  await shot(page, 'g14-short-commit')
})

test('g5. Stargazers has a heading, and no repo tab is lit', async ({ page }) => {
  const { errors } = collectPageErrors(page)
  await page.goto(repoUrl('stargazers'), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: /Stargazers/ })).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('main [href*="/u/?name="], main [data-empty], main :text("No stargazers yet")').first()).toBeVisible({ timeout: 60_000 })
  const tabs = page.locator('a[aria-current="page"]')
  await expect(tabs.filter({ hasText: 'Code' })).toHaveCount(0)
  await shot(page, 'g14-stargazers')
  // On a Code route, Code is lit.
  await page.goto(repoUrl('branches'), { waitUntil: 'domcontentloaded' })
  await expect(page.locator('a[aria-current="page"]').filter({ hasText: 'Code' })).toHaveCount(1, { timeout: 60_000 })
  expect(errors, errors.join('\n')).toEqual([])
})

test('g6. showcase repos are discoverable: search, jump box and short URL (showcase repos)', async ({ page }) => {
  const owner = await showcaseOwner('unofficial-burntsushi-mirror')
  test.skip(owner === null, 'unofficial-burntsushi-mirror.dash does not resolve here: the showcase is not mirrored on this devnet')
  const id = owner as string
  await page.goto('/explore/?q=ripgr', { waitUntil: 'domcontentloaded' })
  await expect(cardLink(page, 'explore-search-results', id, 'ripgrep')).toBeVisible({ timeout: 60_000 })
  await shot(page, 'g14-showcase-search')

  const jump = page.getByLabel(/jump to a repo/i).first()
  await jump.fill('ripgrep')
  await jump.press('Enter')
  // One ripgrep and no DPNS name "ripgrep": the repo opens (D-034: it used to open /u/?name=ripgrep).
  await expect(page).toHaveURL(new RegExp(`/repo/?\\?owner=${id}&name=ripgrep`), { timeout: 60_000 })

  await page.goto(`/${id}/ripgrep/tags`, { waitUntil: 'domcontentloaded' })
  await expect(page).toHaveURL(/\/repo\/tags\/?\?owner=/)
  await expect(page.locator('main a[href*="/repo"]').first()).toBeVisible({ timeout: 60_000 })
})
