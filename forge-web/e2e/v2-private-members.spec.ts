/**
 * The Members section of a private repo's settings never offers the plain grant/revoke path
 * (`private-repos.md` §5.5): with the key in this browser it is the private panel (key epoch,
 * key-checked Add, rotating Remove); without it, a note to add the key and no Add or Remove.
 * It signs in as OWNER (the first run registers a limited key, so it is gated on E2E_WRITE like
 * every signed-in spec) and only reads: it opens OWNER's newest `private-smoke-*` repo, which
 * `lib/private/private.live.test.ts` creates; skipped when none exists.
 *
 *   E2E_DEVNET=moutai E2E_WRITE=1 pnpm exec playwright test v2-private-members.spec.ts
 */

import { expect, test } from '@playwright/test'
import { deployment, nodeSdk, signedIn, waitForRepoResolved } from './helpers'
import type { Page } from '@playwright/test'

const OWNER = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'

test.describe.configure({ mode: 'serial', timeout: 300_000 })
test.skip(process.env['E2E_WRITE'] !== '1', 'needs a signed-in vault: set E2E_WRITE=1')

let repoName: string | null = null

test.beforeAll(async () => {
  const sdk = await nodeSdk()
  const rows = await sdk.documents.query({
    dataContractId: deployment().v2.forgeCore.contractId,
    documentTypeName: 'repo',
    where: [
      ['$ownerId', '==', OWNER],
      ['name', 'startsWith', 'private-smoke'],
    ],
    orderBy: [
      ['$ownerId', 'asc'],
      ['name', 'asc'],
    ],
    limit: 50,
  })
  const names = [...rows.values()].map((d: { toJSON(v: number): { name: string } }) => d.toJSON(sdk.version()).name).sort()
  repoName = names.at(-1) ?? null
})

test('the owner never gets the plain Add or Remove on a private repo', async ({ browser }) => {
  test.skip(repoName === null, 'no private-smoke repo on this devnet')
  const page = await signedIn(browser, 'OWNER', `/repo/settings/?owner=${OWNER}&name=${repoName}`)
  await expect(page.getByTestId('funds-pill')).toBeVisible({ timeout: 60_000 })
  await waitForRepoResolved(page)
  await noPlainPath(page)
})

test('signed out: the Members section of a private repo offers no Add or Remove', async ({ browser }) => {
  test.skip(repoName === null, 'no private-smoke repo on this devnet')
  const page = await (await browser.newContext()).newPage()
  await page.goto(`/repo/settings/?owner=${OWNER}&name=${repoName}`, { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page)
  const members = page.locator('section', { hasText: 'Members' }).first()
  await expect(members).toBeVisible({ timeout: 90_000 })
  await expect(members.getByRole('button', { name: /^(add|remove)$/i })).toHaveCount(0)
})

async function noPlainPath(page: Page): Promise<void> {
  const members = page.locator('section', { hasText: 'Members' }).first()
  await expect(members).toBeVisible({ timeout: 90_000 })
  // Either the private panel (key present) or the add-your-key note (no key): never the plain form.
  const privatePanel = page.getByTestId('private-members')
  const note = page.getByText(/Adding or removing a member of a private repo hands out or rotates its key/)
  await expect(privatePanel.or(note)).toBeVisible({ timeout: 90_000 })
  if (await note.isVisible()) {
    await expect(members.getByRole('button', { name: /^add$/i })).toHaveCount(0)
    await expect(members.getByRole('button', { name: /^remove$/i })).toHaveCount(0)
  } else {
    // The private panel: the key epoch line, and Add/Remove open the private flows' dialogs.
    await expect(privatePanel.getByTestId('key-epoch')).toContainText(/key epoch \d+/)
  }
  await page.screenshot({ path: '/tmp/claude-501/pr3-qa/23-settings-private-members.png', fullPage: true })
}
