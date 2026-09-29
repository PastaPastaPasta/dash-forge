import { test, expect, type Locator, type Page } from '@playwright/test'
import { DEMO, E2E_DEVNET, expectLanded, repoUrl, shot, waitForRepoResolved } from './helpers'
import { compareTagNames } from '../lib/repo/ref-order'

/**
 * L-13/L-14 (the ref switcher's filter input, keyboard navigation and version-aware tag sort)
 * and L-43 (issue search by a bare/`#N` number and by a DPNS author name), live on moutai.
 *
 *   E2E_DEVNET=moutai pnpm exec playwright test ref-switcher-search.spec.ts
 *
 * The switcher tests read the dash-core showcase mirror (`E2E_DASH_MIRROR=owner/name`, default
 * `unofficial-dashpay-dash-mirror/dash` — the same mirror `repo-home-latency.spec.ts` names):
 * ~600 branches and tags is what makes L-13's lexical-sort bug and the missing filter visible at
 * all, and is the repo the original finding was filed against (`author:unofficial-dashpay-dash-
 * mirror.dash` in L-43's own repro). The number-search tests read the small `forge-v2-demo`
 * fixture ({@link DEMO}), which needs no showcase import and so runs on any devnet.
 */

const [MIRROR_OWNER, MIRROR_NAME] = (process.env['E2E_DASH_MIRROR'] ?? 'unofficial-dashpay-dash-mirror/dash').split('/') as [string, string]
const MIRROR = { owner: MIRROR_OWNER, name: MIRROR_NAME } as const

const issueRowNumbers = (page: Page): Promise<number[]> =>
  page.getByTestId('issue-row').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-number'))))

const optionNames = async (options: Locator): Promise<string[]> => (await options.allTextContents()).map((t) => t.trim())

