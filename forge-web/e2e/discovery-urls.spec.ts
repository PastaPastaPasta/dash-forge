import { test, expect, type Page } from '@playwright/test'
import { collectPageErrors, countDapi, countDocumentQueries, DAPI_METHOD, DAPI_RESEND_SLACK, decodeDocumentsRequest, DEMO, deployment, loadSeedPulls, nodeSdk, repoUrl, runAxe, shot } from './helpers'

/**
 * G14 (L-25, L-27, L-40): Explore search, the jump box, GitHub-style short URLs and the
 * Stargazers page, signed out, reads only, on moutai:
 *
 *   E2E_DEVNET=bonsia E2E_PORT=<free port> pnpm exec playwright test discovery-urls.spec.ts
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
  let domainReads = 0
  page.on('request', (req) => {
    if (DAPI_METHOD.exec(req.url())?.[1] === 'getDocuments' && decodeDocumentsRequest(req.postDataBuffer())?.documentType === 'domain') domainReads++
  })
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

  // Request budget, derived from the page's shape rather than from the devnet's size: trending,
  // most starred and most forked are a proved ranked read and one composite each (6); recent is
  // one composite per page (2 here); "Recently released" reads the latest release of each repo
  // on the first recent page (one read per card, `firstPage`). Stars, issue counts, pushes and
  // the owners' DPNS names ride in those composites, so however many repos or distinct owners
  // the shared devnet grows, nothing else is read. A later recent page whose composite the node
  // refused fell back to the plain query and read each new owner's name on its own (it stepped
  // this past 40 as bonsia grew): no top-level `domain` read at all is allowed.
  const docs = dapi.get('getDocuments') ?? 0
  test.info().annotations.push({ type: 'dapi', description: JSON.stringify(Object.fromEntries(dapi)) })
  expect(dapi.get('getDocumentsCount') ?? 0, 'counts ride in the composites').toBe(0)
  expect(domainReads, 'owner names ride in the composites (no per-owner DPNS read)').toBe(0)
  expect(docs, `getDocuments on Explore (6 ranked + 2 recent pages + ${firstPage} release reads)`).toBeLessThanOrEqual(6 + 2 + firstPage + DAPI_RESEND_SLACK)
  expect(errors, errors.join('\n')).toEqual([])
})

/** Every owner of a repo called `name` on the devnet, read in Node (the `repo.name` index). */
async function ownersOf(name: string): Promise<string[]> {
  const sdk = await nodeSdk()
  const r: Map<string, { toJSON(v: number): Record<string, unknown> } | undefined> = await sdk.documents.query({
    dataContractId: deployment().v2.forgeCore.contractId,
    documentTypeName: 'repo',
    where: [['name', '==', name]],
    orderBy: [['name', 'asc']],
    limit: 20,
  })
  return [...r.values()].filter((d) => d !== undefined).map((d) => String(d!.toJSON(14)['$ownerId']))
}

test('g3. the jump box: a bare repo name opens the repo, not "No such identity"', async ({ page }) => {
  const { errors } = collectPageErrors(page)
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const jump = page.getByLabel(/jump to a repo/i).first()

  // A name several owners use: a choice listing each, the fixture's among them.
  const demoOwners = await ownersOf(DEMO.name)
  expect(demoOwners).toContain(DEMO.owner)
  await jump.fill(DEMO.name)
  await jump.press('Enter')
  if (demoOwners.length > 1) {
    const choices = page.getByTestId('jump-choices')
    await expect(choices.getByRole('link', { name: `repo ${DEMO.name}`, exact: true })).toHaveCount(demoOwners.length, { timeout: 60_000 })
    await expect(page.getByRole('status').filter({ hasText: `${demoOwners.length} matches for ${DEMO.name}` })).toBeVisible()
    await shot(page, 'g14-jump-choices')
    await choices.locator(`a[data-owner="${DEMO.owner}"]`).click()
    // A pick closes the popover.
    await expect(choices).toHaveCount(0)
  }
  await expect(page).toHaveURL(new RegExp(`/repo/?\\?owner=${DEMO.owner}&name=${DEMO.name}`), { timeout: 60_000 })
  await expect(page.getByText('No such identity')).toHaveCount(0)

  // A name one owner uses (the paging fixture): straight there.
  const [pagingOwner, ...others] = await ownersOf('issues-paging')
  test.skip(pagingOwner === undefined || others.length > 0, 'issues-paging is not a unique repo name on this devnet')
  await jump.fill('issues-paging')
  await jump.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/repo/?\\?owner=${pagingOwner}&name=issues-paging`), { timeout: 60_000 })

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
  // Any real PR works for the pull/files case (only the canonical URL and "Files changed" are
  // checked): its number now comes from the seed summary, not the literal 1 (dense shared
  // numbering, forge-v2.md §6.2 — #1 is an issue in this fixture).
  const pr = loadSeedPulls().approved
  const cases: [string, RegExp, RegExp][] = [
    [`${base}/branches`, /\/repo\/branches\/?\?owner=/, /main/],
    [`${base}/tags`, /\/repo\/tags\/?\?owner=/, /v0\.1\.0/],
    [`${base}/stargazers`, /\/repo\/stargazers\/?\?owner=/, /Stargazers/],
    [`${base}/releases/tag/v0.1.0`, /\/repo\/release\/?\?owner=.*tag=v0\.1\.0/, /v0\.1\.0/],
    [`${base}/tree/main/src`, /\/repo\/tree\/?\?owner=.*ref=main&path=src/, /main\.rs/],
    [`${base}/pull/${pr}/files`, new RegExp(`/repo/pull/?\\?owner=.*number=${pr}&tab=files`), /Files changed/],
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
  // A tag's link (the shell header's tabs would match a bare /repo prefix before the page resolves).
  await expect(page.locator('main a[href*="/repo/tree/"], main a[href*="/repo/release/"], main a[href*="/repo/commit/"]').first()).toBeVisible({ timeout: 60_000 })
})
