import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atRoute, collectPageErrors, deployment, nodeSdk, ownerIs, shot } from './helpers'

/**
 * CJ-3: a GitHub address opens its Forge mirror, signed out, reads only.
 *
 *   E2E_DEVNET=sakura pnpm exec playwright test github-alias.spec.ts
 *
 * The mirror cases need a repo named `dash` whose description says it mirrors
 * github.com/dashpay/dash (the showcase mirror); they skip where there is none, or more than one.
 * A claim alone opens nothing (ABU-04): the redirect cases also need that repo in the showcase
 * (`lib/view/showcase.ts`), and an unvouched one is checked to show the chooser instead.
 */

/** The repo ids the web build's showcase vouches for, read from its source (Node cannot import the app's modules). */
function showcaseIds(): Set<string> {
  const src = readFileSync(join(__dirname, '..', 'lib', 'view', 'showcase.ts'), 'utf8')
  return new Set([...src.matchAll(/repoId:\s*'([1-9A-HJ-NP-Za-km-z]{43,44})'/g)].map((m) => m[1]!))
}

const MIRROR_OF = /\(mirror of github\.com\/dashpay\/dash\)$|^Mirror of github\.com\/dashpay\/dash$/i

/** The one public, non-fork `dash` repo that claims to mirror github.com/dashpay/dash, read in Node. */
async function dashMirror(): Promise<{ owner: string; id: string; vouched: boolean } | null> {
  const sdk = await nodeSdk()
  const r: Map<string, { toJSON(v: number): Record<string, unknown> } | undefined> = await sdk.documents.query({
    dataContractId: deployment().v2.forgeCore.contractId,
    documentTypeName: 'repo',
    where: [['name', '==', 'dash']],
    orderBy: [['name', 'asc']],
    limit: 20,
  })
  const mirrors = [...r.values()]
    .filter((d) => d !== undefined)
    .map((d) => d!.toJSON(14))
    .filter((d) => d['visibility'] !== 'private' && !d['forkOf'] && MIRROR_OF.test(String(d['description'] ?? '').trim()))
  return mirrors.length === 1 ? { owner: String(mirrors[0]!['$ownerId']), id: String(mirrors[0]!['$id']), vouched: showcaseIds().has(String(mirrors[0]!['$id'])) } : null
}

test.describe('GitHub addresses (CJ-3)', () => {
  test('ga-1. /github.com/dashpay/dash opens the mirror', async ({ page }) => {
    const mirror = await dashMirror()
    test.skip(mirror === null, 'no single mirror of github.com/dashpay/dash on this devnet')
    test.skip(!mirror!.vouched, 'the mirror is not in the showcase: a claim alone opens nothing (ga-5)')
    const { errors } = collectPageErrors(page)
    await page.goto('/github.com/dashpay/dash', { waitUntil: 'domcontentloaded' })
    await expect(page).toHaveURL(atRoute(new RegExp(`/repo/\\?${await ownerIs(mirror!.owner)}&name=dash&repo=${mirror!.id}`)), { timeout: 60_000 })
    await expect(page.getByTestId('repo-title').filter({ hasText: 'dash' })).toBeVisible({ timeout: 60_000 })
    await shot(page, 'ga-01-github-alias')
    expect(errors, errors.join('\n')).toEqual([])
  })

  test('ga-2. /dashpay/dash/issues, which names no Forge repo, opens the mirror’s issues', async ({ page }) => {
    const mirror = await dashMirror()
    test.skip(mirror === null, 'no single mirror of github.com/dashpay/dash on this devnet')
    test.skip(!mirror!.vouched, 'the mirror is not in the showcase: a claim alone opens nothing (ga-5)')
    await page.goto('/dashpay/dash/issues', { waitUntil: 'domcontentloaded' })
    await expect(page).toHaveURL(atRoute(new RegExp(`/repo/issues/\\?${await ownerIs(mirror!.owner)}&name=dash&repo=${mirror!.id}`)), { timeout: 60_000 })
  })

  test('ga-4. the rest of a GitHub path opens the same page of the mirror; an unknown one, its home', async ({ page }) => {
    const mirror = await dashMirror()
    test.skip(mirror === null, 'no single mirror of github.com/dashpay/dash on this devnet')
    test.skip(!mirror!.vouched, 'the mirror is not in the showcase: a claim alone opens nothing (ga-5)')
    await page.goto('/github.com/dashpay/dash/pulls', { waitUntil: 'domcontentloaded' })
    await expect(page).toHaveURL(atRoute(new RegExp(`/repo/pulls/\\?${await ownerIs(mirror!.owner)}&name=dash&repo=${mirror!.id}`)), { timeout: 60_000 })
    await page.goto('/github.com/dashpay/dash/actions', { waitUntil: 'domcontentloaded' })
    await expect(page).toHaveURL(atRoute(new RegExp(`/repo/\\?${await ownerIs(mirror!.owner)}&name=dash&repo=${mirror!.id}`)), { timeout: 60_000 })
  })

  test('ga-5. a mirror the showcase does not vouch for is offered, as a claim, never opened', async ({ page }) => {
    const mirror = await dashMirror()
    test.skip(mirror === null || mirror.vouched, 'needs a single, unvouched mirror of github.com/dashpay/dash')
    await page.goto('/github.com/dashpay/dash', { waitUntil: 'domcontentloaded' })
    const chooser = page.getByTestId('alias-mirrors')
    await expect(chooser).toBeVisible({ timeout: 60_000 })
    await expect(chooser.getByTestId('alias-claim')).toContainText('says it mirrors github.com/dashpay/dash')
    await expect(page).toHaveURL(/\/github\.com\/dashpay\/dash/)
  })

  test('ga-3. a GitHub repo with no mirror says so and offers to mirror it', async ({ page }) => {
    await page.goto('/github.com/forge-e2e-nobody/no-such-repo-here', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'github.com/forge-e2e-nobody/no-such-repo-here isn’t mirrored here yet' })).toBeVisible({ timeout: 60_000 })
    await shot(page, 'ga-03-not-mirrored')
    await page.getByTestId('alias-mirror').click()
    await expect(page).toHaveURL(/\/mirror\/\?repo=forge-e2e-nobody%2Fno-such-repo-here/)
    await expect(page.locator('#mirror-github')).toHaveValue('forge-e2e-nobody/no-such-repo-here', { timeout: 30_000 })
  })
})
