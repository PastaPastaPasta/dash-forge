import { test, expect } from '@playwright/test'
import { collectPageErrors, repoUrl, shot } from './helpers'

/**
 * CI check runs on the commit page (platform-parity-spec §2.7, I-1): the runs `dg ci report`
 * wrote for a commit, trusted when the reporter is a current member or runner, and a run's log
 * read from the reporter's storage and verified against the SHA-256 on chain.
 *
 *   E2E_CI_OWNER=<id> E2E_CI_REPO=<name> E2E_CI_SHA=<commit> E2E_CI_RUNNER_CHECK=<name> \
 *   [E2E_CI_LOG_CHECK=<name>] [E2E_CI_REVOKED_CHECK=<name>] E2E_DEVNET=moutai \
 *   pnpm exec playwright test ci-checks.spec.ts
 *
 * Read-only. The runs are made by the CLI first (e2e/cli/scenarios/35-ci-runner-report.sh, or
 * docs/guides/ci.md): a run reported by a runner that is still enrolled
 * (`E2E_CI_RUNNER_CHECK`), optionally one whose runner was revoked since
 * (`E2E_CI_REVOKED_CHECK`), and one with a log the browser can read (`E2E_CI_LOG_CHECK`).
 */

const OWNER = process.env['E2E_CI_OWNER'] ?? ''
const REPO = process.env['E2E_CI_REPO'] ?? ''
const SHA = process.env['E2E_CI_SHA'] ?? ''
const RUNNER_CHECK = process.env['E2E_CI_RUNNER_CHECK'] ?? ''
const LOG_CHECK = process.env['E2E_CI_LOG_CHECK'] ?? ''
const REVOKED_CHECK = process.env['E2E_CI_REVOKED_CHECK'] ?? ''

test.skip(OWNER === '' || REPO === '' || SHA === '' || RUNNER_CHECK === '', 'set E2E_CI_OWNER, E2E_CI_REPO, E2E_CI_SHA and E2E_CI_RUNNER_CHECK')

test('ci. the commit page lists its check runs, trusts runners and verifies a log', async ({ page }) => {
  test.setTimeout(180_000)
  const { errors } = collectPageErrors(page)
  await page.goto(repoUrl('commit', `&oid=${SHA}`, { owner: OWNER, name: REPO }), { waitUntil: 'domcontentloaded' })
  const checks = page.getByTestId('commit-checks')
  const run = (name: string) => checks.locator(`[data-testid=check-run][data-name="${name}"]`)

  await expect(run(RUNNER_CHECK)).toBeVisible({ timeout: 90_000 })
  // A current runner's run counts: no "not counted" note on it.
  await expect(run(RUNNER_CHECK)).not.toContainText('not counted')
  if (REVOKED_CHECK !== '') {
    await expect(run(REVOKED_CHECK)).toContainText('reporter is no longer a member or runner: not counted')
    await expect(run(REVOKED_CHECK)).toHaveAttribute('data-outcome', /passed|failing|pending/)
  }
  if (LOG_CHECK !== '') {
    await run(LOG_CHECK).getByTestId('check-log-open').click()
    const log = run(LOG_CHECK).getByTestId('check-log')
    await expect(log).toHaveAttribute('data-verified', 'true', { timeout: 30_000 })
    await expect(log).toContainText('Log verified')
  }
  await shot(page, 'ci-commit-checks')
  expect(errors).toEqual([])
})
