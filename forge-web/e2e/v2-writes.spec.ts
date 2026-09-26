import { test, expect, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { E2E_DEVNET, idFile, shot, signedIn, unlock } from './helpers'

/**
 * forge-v2 WRITES, live on a devnet (real spend, a few thousandths of a DASH per run):
 *
 *   E2E_DEVNET=moutai E2E_WRITE=1 pnpm exec playwright test v2-writes.spec.ts
 *
 * One story, four identities from ~/.config/dash-forge/test-identities/devnet-<name>/, each in
 * its own browser context: OWNER creates a repo and adds COLLAB as a writer; CONTRIB opens an
 * issue, comments and closes it with an `authorEvent`; COLLAB labels it with a member `event`;
 * CONTRIB stars and unstars the repo (the unstar is an index-only delete); OWNER approves the
 * fixture's open PR and finally removes COLLAB. Every write goes through the confirm dialog and
 * its cost preview, and the spend ledger in /settings records it.
 */

const OWNER = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const COLLAB = '6jAyDGGcc6fgA7bsraQPriTAZ73Lkq5QgnenaRhqteHd'
const REPO = `e2e-${Date.now().toString(36)}`
const ISSUE_TITLE = `Browser-written issue ${REPO}`

test.skip(E2E_DEVNET === '' || process.env['E2E_WRITE'] !== '1', 'live devnet writes: set E2E_DEVNET=moutai E2E_WRITE=1')
test.skip(!existsSync(idFile('OWNER')), 'devnet test identities not found')
test.describe.configure({ mode: 'serial', timeout: 240_000 })

/** Confirm the open dialog: it must show a cost, then report success and close. */
async function confirmWrite(page: Page, label: RegExp): Promise<void> {
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('cost-preview')).toBeVisible()
  await dialog.getByRole('button', { name: label }).click()
  await expect(dialog).toBeHidden({ timeout: 90_000 })
}

function repoPath(path: string, extra = ''): string {
  return `/repo/${path}${path ? '/' : ''}?owner=${OWNER}&name=${REPO}${extra}`
}

test('w1. owner creates a repo and sees the push commands', async ({ browser }) => {
  const page = await signedIn(browser, 'OWNER', '/new/')
  await page.getByLabel('Repository name').fill(REPO)
  await page.getByLabel('Description').fill('Created by the forge-v2 write spec')
  await expect(page.getByTestId('cost-preview')).toContainText('DASH')
  await page.getByRole('button', { name: 'Create repository' }).click()
  await confirmWrite(page, /sign & create/i)
  await expect(page.getByRole('region', { name: 'Empty repository' })).toBeVisible({ timeout: 90_000 })
  await expect(page.getByText(`git remote add origin dash://${OWNER}/${REPO}`)).toBeVisible()
  await shot(page, 'v2w-01-created')
})

test('w2. owner adds COLLAB as a writer', async ({ browser }) => {
  const page = await signedIn(browser, 'OWNER', repoPath('settings'))
  await page.getByLabel('Identity ID').fill(COLLAB)
  await page.getByRole('radio', { name: 'writer' }).click()
  await page.getByRole('button', { name: /^add$/i }).click()
  await confirmWrite(page, /sign & add/i)
  await expect(page.getByText('WRITER', { exact: true })).toBeVisible({ timeout: 60_000 })
  await shot(page, 'v2w-02-writer')
})

test('w3. contributor opens an issue, comments, and closes it as its author', async ({ browser }) => {
  const page = await signedIn(browser, 'CONTRIB', repoPath('issues'))
  await page.getByRole('button', { name: /new issue/i }).first().click()
  await page.getByLabel('Title', { exact: true }).fill(ISSUE_TITLE)
  await page.getByLabel('Description').fill('Written from the browser by the v2 write spec.')
  await expect(page.getByRole('dialog').getByTestId('cost-preview')).toBeVisible()
  await page.getByRole('button', { name: /submit issue/i }).click()
  await expect(page.getByRole('heading', { name: new RegExp(ISSUE_TITLE) })).toBeVisible({ timeout: 90_000 })
  await expect(page.getByText('#1').first()).toBeVisible()

  await page.getByLabel('Comment', { exact: true }).fill('A comment from the browser.')
  await page.getByRole('button', { name: /^comment$/i }).click()
  await expect(page.getByText('A comment from the browser.')).toBeVisible({ timeout: 90_000 })

  await page.getByRole('button', { name: /close issue/i }).click()
  await expect(page.getByRole('dialog')).toContainText('author event')
  await confirmWrite(page, /close issue/i)
  await expect(page.getByTestId('issue-state')).toHaveText(/closed/i, { timeout: 60_000 })
  await shot(page, 'v2w-03-issue-closed')
})

