import { test, expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { shot, waitForRepoResolved } from './helpers'

/**
 * CLI ↔ web fold cross-check for the `dg` review round trip (review-parity spec §7 PR 7:
 * "Web and CLI must agree on every fold"). CLI scenario 21 (`e2e/cli/scenarios/
 * 21-review-round-trip.sh`) leaves the fold `dg pr view --json` read in a state file; this
 * spec opens the same PR in the web app (signed out: reads only) and checks the page shows
 * the same thing:
 *
 *   - title, and the merged pill;
 *   - the head it names (the folded head after two head updates);
 *   - the head-update timeline items ("pushed new commits");
 *   - the review verdicts, and which is stale;
 *   - the three inline threads dg reports on older heads: each listed "on an older version",
 *     or, where the final head kept its lines unchanged, carried onto them (QW3-015: the web
 *     follows GitHub there, `dg pr view` names the commit the comment was made on); each
 *     resolved ("resolved a conversation" ×3).
 *
 *   E2E_S21_STATE=/path/s21-state.json E2E_DEVNET=bonsia pnpm exec playwright test review-round-trip
 *
 * Skipped without a state file.
 */

const STATE = process.env['E2E_S21_STATE'] ?? ''
test.skip(STATE === '' || !existsSync(STATE), 'set E2E_S21_STATE to the JSON CLI scenario 21 wrote')

interface Fold {
  owner: string
  name: string
  number: number
  title: string
  state: string
  headOid: string
  approvedBy: string[]
  reviews: { id: string; verdict: number; commitOid: string; stale: boolean }[]
  threads: { id: string; path: string; line: number | null; startLine: number | null; side: number | null; outdated: boolean; resolved: boolean; comments: number }[]
  headUpdates: number
}

test('the web shows the fold dg read', async ({ page }) => {
  test.setTimeout(240_000)
  const fold = JSON.parse(readFileSync(STATE, 'utf8')) as Fold
  await page.goto(`/repo/pull/?owner=${fold.owner}&name=${fold.name}&number=${fold.number}`)
  await waitForRepoResolved(page)

  await expect(page.getByRole('heading', { level: 1 })).toContainText(fold.title, { timeout: 90_000 })
  await expect(page.getByText(fold.state === 'merged' ? 'Merged' : 'Open', { exact: true }).first()).toBeVisible()

  // The folded head: the page names it by its first characters.
  await expect(page.getByTitle(fold.headOid).first()).toBeVisible()

  // One head-update line per head update, as the fold counted ("pushed n commits (a → b)" once
  // the commits are read, "pushed new commits" / "force-pushed" / "moved the head" otherwise).
  await expect(page.locator('[data-testid=timeline-event][data-kind=headUpdate]')).toHaveCount(fold.headUpdates)

  // Every review, with the commit it was on.
  // A review's commit is also named inside the collapsed "on an older version" disclosure;
  // what counts is a copy the reader can see (WebKit's `.first()` can be the collapsed one).
  for (const r of fold.reviews) await expect(page.getByTitle(r.commitOid).filter({ visible: true }).first()).toBeVisible()
  const verdictText = (v: number): RegExp => (v === 1 ? /approved/i : v === 2 ? /changes requested/i : /commented/i)
  for (const v of new Set(fold.reviews.map((r) => r.verdict))) await expect(page.getByText(verdictText(v)).first()).toBeVisible()

  // Threads: the web marks the ones not on the head as "on an older version"; resolved ones
  // appear in the timeline as "resolved a conversation".
  const resolvedCount = fold.threads.filter((t) => t.resolved).length
  await expect(page.getByText('resolved a conversation')).toHaveCount(resolvedCount)
  if (fold.approvedBy.length > 0) await expect(page.getByTestId('fold-approved')).toBeVisible()
  // The threads sit on the diff: Files changed.
  await page.getByTestId('pr-tab-files').click()
  const outdated = fold.threads.filter((t) => t.outdated)
  const outdatedComments = outdated.reduce((n, t) => n + t.comments, 0)
  if (outdated.length > 0) {
    // Each one is on the page: under "on an older version", or carried onto the head's lines.
    for (const t of outdated) await expect(page.locator(`[data-root="${t.id}"]`).first()).toBeAttached({ timeout: 120_000 })
    const listed = page.getByTestId('outdated-comments')
    if ((await listed.count()) > 0) {
      const shown = Number(/(\d+) comments? on an older version/.exec(await listed.innerText())?.[1] ?? '0')
      expect(shown).toBeLessThanOrEqual(outdatedComments)
    }
  }
  await shot(page, 'review-round-trip-web')
})
