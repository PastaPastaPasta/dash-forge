import { test, expect, type Page } from '@playwright/test'
import {
  collectPageErrors,
  DEMO,
  deployment,
  expectLanded,
  nodeSdk,
  repoUrl,
  shot,
  waitForRepoResolved,
} from './helpers'

/**
 * In-browser fallback clone, on the forge-v2 read fixture (e2e/helpers.ts `DEMO`).
 *
 * The fixture publishes an objectLocator, so the fallback is forced: every `chunk` query for a
 * locator artifact (kind 1) is answered with a gRPC NOT_FOUND, so the locator cannot load.
 * `loadBrowseContext` treats an index that will not load as `index-behind` and routes to the
 * fallback. The fallback downloads the live kind-0 packs from their Platform `chunk` documents
 * (still served), indexes them client-side, and serves the root tree / README from the index it
 * built. The fixture's packs are far below 2 MB, so the clone starts on its own; the spec
 * still handles the explicit "Load repo in browser (~X MB)" action. In-app navigation and a hard
 * reload afterwards must reuse the browser-cached clone (no second prompt or pack download).
 *
 * Reads travel as gRPC-web POSTs to DAPI; a `getDocuments` request body carries the queried
 * `packHash` operand as base64, which is what the route below matches on.
 */

/** The fixture's locator packHashes, base64 as they appear in a `chunk` query's body. */
async function locatorPackHashes(): Promise<string[]> {
  const sdk = await nodeSdk()
  const core = deployment().v2.forgeCore.contractId
  const repos = await sdk.documents.query({
    dataContractId: core,
    documentTypeName: 'repo',
    where: [
      ['$ownerId', '==', DEMO.owner],
      ['name', '==', DEMO.name],
    ],
    limit: 1,
  })
  const repo = [...repos.values()][0]
  if (!repo) throw new Error(`fixture repo ${DEMO.name} not found: seed it with forge-contracts/scripts/seed-v2-fixture.mjs`)
  const manifests = await sdk.documents.query({
    dataContractId: core,
    documentTypeName: 'packManifest',
    where: [['repoId', '==', repo.id.toBase58()]],
    orderBy: [['$createdAt', 'desc']],
    limit: 100,
  })
  const hashes = [...manifests.values()]
    .map((d) => d.toJSON() as { kind: number; packHash: string })
    .filter((m) => m.kind === 1)
    .map((m) => m.packHash)
  if (hashes.length === 0) throw new Error(`fixture repo ${DEMO.name} has no objectLocator to block`)
  return hashes
}

/** Fail every DAPI `chunk` query for one of `hashes` with NOT_FOUND; count the blocks. */
async function blockLocatorChunks(page: Page, hashes: readonly string[]): Promise<{ blocked: number }> {
  const needles = hashes.map((h) => Buffer.from(h))
  const stats = { blocked: 0 }
  await page.route(
    (url) => url.pathname.endsWith('/org.dash.platform.dapi.v0.Platform/getDocuments'),
    async (route) => {
      const body = route.request().postDataBuffer()
      if (body === null || !needles.some((n) => body.includes(n))) return route.continue()
      stats.blocked++
      return route.fulfill({
        status: 200,
        body: '',
        headers: {
          'content-type': 'application/grpc-web+proto',
          'grpc-status': '5',
          'grpc-message': 'blocked by fallback-browse.spec',
          'access-control-allow-origin': (await route.request().headerValue('origin')) ?? '*',
          'access-control-expose-headers': 'grpc-status,grpc-message',
        },
      })
    },
  )
  return stats
}

test.describe('in-browser fallback clone (locator unavailable)', () => {
  test('repo home clones + indexes in-browser, then navigation and reload reuse the cache', async ({
    page,
  }) => {
    const { errors } = collectPageErrors(page)
    const stats = await blockLocatorChunks(page, await locatorPackHashes())
    await page.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)

    // The fallback must engage: auto-load progress, the explicit load action, or (already
    // done) the local-copy notice. The app's read-error state is a meaningful failure.
    const loadButton = page.getByRole('button', { name: /load repo in browser/i })
    const engaged = page
      .getByText(/preparing in-browser clone|downloading packs|indexing objects|copy loaded into your browser/i)
      .first()
    await expectLanded(page, loadButton.or(engaged))
    if (await loadButton.isVisible().catch(() => false)) {
      await loadButton.click() // > 2 MB of live packs: the explicit opt-in path
    }

    // The fallback completes: quiet notice + the real root tree rendered from the index it built.
    await expect(page.getByText(/copy loaded into your browser/i)).toBeVisible({ timeout: 60_000 })
    const readme = page.getByRole('link', { name: 'README.md', exact: true }).first()
    await expect(readme).toBeVisible({ timeout: 30_000 })
    expect(stats.blocked, 'the locator was never requested, so nothing forced the fallback').toBeGreaterThan(0)
    await shot(page, 'fallback-01-home')

    // In-app navigation (SPA route change) reuses the module-level session cache: content
    // renders again with no re-download prompt.
    await page.getByRole('link', { name: 'src', exact: true }).first().click()
    await page.getByRole('link', { name: 'main.rs', exact: true }).first().click()
    await expect(page.getByText('reads are proof-checked').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/copy loaded into your browser/i)).toBeVisible()
    await expect(loadButton).toHaveCount(0)
    await shot(page, 'fallback-02-blob')

    // A full document reload clears module state. The persisted verified packs + locator must
    // restore the reader without returning to the download opt-in state.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    await expect(page.getByText(/copy loaded into your browser/i)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('reads are proof-checked').first()).toBeVisible({ timeout: 30_000 })
    await expect(loadButton).toHaveCount(0)

    expect(errors, `uncaught page errors:\n${errors.join('\n')}`).toEqual([])
  })
})
