import { test, expect } from '@playwright/test'
import { collectPageErrors, deployment, nodeSdk, shot } from './helpers'

/**
 * CJ-3: a GitHub address opens its Forge mirror, signed out, reads only.
 *
 *   E2E_DEVNET=sakura pnpm exec playwright test github-alias.spec.ts
 *
 * The mirror cases need a repo named `dash` whose description says it mirrors
 * github.com/dashpay/dash (the showcase mirror); they skip where there is none, or more than one.
 */

const MIRROR_OF = /\(mirror of github\.com\/dashpay\/dash\)$|^Mirror of github\.com\/dashpay\/dash$/i

/** The one public, non-fork `dash` repo that claims to mirror github.com/dashpay/dash, read in Node. */
async function dashMirror(): Promise<{ owner: string; id: string } | null> {
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
  return mirrors.length === 1 ? { owner: String(mirrors[0]!['$ownerId']), id: String(mirrors[0]!['$id']) } : null
}

test.describe('GitHub addresses (CJ-3)', () => {
  test('ga-1. /github.com/dashpay/dash opens the mirror', async ({ page }) => {
    const mirror = await dashMirror()
    test.skip(mirror === null, 'no single mirror of github.com/dashpay/dash on this devnet')
    const { errors } = collectPageErrors(page)
    await page.goto('/github.com/dashpay/dash', { waitUntil: 'domcontentloaded' })
    await expect(page).toHaveURL(new RegExp(`/repo/\\?owner=${mirror!.owner}&name=dash&repo=${mirror!.id}`), { timeout: 60_000 })
    await expect(page.getByTestId('repo-title').filter({ hasText: 'dash' })).toBeVisible({ timeout: 60_000 })
    await shot(page, 'ga-01-github-alias')
    expect(errors, errors.join('\n')).toEqual([])
  })

  test('ga-2. /dashpay/dash/issues, which names no Forge repo, opens the mirror’s issues', async ({ page }) => {
    const mirror = await dashMirror()
    test.skip(mirror === null, 'no single mirror of github.com/dashpay/dash on this devnet')
    await page.goto('/dashpay/dash/issues', { waitUntil: 'domcontentloaded' })
    await expect(page).toHaveURL(new RegExp(`/repo/issues/\\?owner=${mirror!.owner}&name=dash&repo=${mirror!.id}`), { timeout: 60_000 })
  })

  test('ga-4. the rest of a GitHub path opens the same page of the mirror; an unknown one, its home', async ({ page }) => {
    const mirror = await dashMirror()
    test.skip(mirror === null, 'no single mirror of github.com/dashpay/dash on this devnet')
    await page.goto('/github.com/dashpay/dash/pulls', { waitUntil: 'domcontentloaded' })
    await expect(page).toHaveURL(new RegExp(`/repo/pulls/\\?owner=${mirror!.owner}&name=dash&repo=${mirror!.id}`), { timeout: 60_000 })
    await page.goto('/github.com/dashpay/dash/actions', { waitUntil: 'domcontentloaded' })
    await expect(page).toHaveURL(new RegExp(`/repo/\\?owner=${mirror!.owner}&name=dash&repo=${mirror!.id}`), { timeout: 60_000 })
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