/** Open a repo's issue list on the All tab, waiting for the first row. */
async function openIssues(page: Page, repo: { readonly owner: string; readonly name: string }): Promise<void> {
  await page.goto(repoUrl('issues', '&state=all', repo), { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page)
  await expectLanded(page, page.getByTestId('issue-row').first(), 60_000)
}

async function searchIssues(page: Page, text: string): Promise<void> {
  const search = page.getByLabel('Search issues')
  await search.fill(text)
  await search.press('Enter')
}

test.describe('ref switcher (showcase mirror)', () => {
  test.skip(E2E_DEVNET !== 'moutai', 'the dash-core mirror is imported on moutai')

  /** Open the repo home and the switcher; `trigger` is the button (Escape returns focus to it). */
  async function openSwitcher(page: Page): Promise<{ trigger: Locator; listbox: Locator; filter: Locator }> {
    await page.goto(repoUrl('', '', MIRROR), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    const trigger = page.getByRole('button', { name: /Switch branches or tags/ })
    await expectLanded(page, trigger, 60_000)
    await trigger.click()
    return {
      trigger,
      listbox: page.getByRole('listbox', { name: 'Switch branch or tag' }),
      filter: page.getByLabel('Find a branch or tag'),
    }
  }

  test('rs-1. the filter input narrows branches and tags live', async ({ page }) => {
    const { listbox, filter } = await openSwitcher(page)
    await expect(listbox).toBeVisible()
    const before = await listbox.getByRole('option').count()
    // L-13: 604 options (29 branches, 575 tags) with no filter — a large ref set is the point.
    expect(before).toBeGreaterThan(50)
    await shot(page, 'rs-01-switcher-open')

    await filter.fill('v23.1')
    await expect.poll(() => listbox.getByRole('option').count()).toBeGreaterThan(0)
    const after = await listbox.getByRole('option').count()
    expect(after).toBeLessThan(before)
    const names = await optionNames(listbox.getByRole('option'))
    expect(names.every((n) => n.includes('v23.1'))).toBe(true)
    await shot(page, 'rs-02-switcher-filtered')
  })

  test('rs-2. tags sort version-aware (newest first), not lexically', async ({ page }) => {
    const { filter } = await openSwitcher(page)
    // v0.11.2.x is one of dash's real historical release trains and has both single- and
    // double-digit patch numbers (.0 through .23), which is what exposes L-13: a check that only
    // compares one hand-picked pair (e.g. .10 vs .9) is too weak, since ascending-alphabetical
    // sort *also* happens to put "v0.11.2.10" before "v0.11.2.9" for that one pair (both "10" and
    // "9" as string suffixes happen to agree with numeric order there, even though lexical and
    // numeric order disagree almost everywhere else in the list). So this asserts every adjacent
    // pair against the app's real production comparator, and that the patch numbers it finds
    // strictly decrease end to end. These are permanent upstream release tags (unlike a recent
    // train, which gains new patches over time), so the collision is stable across imports.
    //
    // The filter also matches a few suffixed variants of the same train (e.g. "v0.11.2.22-ref",
    // "v0.11.2.18-debug") that real upstream history carries alongside the plain releases: those
    // are exercised by the compareTagNames check (over the whole filtered list, suffixed or not)
    // but excluded from the strict-patch-number check below, which only makes sense for the plain
    // "v0.11.2.<N>" releases themselves.
    await filter.fill('v0.11.2.')
    const tagGroup = page.getByRole('group', { name: 'Tags' })
    await expect(tagGroup.getByRole('option').first()).toBeVisible()
    const names = await optionNames(tagGroup.getByRole('option'))
    expect(names.length, 'expected the v0.11.2.x release train to be present on the mirror').toBeGreaterThan(5)

    for (let i = 0; i < names.length - 1; i++) {
      expect(
        compareTagNames(names[i]!, names[i + 1]!),
        `expected "${names[i]}" to sort at or before "${names[i + 1]}" per compareTagNames`,
      ).toBeLessThanOrEqual(0)
    }

    const patches = names.filter((n) => /^v0\.11\.2\.\d+$/.test(n)).map((n) => Number(n.slice('v0.11.2.'.length)))
    expect(patches.length, `expected plain v0.11.2.<N> releases among ${names.join(', ')}`).toBeGreaterThan(5)
    for (let i = 0; i < patches.length - 1; i++) {
      expect(patches[i]!, `expected patch numbers to strictly decrease at index ${i}: ${patches.join(', ')}`).toBeGreaterThan(patches[i + 1]!)
    }
    // Not vacuous: the asserted range must actually span both single- and double-digit patch
    // numbers, since a naive check confined to e.g. only "10"/"9" wouldn't discriminate a
    // regression to lexical sort (see the comment above).
    expect(patches.some((p) => p < 10), `expected a single-digit patch in ${patches.join(', ')}`).toBe(true)
    expect(patches.some((p) => p >= 10), `expected a double-digit patch in ${patches.join(', ')}`).toBe(true)
  })

  test('rs-3. arrow keys move the highlighted option and wrap; Escape closes and refocuses the trigger', async ({ page }) => {
    const { trigger, listbox, filter } = await openSwitcher(page)
    await filter.fill('v23.1.')
    await expect(listbox.getByRole('option').first()).toBeVisible()
    const highlighted = listbox.locator('[role="option"][aria-selected="true"]')

    // L-14: opening highlights the top row; ArrowDown/ArrowUp move it, ArrowUp from the top wraps
    // to the bottom (there was previously no keyboard handling at all).
    await expect(highlighted).toHaveCount(1)
    const first = (await highlighted.textContent()) ?? ''
    await filter.press('ArrowDown')
    await expect(highlighted).not.toHaveText(first)
    await filter.press('ArrowUp')
    await expect(highlighted).toHaveText(first)
    await filter.press('ArrowUp') // wraps from the top to the bottom
    await expect(highlighted).not.toHaveText(first) // wait for the wrap to land before reading its text
    const last = (await highlighted.textContent()) ?? ''
    await filter.press('ArrowDown')
    await expect(highlighted).toHaveText(first)
    await filter.press('ArrowUp')
    await expect(highlighted).toHaveText(last) // wrapping again lands on the same bottom row
    await shot(page, 'rs-03-switcher-keyboard')

    // L-14: Escape used to leave the listbox open with focus stuck on the button.
    await filter.press('Escape')
    await expect(listbox).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })
})

test.describe('issue search: bare and #N numbers (forge-v2-demo fixture)', () => {
  test('is-1. a bare number matches the issue by number, not only as a title substring', async ({ page }) => {
    await openIssues(page, DEMO)
    await searchIssues(page, '4')
    await expect(page).toHaveURL(/q=4/)
    // L-43: a bare "7512" previously returned 0 rows even though the issue existed, because the
    // title-substring check was the only thing a free-text search did. The DEMO fixture has
    // exactly 4 issues (#1-#4, see helpers.ts), so a bare "4" search matching only #4 is exact,
    // not just inclusive.
    await expect.poll(() => issueRowNumbers(page), { timeout: 30_000 }).toEqual([4])
    await shot(page, 'is-01-bare-number')
  })

  test('is-2. a #N-prefixed number is an exact, number-only match', async ({ page }) => {
    await openIssues(page, DEMO)
    await searchIssues(page, '#3')
    await expect(page).toHaveURL(/q=(%23|#)3/)
    await expect.poll(() => issueRowNumbers(page), { timeout: 30_000 }).toEqual([3])
    await shot(page, 'is-02-hash-number')
  })
})

test.describe('issue search: author: by DPNS name (showcase mirror)', () => {
  test.skip(E2E_DEVNET !== 'moutai', 'the dash-core mirror is imported on moutai')

  test('is-3. author:<dpns-name> resolves to an identity instead of being rejected', async ({ page }) => {
    await openIssues(page, MIRROR)
    await searchIssues(page, 'author:unofficial-dashpay-dash-mirror.dash')
    // L-43: this always showed "Not applied: … Authors and assignees take an identity id or
    // @me." and listed every issue, because author: only accepted a base58 id or @me. A resolved
    // name rewrites the URL to the identity it resolved to, and the note does not appear.
    await expect(page).toHaveURL(/author=[1-9A-HJ-NP-Za-km-z]{42,44}/, { timeout: 30_000 })
    await expect(page.getByTestId('issue-search-dropped')).toHaveCount(0)
    await shot(page, 'is-03-dpns-author-search')
  })
})
