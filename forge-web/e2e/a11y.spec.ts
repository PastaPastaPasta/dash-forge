import { test, expect, type Locator, type Page } from '@playwright/test'
import { expectLanded, repoUrl, runAxe } from './helpers'

/**
 * Accessibility smoke via axe-core, on the forge-v2 read fixture (e2e/helpers.ts `DEMO`).
 *
 * Target: 0 serious/critical violations on every page below, each checked once its real
 * content has landed (not the loading shell). Moderate/minor findings are logged, not gated.
 */

const PAGES: [label: string, href: string, ready: (page: Page) => Locator][] = [
  [
    'landing',
    '/',
    (page) => page.locator('section').filter({ hasText: 'Recent repos' }).first().locator('a[href*="/repo"]').first(),
  ],
  ['repo-home', repoUrl(), (page) => page.getByRole('link', { name: 'README.md' }).first()],
  ['blob', repoUrl('blob', '&path=src/main.rs'), (page) => page.getByText('reads are proof-checked').first()],
  ['issues', repoUrl('issues'), (page) => page.getByText('README should explain the event split')],
  ['issue', repoUrl('issue', '&number=3'), (page) => page.getByText('Done in docs/rules.md; closing.')],
  ['pull', repoUrl('pull', '&number=1'), (page) => page.getByRole('region', { name: 'Approvals' })],
  ['settings', repoUrl('settings'), (page) => page.getByRole('heading', { name: 'Members' })],
]

for (const [label, href, ready] of PAGES) {
  test(`a11y: ${label} has no serious/critical axe violations`, async ({ page }) => {
    await page.goto(href, { waitUntil: 'domcontentloaded' })
    await expectLanded(page, ready(page))
    const serious = await runAxe(page, label)
    expect(
      serious,
      `serious/critical a11y violations on ${label}:\n` + serious.map((v) => `${v.id}: ${v.help}`).join('\n'),
    ).toEqual([])
  })
}
