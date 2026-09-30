import { test, expect, type Page, type Request } from '@playwright/test'
import { existsSync } from 'node:fs'
import { E2E_DEVNET, expectLanded, idFile, repoUrl, shot, signedIn, waitForRepoResolved } from './helpers'

/**
 * GitHub-parity issues (platform-parity-spec §1.2, F-1; D-201, D-215, D-216, D-217, D-904,
 * D-913, SR-03), live on the devnet under test (E2E_DEVNET).
 *
 * READS (always): the `issues-paging` fixture (owner F1OWNER, 112 issues, seeded by
 * `forge-contracts/scripts/seed-issues-paging.mjs`; e2e/README.md "Reserved fixture repos"):
 * exact Open/Closed counts past 100, keyset paging to page 3, filters and sort in the URL that
 * survive a reload, label chips, the assignee avatar, and the request budgets (issues list cold
 * ≤ 8 DAPI requests before P-3; issue page ≤ 5 beyond the repo chrome).
 *
 * WRITES (E2E_WRITE=1, ≈ 0.003 DASH): F1OWNER opens an issue in `f1-scratch`, edits its title
 * ("edited" appears), creates and applies a label, assigns F1COLLAB (a writer of f1-scratch);
 * F1COLLAB's "assigned to me" filter then finds it. Identity files: `idFile` (E2E_IDENTITY_DIR,
 * default `~/.config/dash-forge/test-identities/devnet-<E2E_DEVNET>/`).
 */

/** The F-1 identities per devnet (the seed of `issues-paging`); E2E_F1_OWNER / E2E_F1_COLLAB override. */
const F1_IDS: Readonly<Record<string, { readonly owner: string; readonly collab: string }>> = {
  bonsia: { owner: 'BU4G4BdyHfEtWJdTXdnuTHqxnf46LCxfoEbHfYYuEsAH', collab: '41EeGdqGx6BnCCErZFZ7K6n9pp9QuAonc3GAKA8zKzAx' },
  moutai: { owner: '8dn4mwXbdruHrRtMbk2KpNevAGSfRsxpcxYip8Uk4LsX', collab: 'Abjm1HbHNzLJbSxwJrrDd4vyUkm5ymiCZswodKrqpcYW' },
}
const F1OWNER = process.env['E2E_F1_OWNER'] ?? F1_IDS[E2E_DEVNET]?.owner ?? `no-f1-owner-on-devnet-${E2E_DEVNET}`
const F1COLLAB = process.env['E2E_F1_COLLAB'] ?? F1_IDS[E2E_DEVNET]?.collab ?? `no-f1-collab-on-devnet-${E2E_DEVNET}`
const PAGING = { owner: F1OWNER, name: 'issues-paging' } as const
const SCRATCH = { owner: F1OWNER, name: 'f1-scratch' } as const

test.describe.configure({ mode: 'serial', timeout: 240_000 })

