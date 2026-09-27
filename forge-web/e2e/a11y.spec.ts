import { test, expect, type Locator, type Page } from '@playwright/test'
import { DEMO, EMPTY, expectLanded, repoUrl, runAxe } from './helpers'

/**
 * Accessibility via axe-core (WCAG 2.1 A/AA), on the forge-v2 read fixture (e2e/helpers.ts
 * `DEMO`), in BOTH themes.
 *
 * Target: 0 serious/critical violations on every route, each checked once its real content has
 * landed (not the loading shell). Moderate/minor findings are logged, not gated.
 *
 * The theme is set the way the app stores it (`localStorage.theme`, read by next-themes before
 * first paint) and asserted on <html>: emulating `prefers-color-scheme` alone does not switch
 * the app, whose default is dark — which is how an earlier "light" run was really a dark run.
 */

const PAGES: [label: string, href: string, ready: (page: Page) => Locator][] = [
  [
    'landing',
    '/',
    (page) => page.locator('section').filter({ hasText: 'Recent repos' }).first().locator('a[href*="/repo"]').first(),
  ],
  ['explore', '/explore/', (page) => page.getByRole('heading', { name: 'Explore' })],
  ['login', '/login/', (page) => page.getByRole('main')],
  ['new', '/new/', (page) => page.getByRole('main')],
  ['notifications', '/notifications/', (page) => page.getByRole('main')],
  ['settings', '/settings/', (page) => page.getByRole('main')],
  ['settings-storage', '/settings/storage/', (page) => page.getByRole('main')],
  ['profile', `/u/?name=${DEMO.owner}`, (page) => page.getByRole('heading', { name: 'Repositories' })],
  ['repo-home', repoUrl(), (page) => page.getByRole('link', { name: 'README.md' }).first()],
  ['tree', repoUrl('tree', '&path=src'), (page) => page.getByRole('link', { name: 'main.rs' }).first()],
  ['blob', repoUrl('blob', '&path=src/main.rs'), (page) => page.getByText('reads are proof-checked').first()],
  ['commits', repoUrl('commits'), (page) => page.locator('a[href*="/repo/commit/"]').first()],
  ['branches', repoUrl('branches'), (page) => page.getByText('feature/greeting').first()],
  ['tags', repoUrl('tags'), (page) => page.getByText('v0.1.0').first()],
  ['issues', repoUrl('issues'), (page) => page.getByText('README should explain the event split')],
  ['issue', repoUrl('issue', '&number=3'), (page) => page.getByText('Done in docs/rules.md; closing.')],
  ['pulls', repoUrl('pulls'), (page) => page.locator('a[href*="/repo/pull/"]').first()],
  ['pull', repoUrl('pull', '&number=1'), (page) => page.getByRole('region', { name: 'Approvals' })],
  ['stargazers', repoUrl('stargazers'), (page) => page.getByRole('main').locator('a[href*="/u"]').first()],
  ['releases', repoUrl('releases'), (page) => page.getByText(/No releases|Latest/).first()],
  ['settings-repo', repoUrl('settings'), (page) => page.getByRole('region', { name: 'Collaborators' }).getByText('WRITER', { exact: true })],
  ['empty-repo', repoUrl('', '', EMPTY), (page) => page.getByText(/empty|nothing pushed|push/i).first()],
]

for (const theme of ['dark', 'light'] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((t) => localStorage.setItem('theme', t), theme)
    })

    for (const [label, href, ready] of PAGES) {
      test(`a11y: ${label} (${theme}) has no serious/critical axe violations`, async ({ page }) => {
        await page.goto(href, { waitUntil: 'domcontentloaded' })
        await expectLanded(page, ready(page))
        expect(await page.evaluate(() => document.documentElement.className)).toContain(theme)
        const serious = await runAxe(page, `${label}-${theme}`)
        expect(
          serious,
          `serious/critical a11y violations on ${label} (${theme}):\n` +
            serious.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 4).join(' | ')}`).join('\n'),
        ).toEqual([])
      })
    }

    test(`a11y: sign-in views (${theme})`, async ({ page }) => {
      await page.goto('/explore/', { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: 'Sign in' }).click()
      const dialog = page.getByRole('dialog', { name: 'Sign in to Dash Forge' })
      await expect(dialog).toBeVisible()
      const views: [string, () => Promise<void>][] = [
        ['tiles', async () => {}],
        ['import', async () => dialog.getByTestId('tile-import').click()],
        ['import-phrase', async () => dialog.getByRole('tab', { name: 'Recovery phrase' }).click()],
      ]
      for (const [view, open] of views) {
        await open()
        await page.waitForTimeout(250) // the 150 ms fade-in: axe reads blended colors mid-fade
        const serious = await runAxe(page, `signin-${view}-${theme}`)
        expect(serious, `${view}: ` + serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`).join('\n')).toEqual([])
      }
    })
  })
}
