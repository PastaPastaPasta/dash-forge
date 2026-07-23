import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { repoUrl, waitForRepoResolved, M1 } from './helpers'

/**
 * Scenario 6 — Accessibility smoke via axe-core.
 *
 * Target: 0 serious/critical violations on the landing + repo home. We report all serious &
 * critical findings; moderate/minor are logged but not gated (v1 acceptance is "0 serious").
 */

async function runAxe(page: import('@playwright/test').Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()

  const seriousOrCritical = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  )
  const other = results.violations.filter(
    (v) => v.impact !== 'serious' && v.impact !== 'critical',
  )

  const fmt = (vs: typeof results.violations) =>
    vs
      .map(
        (v) =>
          `  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))\n` +
          v.nodes
            .map(
              (n) =>
                `      target: ${n.target.join(' ')}\n` +
                `      summary: ${(n.failureSummary ?? '').replace(/\n/g, ' ')}\n` +
                `      html: ${n.html.slice(0, 160)}`,
            )
            .join('\n'),
      )
      .join('\n')

  // eslint-disable-next-line no-console
  console.log(
    `\n[a11y ${label}] serious/critical: ${seriousOrCritical.length}, other: ${other.length}` +
      (seriousOrCritical.length ? `\nSERIOUS/CRITICAL:\n${fmt(seriousOrCritical)}` : '') +
      (other.length ? `\nother:\n${fmt(other)}` : '') +
      '\n',
  )

  return seriousOrCritical
}

test('6a. landing has no serious/critical axe violations', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: /no server to trust/i })).toBeVisible()
  await page.waitForTimeout(3000)
  const serious = await runAxe(page, 'landing')
  expect(
    serious,
    'serious/critical a11y violations on landing:\n' +
      serious.map((v) => `${v.id}: ${v.help}`).join('\n'),
  ).toEqual([])
})

test('6b. repo home has no serious/critical axe violations', async ({ page }) => {
  await page.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page)
  await page.getByText(M1.name, { exact: false }).first().waitFor({ timeout: 30_000 }).catch(() => {})
  const serious = await runAxe(page, 'repo-home')
  expect(
    serious,
    'serious/critical a11y violations on repo home:\n' +
      serious.map((v) => `${v.id}: ${v.help}`).join('\n'),
  ).toEqual([])
})
