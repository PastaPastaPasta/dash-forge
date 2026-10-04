import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import { countDapi, countDocumentQueries, DAPI_RESEND_SLACK, idFile, repoUrl, shot, signedIn } from './helpers'
import { quorumGuardLong } from './quorum-sync'

/**
 * Long bodies (`docs/contracts/forge-v2.md` §6.3), live on a devnet, on an issue of your own whose
 * body and first comment are longer than their 5,120-byte fields (the scratch repo `dg issue
 * create` and `dg issue comment` made):
 *
 *   E2E_DEVNET=sakura E2E_LONG_BODY_ISSUE=<owner>/<name>#<n> pnpm exec playwright test long-body.spec.ts
 *
 * - lb-1 (read): the issue page shows both full texts, never a trailer, within S-1's cold budget
 *   (25 requests), and reads each artifact with one `packManifest` query (its copies) and its
 *   chunks.
 * - lb-2 (write, E2E_WRITE=1 and an OWNER identity that is a maintainer or writer of the repo,
 *   E2E_IDENTITY_DIR): a 9 KB comment from the composer says it is stored whole, posts, and shows
 *   whole.
 */

const ISSUE = /^([^/]+)\/([^#]+)#(\d+)$/.exec(process.env['E2E_LONG_BODY_ISSUE'] ?? '')
const REPO = ISSUE ? { owner: ISSUE[1] as string, name: ISSUE[2] as string } : null
const NUMBER = ISSUE ? (ISSUE[3] as string) : ''

test.skip(REPO === null, 'set E2E_LONG_BODY_ISSUE=<owner>/<name>#<n> (an issue with a long body and comment)')
test.beforeEach(quorumGuardLong)
test.describe.configure({ mode: 'serial', timeout: 240_000 })

/** S-1's cold page budget (`page-budget.spec.ts`). */
const COLD_BUDGET = 25

test('lb-1. a long body and comment show whole, within the cold page budget', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const dapi = countDapi(page)
  const manifests = countDocumentQueries(page, 'packManifest')
  await page.goto(repoUrl('issue', `&number=${NUMBER}`, REPO ?? undefined), { waitUntil: 'domcontentloaded' })
  // Both texts end with this line, past what their fields hold.
  await expect(page.getByText('END OF REPORT: the last line of the full text.')).toHaveCount(2, { timeout: 90_000 })
  await expect(page.getByTestId('long-body-partial')).toHaveCount(0)
  await expect(page.locator('main')).not.toContainText('forge:body')
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined)
  const total = [...dapi.values()].reduce((a, b) => a + b, 0)
  test.info().annotations.push({ type: 'dapi', description: `long-body issue cold: ${total} ${JSON.stringify(Object.fromEntries(dapi))}; packManifest queries ${manifests.count()}` })
  expect(total, JSON.stringify(Object.fromEntries(dapi))).toBeLessThanOrEqual(COLD_BUDGET + DAPI_RESEND_SLACK)
  // The repo chrome's timeline names `packManifest` once (`TIMELINE_TYPES`); each artifact adds
  // one listing of its copies (the body's and the comment's).
  expect(manifests.count()).toBeLessThanOrEqual(1 + 2)
  // eslint-disable-next-line no-console -- the run log records what the page read
  console.log(`long-body issue cold: ${total} requests ${JSON.stringify(Object.fromEntries(dapi))}; packManifest queries ${manifests.count()}`)
  await shot(page, 'long-body-issue')
  await context.close()
})

test('lb-2. a maintainer posts a 9 KB comment from the composer: stored whole, shown whole', async ({ browser }) => {
  test.skip(process.env['E2E_WRITE'] !== '1', 'live devnet writes: set E2E_WRITE=1')
  test.skip(!existsSync(idFile('OWNER')), 'needs an OWNER identity (E2E_IDENTITY_DIR) that maintains the repo')
  const page = await signedIn(browser, 'OWNER', repoUrl('issue', `&number=${NUMBER}`, REPO ?? undefined))
  const stamp = `browser-written ${Date.now().toString(36)}`
  const text = `${stamp}\n\n${'A long browser comment line, é ü ✓. '.repeat(260)}\n\nEND OF THE BROWSER COMMENT.`
  const composer = page.getByTestId('issue-composer')
  await composer.getByLabel('Comment').fill(text)
  await expect(page.getByTestId('long-body-note')).toContainText(/stored as a repository artifact/)
  await composer.getByRole('button', { name: /^comment$/i }).click()
  // Posted: the composer empties (an error would stay beside the text, in its alert).
  const alert = composer.getByRole('alert')
  try {
    await expect(composer.getByLabel('Comment')).toHaveValue('', { timeout: 180_000 })
  } catch (e) {
    throw new Error(`not posted: ${(await alert.isVisible()) ? await alert.innerText() : String(e)}`)
  }
  // Shown whole in the timeline, outside the composer, once a read shows it.
  const timeline = page.locator('main').getByText('END OF THE BROWSER COMMENT.')
  await expect(timeline.filter({ hasNot: page.locator('textarea') })).toHaveCount(1, { timeout: 180_000 })
  await expect(page.locator('main').getByText(stamp, { exact: true })).toBeVisible()
  await shot(page, 'long-body-browser-comment')
})
