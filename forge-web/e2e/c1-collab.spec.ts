import { test, expect } from '@playwright/test'
import { collectPageErrors, expectLanded, idOrEmpty, repoUrl, shot, signedIn } from './helpers'

/**
 * The C-1 collaboration features in the browser (platform-parity-spec §6, F-3, F-7): watch,
 * a repo's topics, and on an issue the milestone, pin and lock.
 *
 *   E2E_WRITE=1 E2E_IDENTITY_DIR=<dir with OWNER.identity.json> E2E_C1_REPO=<name> \
 *   E2E_C1_MILESTONE=<title> E2E_DEVNET=sakura pnpm exec playwright test c1-collab.spec.ts
 *
 * Writes only to `E2E_C1_REPO`, a repo OWNER (an identity minted for the run, never a shared
 * fixture) owns, with an open issue #1 and a milestone `E2E_C1_MILESTONE` defined (CLI scenario 27
 * leaves exactly that). About 0.002 DASH: a watch (refunded by the unwatch), a milestone event,
 * a pin and an unpin.
 */

const REPO = process.env['E2E_C1_REPO'] ?? ''
const MILESTONE = process.env['E2E_C1_MILESTONE'] ?? ''
const OWNER = idOrEmpty('OWNER')

test.skip(!process.env['E2E_WRITE'] || REPO === '' || MILESTONE === '' || OWNER === '', 'set E2E_WRITE, E2E_IDENTITY_DIR (OWNER), E2E_C1_REPO and E2E_C1_MILESTONE')

test('c1. watch a repo, then set an issue milestone and pin it', async ({ browser }) => {
  test.setTimeout(420_000)
  const page = await signedIn(browser, 'OWNER', repoUrl('', '', { owner: OWNER, name: REPO }))
  const { errors } = collectPageErrors(page)

  // Watch: the header button reads the viewer's own `watch` row, then writes one.
  const watch = page.getByTestId('watch-button')
  await expect(watch).toHaveText(/^\s*(Watch|Watching)\s*$/, { timeout: 60_000 })
  if ((await watch.textContent())?.includes('Watching')) {
    await watch.click()
    await expect(watch).toHaveText(/^\s*Watch\s*$/, { timeout: 90_000 })
  }
  await watch.click()
  await expect(watch).toHaveText(/^\s*Watching\s*$/, { timeout: 90_000 })
  await shot(page, 'c1-watching')
  await watch.click()
  await expect(watch).toHaveText(/^\s*Watch\s*$/, { timeout: 90_000 })

  // The issue rail: milestone picker, then pin.
  await page.goto(repoUrl('issue', '&number=1', { owner: OWNER, name: REPO }), { waitUntil: 'domcontentloaded' })
  const milestone = page.getByTestId('milestone')
  await expect(milestone).toBeVisible({ timeout: 60_000 })
  if (!(await milestone.textContent())?.includes(MILESTONE)) {
    await milestone.getByRole('button', { name: /set milestone/i }).click()
    await milestone.getByRole('button', { name: MILESTONE, exact: true }).click()
    await page.getByRole('button', { name: /sign & set/i }).click()
    await expectLanded(page, milestone.getByText(MILESTONE, { exact: false }), 120_000)
  }
  await expect(milestone).toContainText(MILESTONE)

  const flags = page.getByTestId('thread-flags')
  await expect(flags).toBeVisible()
  const pinned = (await flags.textContent())?.startsWith('Pinned') ?? false
  await page.getByTestId('pin-toggle').click()
  await page.getByRole('button', { name: pinned ? /sign & unpin/i : /sign & pin/i }).click()
  await expectLanded(page, flags.getByText(pinned ? /^Not pinned/ : /^Pinned/), 120_000)
  await shot(page, 'c1-issue-rail')
  // Leave it as it was.
  await page.getByTestId('pin-toggle').click()
  await page.getByRole('button', { name: pinned ? /sign & pin/i : /sign & unpin/i }).click()
  await expectLanded(page, flags.getByText(pinned ? /^Pinned/ : /^Not pinned/), 120_000)
  expect(errors, errors.join('\n')).toEqual([])
})
