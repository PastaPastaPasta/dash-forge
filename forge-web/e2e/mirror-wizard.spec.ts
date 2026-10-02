import { test, expect, type Page, type Route } from '@playwright/test'
import { existsSync } from 'node:fs'
import { EMPTY, E2E_DEVNET, PASSPHRASE, fixtureWriteBlocked, idFile, runAxe, shot, signedIn, unlock } from './helpers'

/**
 * The `/mirror` wizard up to the workflow file, with every write mocked (item 16,
 * `ux-dx-spec.md` §1(b)), live on a devnet build because the steps after the first need a
 * signed-in identity:
 *
 *   E2E_DEVNET=sakura E2E_WRITE=1 pnpm exec playwright test mirror-wizard.spec.ts
 *
 * m1 needs no identity and runs in the read-only CI job too; m2 and m3 need `E2E_WRITE=1`.
 *
 * GitHub's API is answered by the spec (no network, no rate limit). The Forge repository is the
 * read fixture's `forge-v2-empty` (MAINTAINER's), which the wizard finds and reuses, so nothing
 * is created. The storage is an R2 profile saved in this browser only (its checks fail: the
 * bucket does not exist). The runner key's identity update is stopped in the browser before it
 * leaves (every `broadcastStateTransition` is aborted), then the wizard's "I have a runner key"
 * path continues to the workflow.
 *
 * m1. signed out: a private or missing repo is refused with the reason; a public one is shown,
 *     and the next step asks to sign in.
 * m2. signed in: GitHub → the existing Forge repo (no cost) → an R2 bucket (and its CORS fix) →
 *     the runner key form (budget, expiry, master key, fee), whose write never reaches Platform →
 *     the workflow file, which names the repo, network, devnet, storage and pinned commit, and
 *     the three secrets to add first. A reload in the middle resumes where it stopped.
 * m3. the same page at 390 px in the dark theme: no horizontal scroll, and axe finds nothing
 *     serious.
 *
 * Signs in as MAINTAINER (first run: registers one limited key; later runs reuse the vault).
 */

test.describe.configure({ mode: 'serial', timeout: 300_000 })

/** m2 signs in (a vault, and on its first run a new browser key): only with E2E_WRITE=1. */
function skipUnlessSignedIn(): void {
  test.skip(process.env['E2E_WRITE'] !== '1', 'needs a signed-in vault: set E2E_WRITE=1')
  test.skip(!existsSync(idFile('MAINTAINER')), 'devnet test identities not found')
  test.skip(fixtureWriteBlocked('empty') !== null, fixtureWriteBlocked('empty') ?? '')
}

const SHA = '0123456789abcdef0123456789abcdef01234567'
const GH = { owner: 'mirror-e2e', name: 'Forge-V2-Empty' }
const BROADCAST = /\/org\.dash\.platform\.dapi\.v0\.Platform\/broadcastStateTransition$/
const R2 = { endpoint: 'https://e2eaccount.r2.cloudflarestorage.com', bucket: 'forge-e2e', publicUrl: 'https://packs.e2e-mirror.example' }

/** GitHub's REST API, answered here: one public repository, one missing, and the Dash Forge pin. */
async function fakeGithub(page: Page): Promise<string[]> {
  const asked: string[] = []
  await page.route('https://api.github.com/**', async (route: Route) => {
    const url = new URL(route.request().url())
    asked.push(url.pathname)
    const cors = { 'access-control-allow-origin': '*' }
    if (url.pathname === `/repos/${GH.owner}/${GH.name}`) {
      return route.fulfill({
        status: 200,
        headers: { ...cors, 'content-type': 'application/json' },
        body: JSON.stringify({
          full_name: `${GH.owner}/${GH.name}`,
          private: false,
          visibility: 'public',
          description: 'The e2e mirror source',
          default_branch: 'main',
          size: 42,
          archived: false,
          fork: false,
          html_url: `https://github.com/${GH.owner}/${GH.name}`,
        }),
      })
    }
    if (url.pathname === '/repos/PastaPastaPasta/dash-forge/commits/master') return route.fulfill({ status: 200, headers: cors, body: SHA })
    return route.fulfill({ status: 404, headers: { ...cors, 'content-type': 'application/json' }, body: '{"message":"Not Found"}' })
  })
  return asked
}

/** The bucket and its public URL do not exist: every request to them fails at once. */
async function noBucket(page: Page): Promise<void> {
  await page.route(`${R2.endpoint}/**`, (r) => r.abort('connectionrefused'))
  await page.route(`${R2.publicUrl}/**`, (r) => r.abort('connectionrefused'))
}

