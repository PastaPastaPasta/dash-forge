import { test, expect } from '@playwright/test'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { repoUrl, waitForRepoResolved, shot, M1 } from './helpers'

/**
 * OPTIONAL auth / write scenario (lower priority — read paths are the gate).
 *
 * Gated behind E2E_AUTH=1 so the default CI run stays key-free and hermetic. When enabled it
 * loads the DEPLOYER bridge identity (which owns the m1 repo) from the local, gitignored
 * ~/.config/dash-forge/test-identities/, drives the login modal's identity-file upload via
 * setInputFiles (keys never leave this machine), and verifies the session is established.
 *
 * With E2E_WRITE=1 it goes further and creates a cheap issue on m1 (a real testnet write).
 * Anything flaky here self-skips rather than failing the suite.
 */

const IDENTITY_PATH = join(
  homedir(),
  '.config/dash-forge/test-identities/DEPLOYER.identity.json',
)
const AUTH_ENABLED = process.env.E2E_AUTH === '1'
const WRITE_ENABLED = process.env.E2E_WRITE === '1'

test.describe('auth + write (opt-in via E2E_AUTH=1)', () => {
  test.skip(!AUTH_ENABLED, 'set E2E_AUTH=1 to run the local-key login/write scenario')
  test.skip(!existsSync(IDENTITY_PATH), `DEPLOYER identity not found at ${IDENTITY_PATH}`)

  test('login via identity file, then optionally create an issue on m1', async ({ page }) => {
    await page.goto(repoUrl('issues'), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)

    // Open the login modal from the header sign-in affordance.
    await page.getByRole('button', { name: /sign in/i }).first().click()
    await expect(page.getByText(/Sign in to Dash Forge/i)).toBeVisible()

    // Upload the identity file straight into the (visually hidden) file input.
    await page.setInputFiles('input[type="file"]', IDENTITY_PATH)

    // Login runs an SDK identity fetch against testnet; the modal closes and the header
    // shows the account menu with a balance on success.
    await expect(page.getByText(/Sign in to Dash Forge/i)).toBeHidden({ timeout: 40_000 })
    await expect(page.getByRole('button', { name: /sign in/i })).toHaveCount(0, {
      timeout: 10_000,
    })
    await shot(page, '08-logged-in')

    if (!WRITE_ENABLED) {
      test.info().annotations.push({
        type: 'note',
        description: 'E2E_WRITE!=1 — verified login only; skipped the paid issue-create write.',
      })
      return
    }

    // Create a real (cheap) issue on m1.
    const marker = `e2e-web smoke ${new Date().toISOString()}`
    await page.getByRole('button', { name: /new issue/i }).first().click()
    await page.getByLabel(/title/i).fill(marker)
    const body = page.getByLabel(/body|description|comment/i).first()
    if (await body.count()) await body.fill('Automated Playwright e2e write scenario.')
    await page.getByRole('button', { name: /submit issue/i }).click()

    // The new issue appears in the list within the poll interval.
    await expect(page.getByText(marker)).toBeVisible({ timeout: 60_000 })
    await shot(page, '09-issue-created')

    expect(M1.name).toBeTruthy()
  })
})