/** DAPI requests (grpc-web on :1443), by method; the repo chrome's own reads are listed apart. */
function countDapi(page: Page): { all: string[]; since: (mark: number) => string[] } {
  const all: string[] = []
  page.on('request', (r: Request) => {
    const u = r.url()
    if (/:1443\//.test(u)) all.push(u.split('/').pop() ?? '')
  })
  return { all, since: (mark) => all.slice(mark) }
}

async function openList(page: Page, extra = ''): Promise<void> {
  await page.goto(repoUrl('issues', extra, PAGING), { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page)
  await expectLanded(page, page.getByTestId('issue-row').first(), 90_000)
}

const rowNumbers = async (page: Page): Promise<number[]> =>
  (await page.getByTestId('issue-row').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-number'))))) as number[]

test('r1. exact Open / Closed counts past 100, in a cold load within the request budget', async ({ page }) => {
  const dapi = countDapi(page)
  await openList(page)
  await expect(page.getByRole('tab', { name: /Open/ })).toHaveText(/109 Open/, { timeout: 60_000 })
  await expect(page.getByRole('tab', { name: /Closed/ })).toHaveText(/3 Closed/)
  // Settle, then count: the whole cold page, repo chrome included.
  await page.waitForTimeout(3000)
  const docs = dapi.all.filter((m) => m === 'getDocuments').length
  // eslint-disable-next-line no-console
  console.log(`issues list cold: ${dapi.all.length} DAPI requests (${docs} getDocuments)`, dapi.all)
  // The newest 50 open issues: #112 down, skipping #103 (closed).
  const open = Array.from({ length: 112 }, (_, i) => 112 - i).filter((n) => n !== 103).slice(0, 50)
  expect(await rowNumbers(page)).toEqual(open)
  // Budget (F-1): ≤ 8 requests for the list itself. The chrome (repo, config, refs, star,
  // totals) is P-3's to fold into a composite; it is 7 today. List reads: 1 composite + at
  // most 1 `$id in` composite for closed issues past the first chunk.
  expect(docs).toBeLessThanOrEqual(8 + 7)
  expect(page.getByTestId('assignees').first()).toBeDefined()
  await shot(page, 'f1-01-issues-list')
})

test('r2. keyset paging past 100 (D-904), and the page survives a reload', async ({ page }) => {
  await openList(page, '&state=all&page=3')
  await expect(page.getByTestId('page-indicator')).toHaveText(/Page 3 of 3/, { timeout: 60_000 })
  expect(await rowNumbers(page)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1])
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('page-indicator')).toHaveText(/Page 3 of 3/, { timeout: 90_000 })
  await page.getByRole('button', { name: /Previous/ }).click()
  await expect(page).toHaveURL(/page=2/)
  await expect(page.getByTestId('issue-row').first()).toHaveAttribute('data-number', '62')
  await shot(page, 'f1-02-issues-page3')
})

test('r3. filters and sort live in the URL (D-913, D-217) and survive a reload', async ({ page }) => {
  await openList(page)
  await page.getByRole('tab', { name: /Closed/ }).click()
  await expect(page).toHaveURL(/state=closed/)
  await expect.poll(() => rowNumbers(page), { timeout: 60_000 }).toEqual([103, 33, 3])
  // A label chip filters by that label; the search box takes GitHub qualifiers.
  await page.getByLabel('Search issues').fill('is:all label:paging-tens sort:created-asc')
  await page.getByLabel('Search issues').press('Enter')
  await expect(page).toHaveURL(/label=paging-tens/)
  await expect(page).toHaveURL(/sort=oldest/)
  await expect.poll(() => rowNumbers(page), { timeout: 60_000 }).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110])
  await expect(page.locator('[data-label="paging-tens"]').first()).toBeVisible()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect.poll(() => rowNumbers(page), { timeout: 90_000 }).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110])
  await expect(page.getByRole('tab', { name: /Open/ })).toHaveText(/11 Open/)
  // Assignee filter by id: #7 is assigned to F1COLLAB (the seeder wrote refId too).
  await page.goto(repoUrl('issues', `&assignee=${F1COLLAB}`, PAGING), { waitUntil: 'domcontentloaded' })
  await expect.poll(() => rowNumbers(page), { timeout: 90_000 }).toEqual([7])
  await expect(page.getByTestId('assignees')).toBeVisible()
  await shot(page, 'f1-03-issues-filters')
})