test('w4. the writer labels the issue with a member event', async ({ browser }) => {
  const page = await signedIn(browser, 'COLLAB', repoPath('issue', '&number=1'))
  await page.getByLabel('Label', { exact: true }).fill('triaged')
  await page.getByRole('button', { name: /add label/i }).click()
  await confirmWrite(page, /sign & label/i)
  await expect(page.getByText('triaged').first()).toBeVisible({ timeout: 60_000 })
  await shot(page, 'v2w-04-labelled')
})

test('w5. contributor stars and unstars the repo (index-only delete)', async ({ browser }) => {
  const page = await signedIn(browser, 'CONTRIB', repoPath(''))
  const star = page.getByRole('button', { name: /^star/i })
  await expect(star).toBeEnabled({ timeout: 60_000 })
  await star.click()
  await expect(page.getByRole('button', { name: /starred/i })).toBeVisible({ timeout: 90_000 })
  await expect(page.getByRole('button', { name: /starred/i })).toContainText('1')
  await page.getByRole('button', { name: /starred/i }).click()
  await expect(page.getByRole('button', { name: /^star/i })).toContainText('0', { timeout: 90_000 })
  await shot(page, 'v2w-05-unstarred')
})

test('w6. owner approves the fixture PR, then removes the writer', async ({ browser }) => {
  const page = await signedIn(browser, 'OWNER', `/repo/pull/?owner=${OWNER}&name=forge-v2-demo&number=1`)
  await page.getByRole('button', { name: /^approve$/i }).click()
  await confirmWrite(page, /submit review/i)
  await expect(page.getByRole('region', { name: 'Approvals' })).toBeVisible()

  // A full navigation locks the key; the vault unlocks it again with the passphrase.
  const settings = page
  await settings.goto(repoPath('settings'), { waitUntil: 'domcontentloaded' })
  await unlock(settings)
  await settings.getByRole('button', { name: /^remove$/i }).first().click()
  await confirmWrite(settings, /sign & remove/i)
  await expect(settings.getByText('WRITER', { exact: true })).toHaveCount(0, { timeout: 60_000 })

  // The ledger lives in IndexedDB on this device, so it survives the reload.
  await settings.getByRole('banner').getByRole('button', { name: /^9r27eDs/ }).click()
  await settings.getByRole('menuitem', { name: /settings & spend/i }).click()
  await expect(settings.getByTestId('spend-panel')).toContainText('delete:writer', { timeout: 30_000 })
  await expect(settings.getByTestId('spend-reconcile')).toBeVisible()
  await shot(settings, 'v2w-06-spend')
})

test('w7. star, unstar, star, unstar in a row (create and index-only delete share nonces)', async ({ browser }) => {
  const page = await signedIn(browser, 'CONTRIB', repoPath(''))
  for (let round = 0; round < 2; round++) {
    const star = page.getByRole('button', { name: /^star/i })
    await expect(star).toBeEnabled({ timeout: 60_000 })
    await star.click()
    await expect(page.getByRole('button', { name: /starred/i })).toContainText('1', { timeout: 90_000 })
    await page.getByRole('button', { name: /starred/i }).click()
    await expect(page.getByRole('button', { name: /^star/i })).toContainText('0', { timeout: 90_000 })
  }
  // No write error surfaced (Next's route announcer is an empty alert region; ignore it).
  await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0)
})

test('w8. grant, revoke, grant, revoke a writer in a row', async ({ browser }) => {
  const page = await signedIn(browser, 'OWNER', repoPath('settings'))
  for (let round = 0; round < 2; round++) {
    await page.getByLabel('Identity ID').fill(COLLAB)
    await page.getByRole('radio', { name: 'writer' }).click()
    await page.getByRole('button', { name: /^add$/i }).click()
    await confirmWrite(page, /sign & add/i)
    await expect(page.getByText('WRITER', { exact: true })).toBeVisible({ timeout: 60_000 })
    await page.getByRole('button', { name: /^remove$/i }).first().click()
    await confirmWrite(page, /sign & remove/i)
    await expect(page.getByText('WRITER', { exact: true })).toHaveCount(0, { timeout: 60_000 })
  }
})
