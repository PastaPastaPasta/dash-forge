import { test, expect, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { EMPTY, fixtureWriteBlocked, idFile, runAxe, shot, signedIn, stateFile, unlock } from './helpers'

/**
 * The storage wizard (`/settings/storage`) against the local S3 store of infra/docker-compose.yml
 * (`forge-byo`: SigV4-signed writes, anonymous reads, CORS for any origin), live on a devnet
 * build because a vault needs a signed-in identity:
 *
 *   docker compose -f infra/docker-compose.yml up -d rustfs s3-init static-http
 *   E2E_DEVNET=bonsia E2E_WRITE=1 pnpm exec playwright test storage-wizard.spec.ts
 *
 * s1. on the local S3 store (RustFS, entered through the wizard's MinIO tile) every write,
 *     read, range and CORS row passes, and the public-read row fails with the reason a
 *     loopback address cannot be published; the profile is saved into the vault, never into
 *     localStorage; it survives a reload + unlock; a default policy is set.
 * s2. a reachable host with no CORS (the static nginx) fails the CORS rows and shows the
 *     copy-paste fix, prefilled with the bucket and this origin.
 * s3. a repo's own policy (its Settings → Your browser pushes).
 * s4. axe and a 390 px viewport.
 *
 * Signs in as MAINTAINER (first run: registers one limited key; later runs reuse the vault).
 */

test.skip(process.env['E2E_WRITE'] !== '1', 'needs a signed-in vault: set E2E_WRITE=1')
test.skip(!existsSync(idFile('MAINTAINER')), 'devnet test identities not found')
test.skip(fixtureWriteBlocked('empty') !== null, fixtureWriteBlocked('empty') ?? '')
test.describe.configure({ mode: 'serial', timeout: 240_000 })

const MINIO = { endpoint: 'http://127.0.0.1:9000', bucket: 'forge-byo', publicUrl: 'http://127.0.0.1:9000/forge-byo', key: 'minioadmin', secret: 'minioadmin' }
const EMPTY_REPO = EMPTY

async function fillS3(page: Page, v: { name: string; endpoint: string; bucket: string; publicUrl: string }): Promise<void> {
  await page.getByLabel('Profile name', { exact: true }).fill(v.name)
  await page.getByLabel('S3 endpoint', { exact: true }).fill(v.endpoint)
  await page.getByLabel('Region', { exact: true }).fill('us-east-1')
  await page.getByLabel('Bucket', { exact: true }).fill(v.bucket)
  await page.getByLabel('Public URL', { exact: true }).fill(v.publicUrl)
  await page.getByLabel(/^Key prefix/).fill('e2e-web')
  await page.getByLabel('Access key id', { exact: true }).fill(MINIO.key)
  await page.getByLabel('Secret access key', { exact: true }).fill(MINIO.secret)
}

test('s1. MinIO passes every browser check, and the profile is sealed in the vault', async ({ browser }) => {
  const page = await signedIn(browser, 'MAINTAINER', '/settings/storage/')
  // A rerun: remove what an earlier run saved, so this one starts from an empty list.
  await expect(page.getByRole('heading', { name: 'Your storage' })).toBeVisible({ timeout: 30_000 })
  page.on('dialog', (d) => void d.accept())
  while ((await page.getByRole('button', { name: /^remove /i }).count()) > 0) {
    await page.getByRole('button', { name: /^remove /i }).first().click()
    await page.waitForTimeout(500)
  }
  await shot(page, 'a-01-storage-empty')
  await page.getByTestId('tile-minio').click()
  await fillS3(page, { name: 'minio-e2e', ...MINIO })
  await page.getByRole('button', { name: /^test$/i }).click()
  for (const row of ['put', 'get', 'range', 'cors-put', 'delete']) {
    await expect(page.getByTestId(`probe-${row}`)).toHaveAttribute('data-state', 'ok', { timeout: 60_000 })
  }
  // The anonymous read works from here, but 127.0.0.1 is not an address anyone else can read:
  // it would be recorded on chain, so the row fails and says why (uploads refuse it too).
  const publicRow = page.getByTestId('probe-public')
  await expect(publicRow).toHaveAttribute('data-state', 'fail')
  await expect(publicRow).toContainText(/Readable from here, but 127\.0\.0\.1:9000 is only reachable from this machine/)
  await expect(page.getByTestId('cors-fix')).toHaveCount(0)
  await shot(page, 'a-02-minio-tested')
  await page.getByRole('button', { name: /save profile/i }).click()
  await expect(page.getByTestId('profile-list')).toContainText('minio-e2e')
  await expect(page.getByTestId('profile-list')).toContainText('failed some checks')

  // Default policy: this profile, one copy.
  await page.getByRole('checkbox', { name: 'minio-e2e' }).first().check()
  await page.getByRole('radio', { name: /one place/i }).check()
  await page.getByRole('button', { name: /save default/i }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  // Later tests restore this context's IndexedDB: keep the (sealed) settings in it.
  await page.context().storageState({ path: stateFile('MAINTAINER'), indexedDB: true })

  // Secrets never reach localStorage; IndexedDB holds only ciphertext.
  const stores = await page.evaluate(async () => {
    const ls = JSON.stringify(Object.entries(localStorage))
    const idb = await new Promise<string>((resolve) => {
      const req = indexedDB.open('dash-forge')
      req.onsuccess = () => {
        const tx = req.result.transaction('vault', 'readonly')
        const all = tx.objectStore('vault').getAll()
        all.onsuccess = () => resolve(JSON.stringify(all.result, (_k, v: unknown) => (v instanceof Uint8Array ? `<${v.length} bytes>` : v)))
      }
    })
    return { ls, idb }
  })
  for (const s of [stores.ls, stores.idb]) {
    expect(s).not.toContain('minioadmin')
    expect(s).not.toContain('forge-byo')
  }

  // A reload locks the vault; the settings come back after unlocking.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await unlock(page)
  await expect(page.getByTestId('profile-list')).toContainText('minio-e2e', { timeout: 30_000 })
  await shot(page, 'a-03-profile-saved')
})

test('s2. a reachable host without CORS shows the copy-paste fix', async ({ browser }) => {
  const page = await signedIn(browser, 'MAINTAINER', '/settings/storage/')
  await page.getByTestId('tile-r2').click()
  await fillS3(page, { name: 'no-cors', endpoint: 'http://127.0.0.1:8082', bucket: 'my-bucket', publicUrl: 'http://127.0.0.1:8082/my-bucket' })
  await page.getByRole('button', { name: /^test$/i }).click()
  await expect(page.getByTestId('probe-cors-put')).toHaveAttribute('data-state', 'fail', { timeout: 60_000 })
  const fix = page.getByTestId('cors-fix')
  await expect(fix).toBeVisible()
  await expect(fix).toContainText('R2 → my-bucket → Settings → CORS Policy')
  await expect(fix).toContainText('"AllowedMethods"')
  await expect(fix).toContainText(new URL(page.url()).origin)
  await expect(fix).toContainText('x-amz-content-sha256')
  await shot(page, 'a-04-cors-fix')
  await page.getByRole('button', { name: /cancel/i }).click()
})

test('s3. a repo can override where browser pushes go', async ({ browser }) => {
  const page = await signedIn(browser, 'MAINTAINER', `/repo/settings/?owner=${EMPTY_REPO.owner}&name=${EMPTY_REPO.name}`)
  const box = page.getByTestId('repo-storage-policy')
  await expect(box).toContainText('Using your default', { timeout: 60_000 })
  await box.getByRole('combobox').selectOption('fallback')
  await box.getByRole('button', { name: /use for this repo/i }).click()
  await expect(box).toContainText('Saved for this repo.')
  await expect(box).toContainText('This repo has its own choice.')
  await shot(page, 'a-05-repo-policy')
  await box.getByRole('button', { name: /use my default/i }).click()
  await expect(box).toContainText('Back to your default.')
})

test('s4. accessible, and usable at 390 px', async ({ browser }) => {
  const page = await signedIn(browser, 'MAINTAINER', '/settings/storage/')
  await page.getByTestId('tile-r2').click()
  expect(await runAxe(page, 'storage wizard')).toEqual([])
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByText(/use a desktop browser for this step/i)).toBeVisible()
  await expect(page.getByTestId('tile-minio')).toBeVisible()
  await shot(page, 'a-06-mobile')
})
