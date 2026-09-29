import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import { E2E_DEVNET, idFile, repoUrl, shot, signedIn } from './helpers'

/**
 * Import and release fidelity (D-602, D-504, D-517, L-13, L-14), live on a devnet, against the
 * repos the CLI scenarios leave behind (run them first, with the same identity dir):
 *
 *   E2E_IDENTITY_DIR=<dir with OWNER/CONTRIB>  bash e2e/cli/run.sh 30 31
 *   E2E_IDENTITY_DIR=<same> E2E_IMPORTED=<owner>/<e2e-imp-…> E2E_RELEASES=<owner>/<repo> \
 *     E2E_RELEASE_TAG=<scenario 30's tag> pnpm exec playwright test import-release-fidelity.spec.ts
 *
 * f1. The imported repo's merged PRs read "Merged" in the list and on the PR page (D-602).
 * f2. Its release asset records a SHA-256 (D-517); the asset is on github.com, which a page
 *     cannot read (no CORS), so the main action is a direct download link and the page claims
 *     no verification (L-13).
 * f3. OWNER yanks scenario 30's release from the browser with only the Yanked box ticked: the
 *     yanked revision keeps its asset, title and notes (D-504).
 * f4. The rail's "Latest release" is the highest version, not the last-imported one (L-14).
 *
 * f3 writes as OWNER of E2E_IDENTITY_DIR: never the shared fixtures (the harness refuses to run
 * without E2E_IDENTITY_DIR).
 */

const IMPORTED = process.env['E2E_IMPORTED'] ?? ''
const RELEASES = process.env['E2E_RELEASES'] ?? ''
const TAG = process.env['E2E_RELEASE_TAG'] ?? ''
/** Scenario 31's source PR states (fixed history: a 2016 repository). */
const MERGED_AT_SOURCE = [1, 3, 4]
const CLOSED_AT_SOURCE = [2]
const repoOf = (spec: string): { owner: string; name: string } => {
  const [owner = '', name = ''] = spec.split('/')
  return { owner, name }
}

test.skip(E2E_DEVNET === '' || !process.env['E2E_IDENTITY_DIR'], 'needs E2E_DEVNET and E2E_IDENTITY_DIR (the spec writes as its OWNER)')
test.skip(!existsSync(idFile('OWNER')), 'OWNER identity not found in E2E_IDENTITY_DIR')
test.describe.configure({ mode: 'serial', timeout: 300_000 })

test('f1. imported merged PRs read Merged (D-602)', async ({ browser }) => {
  test.skip(IMPORTED === '', 'set E2E_IMPORTED to scenario 31 repo')
  const page = await browser.newPage()
  await page.goto(repoUrl('pulls', '', repoOf(IMPORTED)), { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'all', exact: true }).click({ timeout: 90_000 })
  const merged = page.getByRole('link').filter({ hasText: /Merged · into/ })
  await expect(merged.first()).toBeVisible({ timeout: 90_000 })
  // Scenario 31's source (PastaPastaPasta/dash-fork-checker): #1, #3 and #4 merged on GitHub,
  // #2 closed without merging. Each reads as it does there.
  for (const n of MERGED_AT_SOURCE) await expect(merged.filter({ hasText: `#${n} ` })).toHaveCount(1)
  await expect(page.getByRole('link').filter({ hasText: /Closed · into/ })).toHaveCount(CLOSED_AT_SOURCE.length)
  for (const n of CLOSED_AT_SOURCE) await expect(page.getByRole('link').filter({ hasText: `#${n} ` }).filter({ hasText: /Closed · into/ })).toHaveCount(1)
  await shot(page, 'fidelity-01-imported-pulls')
  await merged.first().click()
  await expect(page.getByText('Merged', { exact: true }).first()).toBeVisible({ timeout: 90_000 })
  await shot(page, 'fidelity-02-imported-pull-merged')
})

test('f2. an imported asset has a hash and a direct download, without a false verified claim (D-517, L-13)', async ({ browser }) => {
  test.skip(IMPORTED === '', 'set E2E_IMPORTED to scenario 31 repo')
  const page = await browser.newPage()
  await page.goto(repoUrl('releases', '', repoOf(IMPORTED)), { waitUntil: 'domcontentloaded' })
  const asset = page.getByTestId('release-asset').first()
  await expect(asset).toBeVisible({ timeout: 90_000 })
  await expect(asset).toHaveAttribute('data-state', 'origin')
  await expect(asset).toContainText(/sha256 [0-9a-f]{10}…/)
  await expect(asset.getByRole('link', { name: /download .* from github\.com/i })).toBeVisible()
  await expect(asset).toContainText('not checked yet')
  await expect(asset).not.toContainText('Verified')
  await shot(page, 'fidelity-03-imported-asset-origin')
})

test('f3. yanking from the browser keeps the release assets (D-504)', async ({ browser }) => {
  test.skip(RELEASES === '' || TAG === '', 'set E2E_RELEASES and E2E_RELEASE_TAG to scenario 30 repo and tag')
  const page = await signedIn(browser, 'OWNER', repoUrl('releases', '', repoOf(RELEASES)))
  const card = page.getByTestId('release').filter({ hasText: TAG }).first()
  await expect(card).toBeVisible({ timeout: 90_000 })
  const assetsBefore = await card.getByTestId('release-asset').count()
  expect(assetsBefore).toBeGreaterThan(0)
  await page.getByRole('button', { name: /new release/i }).click({ timeout: 60_000 })
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Tag').fill(TAG)
  await expect(dialog.getByRole('note')).toContainText(`keeps its ${assetsBefore === 1 ? '1 asset' : `${assetsBefore} assets`}`)
  await dialog.getByTestId('release-yanked').check()
  await shot(page, 'fidelity-04-yank-dialog')
  await dialog.getByRole('button', { name: /sign & publish/i }).click()
  await expect(dialog.getByRole('status')).toContainText('Release published.', { timeout: 120_000 })
  await dialog.getByRole('button', { name: /^close$/i }).click()
  const yanked = page.getByTestId('release').filter({ hasText: TAG }).filter({ hasText: /yanked/i }).first()
  await expect(yanked).toBeVisible({ timeout: 90_000 })
  await expect(yanked.getByTestId('release-asset')).toHaveCount(assetsBefore)
  await shot(page, 'fidelity-05-yanked-keeps-assets')
})

test('f4. the rail shows the highest version as the latest release (L-14)', async ({ browser }) => {
  const target = process.env['E2E_LATEST_REPO'] ?? ''
  const want = process.env['E2E_LATEST_TAG'] ?? ''
  test.skip(target === '' || want === '', 'set E2E_LATEST_REPO and E2E_LATEST_TAG (a repo with several releases)')
  const page = await browser.newPage()
  await page.goto(repoUrl('', '', repoOf(target)), { waitUntil: 'domcontentloaded' })
  const card = page.getByRole('region', { name: 'Latest release' })
  await card.scrollIntoViewIfNeeded({ timeout: 90_000 })
  // The tag (and here also the title, which GitHub set to the tag).
  await expect(card.getByText(want, { exact: true }).first()).toBeVisible({ timeout: 90_000 })
  await shot(page, 'fidelity-06-latest-release')
  // The releases page lists the highest version first too.
  await page.goto(repoUrl('releases', '', repoOf(target)), { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('release').first()).toContainText(want, { timeout: 90_000 })
  await shot(page, 'fidelity-07-releases-order')
})
