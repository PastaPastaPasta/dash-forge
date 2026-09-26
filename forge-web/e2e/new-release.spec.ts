import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import { E2E_DEVNET, idFile, runAxe, shot, signedIn, stateFile } from './helpers'

/**
 * Publishing a release from the browser, live on a devnet with the local MinIO reachable at a
 * PUBLIC https address (a manifest or release may record only addresses anyone can read):
 *
 *   docker compose -f infra/docker-compose.yml up -d minio minio-init
 *   cloudflared tunnel --url http://127.0.0.1:9000        # prints https://<name>.trycloudflare.com
 *   E2E_DEVNET=moutai E2E_WRITE=1 E2E_PUBLIC_MINIO=https://<name>.trycloudflare.com/forge-byo \
 *     pnpm exec playwright test new-release.spec.ts
 *
 * As MAINTAINER, on its own forge-v2-empty: add the bucket in Settings → Storage (the API over
 * loopback, the public URL over the tunnel; every row passes), then publish a release with one
 * asset. The asset is uploaded with SigV4, verified through the public URL, and the release
 * lists it; downloading it re-hashes it and saves only on a match.
 */

const PUBLIC = (process.env['E2E_PUBLIC_MINIO'] ?? '').replace(/\/+$/, '')
test.skip(E2E_DEVNET === '' || process.env['E2E_WRITE'] !== '1' || !PUBLIC.startsWith('https://'), 'needs E2E_DEVNET, E2E_WRITE=1 and E2E_PUBLIC_MINIO (a public https URL for the forge-byo bucket)')
test.skip(!existsSync(idFile('MAINTAINER')), 'devnet test identities not found')
test.describe.configure({ mode: 'serial', timeout: 300_000 })

const REPO = '/repo/releases/?owner=GKBTXUdo3MpRYAUqgZvTZGTav9mXGqfJfR5822K2tp79&name=forge-v2-empty'
const TAG = `e2e-${Date.now().toString(36)}`

test('r1. a maintainer adds public storage and publishes a release with an asset', async ({ browser }) => {
  const page = await signedIn(browser, 'MAINTAINER', '/settings/storage/')
  await expect(page.getByRole('heading', { name: 'Your storage' })).toBeVisible({ timeout: 30_000 })
  page.on('dialog', (d) => void d.accept())
  while ((await page.getByRole('button', { name: /^remove /i }).count()) > 0) {
    await page.getByRole('button', { name: /^remove /i }).first().click()
    await page.waitForTimeout(500)
  }
  await page.getByTestId('tile-minio').click()
  await page.getByLabel('Profile name', { exact: true }).fill('minio-public')
  await page.getByLabel('S3 endpoint', { exact: true }).fill('http://127.0.0.1:9000')
  await page.getByLabel('Region', { exact: true }).fill('us-east-1')
  await page.getByLabel('Bucket', { exact: true }).fill('forge-byo')
  await page.getByLabel('Public URL', { exact: true }).fill(PUBLIC)
  await page.getByLabel(/^Key prefix/).fill('e2e-release')
  await page.getByLabel('Access key id', { exact: true }).fill('minioadmin')
  await page.getByLabel('Secret access key', { exact: true }).fill('minioadmin')
  await page.getByRole('button', { name: /^test$/i }).click()
  for (const row of ['put', 'get', 'public', 'range', 'cors-put', 'delete']) {
    await expect(page.getByTestId(`probe-${row}`)).toHaveAttribute('data-state', 'ok', { timeout: 90_000 })
  }
  await page.getByRole('button', { name: /save profile/i }).click()
  await expect(page.getByTestId('profile-list')).toContainText('passed')
  await page.getByRole('checkbox', { name: 'minio-public' }).first().check()
  await page.getByRole('radio', { name: /one place/i }).check()
  await page.getByRole('button', { name: /save default/i }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  await page.context().storageState({ path: stateFile('MAINTAINER'), indexedDB: true })

  await page.goto(REPO, { waitUntil: 'domcontentloaded' })
  const { unlock } = await import('./helpers')
  await unlock(page)
  await page.getByRole('button', { name: /new release/i }).click({ timeout: 60_000 })
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Tag').fill(TAG)
  await dialog.getByLabel('Title (optional)').fill(`Release ${TAG}`)
  await dialog.getByLabel('Notes (optional)').fill('Published from the browser by the e2e suite.')
  await dialog.locator('input[type="file"]').setInputFiles({ name: `${TAG}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`asset for ${TAG}\n`) })
  await expect(dialog.getByTestId('cost-preview')).toBeVisible()
  expect(await runAxe(page, 'new release dialog')).toEqual([])
  await shot(page, 'r-01-new-release')
  await dialog.getByRole('button', { name: /sign & publish/i }).click()
  await expect(dialog.getByTestId(`asset-${TAG}.txt`)).toHaveAttribute('data-state', 'done', { timeout: 120_000 })
  await expect(dialog).toBeHidden({ timeout: 120_000 })

  // The node answering may be a block behind: reload until the release shows.
  await expect(async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByText(`Release ${TAG}`)).toBeVisible({ timeout: 15_000 })
  }).toPass({ timeout: 120_000 })
  await shot(page, 'r-02-published')

  // Download: streamed through SHA-256, saved only on a match.
  const card = page.locator('li', { hasText: `Release ${TAG}` }).first()
  const download = page.waitForEvent('download')
  await card.getByRole('button', { name: new RegExp(`${TAG}\\.txt`) }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe(`${TAG}.txt`)
})