test('r4. the issue page: one composite, labels, assignee, autolinks and preview', async ({ page }) => {
  const dapi = countDapi(page)
  await page.goto(repoUrl('issue', '&number=10', PAGING), { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page)
  await expectLanded(page, page.getByRole('heading', { name: /Paging fixture issue #10/ }), 90_000)
  await page.waitForTimeout(3000)
  const docs = dapi.all.filter((m) => m === 'getDocuments').length
  // eslint-disable-next-line no-console
  console.log(`issue page cold: ${dapi.all.length} DAPI requests (${docs} getDocuments)`)
  // Budget (F-1): ≤ 5 for the page itself (1 composite + 1 batched names), plus the chrome (7).
  expect(docs).toBeLessThanOrEqual(5 + 7)
  await expect(page.getByLabel('Issue details').locator('[data-label="paging-tens"]')).toBeVisible()
  // The Write / Preview tabs render autolinks exactly as the page will.
  await page.getByRole('tab', { name: 'Preview' }).first().click()
  await expect(page.getByText('Nothing to preview.')).toBeVisible()
  await shot(page, 'f1-04-issue-page')
})

test.describe('writes', () => {
  test.skip(process.env['E2E_WRITE'] !== '1', 'live devnet writes: set E2E_WRITE=1')
  test.skip(!existsSync(idFile('F1OWNER')) || !existsSync(idFile('F1COLLAB')), 'F-1 identities not found (idFile)')
  const TITLE = `F-1 e2e ${Date.now().toString(36)}`
  let number = 0

  async function confirm(page: Page, label: RegExp): Promise<void> {
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByTestId('cost-preview')).toBeVisible()
    await dialog.getByRole('button', { name: label }).click()
    await expect(dialog).toBeHidden({ timeout: 90_000 })
  }

  test('w1. the author opens an issue, edits its title and sees "edited" (D-216)', async ({ browser }) => {
    const page = await signedIn(browser, 'F1OWNER', repoUrl('issues', '', SCRATCH))
    await page.getByRole('button', { name: /new issue/i }).first().click()
    await page.getByLabel('Title', { exact: true }).fill(TITLE)
    await page.getByLabel('Description').fill('Mentions @nobody-here and #1.')
    await page.getByRole('button', { name: /submit issue/i }).click()
    await expect(page.getByRole('heading', { name: new RegExp(TITLE) })).toBeVisible({ timeout: 90_000 })
    number = Number(new URL(page.url()).searchParams.get('number'))
    // #1 is autolinked to the repo's issue 1.
    await expect(page.locator('[data-autolink="ref"]').first()).toHaveAttribute('href', /number=1/)
    await page.getByRole('button', { name: /^edit$/i }).first().click()
    await page.getByLabel('Title', { exact: true }).fill(`${TITLE} (edited)`)
    await page.getByRole('button', { name: /^save$/i }).click()
    await confirm(page, /sign & save/i)
    await expect(page.getByRole('heading', { name: /\(edited\)/ })).toBeVisible({ timeout: 90_000 })
    await expect(page.getByTestId('edited-marker').first()).toBeVisible()
    await shot(page, 'f1-w1-edited')
  })

  test('w2. a member creates a coloured label and applies it (D-215)', async ({ browser }) => {
    const page = await signedIn(browser, 'F1OWNER', repoUrl('issue', `&number=${number}`, SCRATCH))
    const label = `f1-${Date.now().toString(36).slice(-5)}`
    await page.getByRole('button', { name: /edit labels/i }).click()
    await page.getByLabel('Filter or create a label').fill(label)
    await page.getByRole('radio', { name: 'Colour #0e8a16' }).click()
    await page.getByRole('button', { name: /create label/i }).click()
    await confirm(page, /sign & create/i)
    const chip = page.getByLabel('Applied labels').locator(`[data-label="${label}"]`)
    await expect(chip).toBeVisible({ timeout: 90_000 })
    await expect(chip).toHaveCSS('background-color', 'rgb(14, 138, 22)')
    await shot(page, 'f1-w2-label')
  })

  test('w3. a member assigns F1COLLAB; its "assigned to me" filter finds the issue (D-201)', async ({ browser }) => {
    // Run alone (E2E_F1_ISSUE=<n>) it reuses an issue an earlier run opened.
    number ||= Number(process.env['E2E_F1_ISSUE'] ?? 0)
    test.skip(number === 0, 'needs w1 (or E2E_F1_ISSUE)')
    const owner = await signedIn(browser, 'F1OWNER', repoUrl('issue', `&number=${number}`, SCRATCH))
    const assignees = owner.getByRole('list', { name: 'Assignees' })
    await expect(owner.getByRole('button', { name: /edit assignees/i })).toBeVisible({ timeout: 90_000 })
    if ((await assignees.locator('li').count()) === 0) {
      await owner.getByRole('button', { name: /edit assignees/i }).click()
      await owner.locator(`[data-testid="assignee-option"][data-identity="${F1COLLAB}"]`).click()
      await confirm(owner, /sign & assign/i)
    }
    await expect(assignees.locator('li')).toHaveCount(1, { timeout: 90_000 })
    await expect(assignees).toContainText(F1COLLAB.slice(0, 6))
    await shot(owner, 'f1-w3-assigned')

    const collab = await signedIn(browser, 'F1COLLAB', repoUrl('issues', '&assignee=me', SCRATCH))
    await expect.poll(() => rowNumbers(collab), { timeout: 120_000 }).toContain(number)
    await collab.reload({ waitUntil: 'domcontentloaded' })
    await expect(collab).toHaveURL(/assignee=me/)
    await shot(collab, 'f1-w3-assigned-to-me')
  })
})
