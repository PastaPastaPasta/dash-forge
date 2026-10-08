import { test, expect, type Request } from '@playwright/test'
import { existsSync } from 'node:fs'
import { idFile, PASSPHRASE, shot } from './helpers'

/**
 * P-1 follow-up: real writes through the DAPI request budget (`lib/sdk/budget.ts`). The rb-*
 * specs in rate-budget.spec.ts only read. This one registers a browser key (an identity
 * update) and creates a repo (a document create), both through the gate, and checks each
 * write reached `broadcastStateTransition` and `waitForStateTransitionResult` and landed.
 *
 *   E2E_WRITE=1 E2E_WRITE_IDENTITY=<identity.json> pnpm exec playwright test rate-budget-write.spec.ts
 *
 * Each run registers one new limited key on the identity and creates one repo, so point
 * E2E_WRITE_IDENTITY at a funded identity of your own (default: the CI-RUNNER fixture file).
 */

const IDENTITY = process.env['E2E_WRITE_IDENTITY'] ?? idFile('CI-RUNNER')

test.skip(process.env['E2E_WRITE'] !== '1', 'live devnet writes: set E2E_WRITE=1')
test.skip(!existsSync(IDENTITY), 'write identity not found')
test.describe.configure({ timeout: 240_000 })

const WRITE_METHOD = /\/org\.dash\.platform\.dapi\.v0\.Platform\/(broadcastStateTransition|waitForStateTransitionResult)$/

test('rbw-1. a browser key and a repo, written through the request budget', async ({ page }) => {
  const writes: string[] = []
  const synthetic: string[] = []
  page.on('request', (request: Request) => {
    const method = WRITE_METHOD.exec(request.url())?.[1]
    if (method !== undefined) writes.push(method)
  })
  page.on('response', async (response) => {
    // A refusal the gate made up (no network) has no envoy headers; count any on write calls.
    if (WRITE_METHOD.test(response.url()) && response.headers()['grpc-message'] === 'rate limited') synthetic.push(response.url())
  })

  // 1. Register this browser's key: an IdentityUpdate transition.
  await page.goto('/new/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /^sign in$/i }).first().click()
  await page.getByTestId('tile-import').click()
  await page.setInputFiles('input[type="file"]', IDENTITY)
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
  await page.getByLabel('Repeat passphrase').fill(PASSPHRASE)
  await page.getByRole('button', { name: /create this browser's key/i }).click()
  await expect(page.getByTestId('funds-pill')).toBeVisible({ timeout: 120_000 })
  expect(writes).toContain('broadcastStateTransition')
  expect(writes).toContain('waitForStateTransitionResult')
  const afterKey = writes.length

  // 2. Create a repo: a document create through the write engine.
  const name = `p1-gate-${Date.now().toString(36)}`
  await page.getByLabel('Repository name').fill(name)
  // Not about members-only content: create without it (on by default where the browser holds a key).
  await page.getByTestId('repo-members-only').uncheck()
  await page.getByRole('button', { name: 'Create repository' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('cost-preview')).toBeVisible()
  await dialog.getByRole('button', { name: /sign & create/i }).click()
  await expect(page.getByRole('region', { name: 'Empty repository' })).toBeVisible({ timeout: 120_000 })
  const repoWrites = writes.slice(afterKey)
  expect(repoWrites).toContain('broadcastStateTransition')
  expect(repoWrites).toContain('waitForStateTransitionResult')
  expect(synthetic).toEqual([])
  await expect(page.getByTestId('platform-busy')).toHaveCount(0)
  await shot(page, 'rbw-01-repo-created-through-gate')
})