async function checkGithub(page: Page, text: string): Promise<void> {
  await page.getByLabel('GitHub repository').fill(text)
  await page.getByRole('button', { name: 'Check on GitHub' }).click()
}

const step = (page: Page, id: string) => page.getByTestId(`mirror-step-${id}`)

/** The storage choice the wizard saved for this identity in IndexedDB (`lib/mirror/progress.ts`). */
function savedStorageChoice(page: Page): Promise<string | null> {
  return page.evaluate(
    (key) =>
      new Promise<string | null>((resolve) => {
        const req = indexedDB.open('dash-forge')
        req.onsuccess = () => {
          const get = req.result.transaction('journal', 'readonly').objectStore('journal').get(key)
          get.onsuccess = () => resolve((get.result as { storage?: string } | undefined)?.storage ?? null)
          get.onerror = () => resolve(null)
        }
        req.onerror = () => resolve(null)
      }),
    `mirror-wizard:devnet-${E2E_DEVNET}:${EMPTY.owner}`,
  )
}

test('m1. signed out: GitHub is checked anonymously, and the next step asks to sign in', async ({ page }) => {
  const asked = await fakeGithub(page)
  await page.goto('/mirror/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Mirror a GitHub repository', level: 1 })).toBeVisible()
  await expect(step(page, 'github')).toHaveAttribute('data-state', 'active')

  await checkGithub(page, 'someone/private-thing')
  await expect(step(page, 'github').getByRole('alert')).toContainText('not found, or it is private')
  await checkGithub(page, 'not a repo')
  await expect(step(page, 'github').getByRole('alert')).toContainText('owner/name')

  await checkGithub(page, `https://github.com/${GH.owner}/${GH.name}/tree/main`)
  const found = page.getByTestId('mirror-github-found')
  await expect(found).toContainText(`github.com/${GH.owner}/${GH.name}`)
  await expect(found).toContainText('default branch main')
  expect(asked).toContain(`/repos/${GH.owner}/${GH.name}`)
  await shot(page, 'mirror-01-github-found')
  await found.getByRole('button', { name: `Mirror ${GH.owner}/${GH.name}` }).click()
  await expect(step(page, 'github')).toHaveAttribute('data-state', 'done')
  await expect(step(page, 'repo')).toHaveAttribute('data-state', 'active')
  await expect(page.getByTestId('mirror-signin')).toBeVisible()
  await shot(page, 'mirror-02-sign-in')
})

test('m2. signed in: repo, storage, runner key and workflow, with no write reaching Platform', async ({ browser }) => {
  skipUnlessSignedIn()
  const page = await signedIn(browser, 'MAINTAINER', '/mirror/')
  await fakeGithub(page)
  await noBucket(page)
  let broadcasts = 0
  await page.route(BROADCAST, (r) => {
    broadcasts++
    return r.abort('failed')
  })
  page.on('dialog', (d) => void d.accept())
  // The saved vault is captured right after sign-in, so every run starts with no progress.
  await expect(step(page, 'github')).toHaveAttribute('data-state', 'active')

  // 1. GitHub.
  await checkGithub(page, `${GH.owner}/${GH.name}`)
  await page.getByTestId('mirror-github-found').getByRole('button', { name: /^Mirror / }).click()

  // 2. The Forge repo: the lowercased name is MAINTAINER's empty fixture, so it is reused.
  await expect(step(page, 'repo')).toHaveAttribute('data-state', 'active')
  await expect(page.getByLabel('Forge repository name')).toHaveValue(EMPTY.name)
  const existing = page.getByTestId('mirror-repo-existing')
  await expect(existing).toContainText(`You already have ${EMPTY.name}`, { timeout: 60_000 })
  await expect(existing).toContainText('no cost')
  await shot(page, 'mirror-03-repo-existing')
  // Another name is priced before anything is signed.
  await page.getByLabel('Forge repository name').fill('mirror-e2e-never-created')
  await expect(step(page, 'repo').getByTestId('cost-preview')).toBeVisible({ timeout: 60_000 })
  await expect(step(page, 'repo').getByRole('button', { name: /Sign & create mirror-e2e-never-created/ })).toBeEnabled()
  await expect(step(page, 'repo')).toContainText('The e2e mirror source (mirror of github.com/mirror-e2e/Forge-V2-Empty)')
  await page.getByLabel('Forge repository name').fill(EMPTY.name)
  await existing.getByRole('button', { name: `Mirror into ${EMPTY.name}` }).click()

  // 3. Storage: an R2 bucket added through the storage wizard, then picked for the mirror.
  await expect(step(page, 'storage')).toHaveAttribute('data-state', 'active')
  await expect(page.getByTestId('mirror-storage-platform')).toBeVisible()
  await step(page, 'storage').getByRole('button', { name: /Add a bucket/ }).click()
  const wizard = page.getByTestId('mirror-storage-wizard')
  await wizard.getByTestId('tile-r2').click()
  await wizard.getByLabel('Profile name', { exact: true }).fill('r2-mirror-e2e')
  await wizard.getByLabel('S3 endpoint', { exact: true }).fill(R2.endpoint)
  await wizard.getByLabel('Bucket', { exact: true }).fill(R2.bucket)
  await wizard.getByLabel('Public URL', { exact: true }).fill(R2.publicUrl)
  await wizard.getByLabel('Access key id', { exact: true }).fill('E2EACCESSKEYID')
  await wizard.getByLabel('Secret access key', { exact: true }).fill('e2e-secret-access-key')
  await wizard.getByRole('button', { name: /^test$/i }).click()
  await expect(wizard.getByText(/Some checks failed/)).toBeVisible({ timeout: 60_000 })
  await wizard.getByRole('button', { name: /save profile/i }).click()
  // Saved: picked for the mirror at once, with its CORS fix.
  await expect(page.getByRole('radio', { name: /r2-mirror-e2e/ })).toBeChecked({ timeout: 30_000 })
  const cors = page.getByTestId('mirror-cors')
  await cors.locator('summary').click()
  await expect(cors).toContainText(`R2 → ${R2.bucket} → Settings → CORS Policy`)
  await expect(cors).toContainText('"AllowedMethods"')
  await shot(page, 'mirror-04-storage-r2')
  await step(page, 'storage').getByRole('button', { name: 'Use r2-mirror-e2e' }).click()

  // Resumable: a reload comes back to the runner key, steps 1-3 answered.
  await expect(step(page, 'storage')).toHaveAttribute('data-state', 'done')
  await expect.poll(() => savedStorageChoice(page), { timeout: 10_000 }).toBe('r2-mirror-e2e')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await unlock(page)
  await expect(step(page, 'key')).toHaveAttribute('data-state', 'active', { timeout: 60_000 })
  await expect(step(page, 'github')).toContainText(`github.com/${GH.owner}/${GH.name}`)
  await expect(step(page, 'repo')).toContainText(EMPTY.name)
  await expect(step(page, 'storage')).toContainText('r2-mirror-e2e')

  // 4. The runner key: the form, then a registration stopped before it leaves the browser.
  const key = step(page, 'key')
  await key.getByLabel('Budget (DASH)').fill('0.25')
  await key.getByLabel('Expires after (days)').fill('30')
  await expect(key.getByTestId('cost-preview')).toBeVisible()
  await key.getByLabel('Identity file for the runner key').setInputFiles(idFile('MAINTAINER'))
  await expect(key.getByRole('button', { name: /Choose the identity file|MAINTAINER/ })).toContainText('MAINTAINER')
  await shot(page, 'mirror-05-runner-key-form')
  const create = key.getByRole('button', { name: /Sign once & create the runner key/ })
  await expect(create).toBeEnabled()
  await create.click()
  await expect(key.getByRole('alert').first()).toBeVisible({ timeout: 180_000 })
  expect(broadcasts, 'the identity update was attempted, and stopped in the browser').toBeGreaterThan(0)
  await expect(key.getByText(/Key \d+ is on your identity/)).toHaveCount(0)
  // A key made with dg instead.
  await key.getByRole('button', { name: /I have a runner key already/ }).click()
  await expect(key).toContainText('dg auth export --new-key --budget 0.5 --expires 365d --format dfk1 --reveal-secrets -o runner.dfk1')
  await key.getByRole('button', { name: 'I added DASH_FORGE_KEY myself' }).click()

  // 5. The workflow file and its secrets. The reloaded tab holds only its signing key: the
  // bucket's settings (sealed in the vault) open with the passphrase first.
  const wf = step(page, 'workflow')
  await expect(wf).toHaveAttribute('data-state', 'active')
  const more = page.getByTestId('mirror-workflow-unlock')
  await expect(more.or(page.getByLabel('Dash Forge commit'))).toBeVisible({ timeout: 30_000 })
  if (await more.isVisible()) {
    await more.getByLabel('Passphrase').fill(PASSPHRASE)
    await more.getByRole('button', { name: 'Unlock' }).click()
  }
  // The build's own commit when it has one (a CI build), else the latest on master (faked here).
  await expect(page.getByLabel('Dash Forge commit')).toHaveValue(/^[0-9a-f]{40}$/, { timeout: 60_000 })
  const commit = await page.getByLabel('Dash Forge commit').inputValue()
  const secrets = page.getByTestId('mirror-secrets')
  for (const name of ['DASH_FORGE_KEY', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) await expect(secrets).toContainText(name)
  await expect(page.getByTestId('mirror-new-secret')).toHaveAttribute('href', `https://github.com/${GH.owner}/${GH.name}/settings/secrets/actions/new`)
  const yaml = await page.getByTestId('mirror-yaml').locator('pre').innerText()
  for (const line of [
    `repo: 'dash://${EMPTY.owner}/${EMPTY.name}'`,
    "network: 'devnet'",
    `devnet-name: '${E2E_DEVNET}'`,
    "storage-kind: 's3'",
    `s3-endpoint: '${R2.endpoint}'`,
    `s3-bucket: '${R2.bucket}'`,
    `s3-public-url: '${R2.publicUrl}'`,
    // Code and releases only by default, as in the Action (QW4-045).
    "sync: 'code,releases'",
    `uses: PastaPastaPasta/dash-forge/action@${commit}`,
    "install: 'source'",
    'S3_ACCESS_KEY_ID: ${{ secrets.S3_ACCESS_KEY_ID }}',
  ]) {
    expect(yaml, line).toContain(line)
  }
  // Never a secret's value.
  expect(yaml).not.toContain('E2EACCESSKEYID')
  const href = await page.getByTestId('mirror-create-workflow').getAttribute('href')
  const url = new URL(href ?? '')
  expect(url.origin + url.pathname).toBe(`https://github.com/${GH.owner}/${GH.name}/new/main`)
  expect(url.searchParams.get('filename')).toBe('.github/workflows/forge-mirror.yml')
  expect(url.searchParams.get('value')?.trim()).toBe(yaml.trim())
  await shot(page, 'mirror-06-workflow')
  expect(yaml).not.toContain('pull_request_target')
  // Issues and PRs, ticked: their triggers come; unticked, they go again.
  const collab = wf.getByRole('checkbox', { name: /Mirror issues and pull requests too/ })
  await collab.check()
  await expect(page.getByTestId('mirror-yaml')).toContainText('pull_request_target')
  await expect(page.getByTestId('mirror-yaml')).toContainText("sync: 'code,releases,labels,issues,prs'")
  await collab.uncheck()
  await expect(page.getByTestId('mirror-yaml')).not.toContainText('pull_request_target')
  await expect(page.getByTestId('mirror-yaml')).toContainText("sync: 'code,releases'")
  await wf.getByRole('checkbox', { name: /I added the secrets and committed the workflow/ }).check()
  await wf.getByRole('button', { name: 'Watch for the first run' }).click()

  // 6. Waiting: the fixture has nothing pushed, so the page keeps checking.
  await expect(page.getByTestId('mirror-waiting')).toBeVisible()
  await expect(page.getByTestId('mirror-runs-link')).toHaveAttribute('href', `https://github.com/${GH.owner}/${GH.name}/actions/workflows/forge-mirror.yml`)
  await shot(page, 'mirror-07-waiting')
  expect(broadcasts).toBeGreaterThan(0)

  // m3 (same page): the workflow step at 390 px, dark.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await wf.getByRole('button', { name: /^Change/ }).click()
  await expect(page.getByTestId('mirror-yaml')).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  // The Copy button sits above the YAML, never over its first line (QW4-045).
  const copyBox = await page.getByTestId('mirror-yaml').getByRole('button', { name: 'Copy the workflow file' }).boundingBox()
  const preBox = await page.getByTestId('mirror-yaml').locator('pre').boundingBox()
  expect(copyBox!.y + copyBox!.height).toBeLessThanOrEqual(preBox!.y + 0.5)
  await shot(page, 'mirror-08-workflow-390-dark')
  const serious = await runAxe(page, 'mirror-wizard')
  expect(serious, serious.map((v) => `${v.id}: ${v.help}`).join('\n')).toEqual([])
})
