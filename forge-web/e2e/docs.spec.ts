import { test, expect } from '@playwright/test'
import { collectPageErrors, runAxe, shot } from './helpers'

/**
 * The in-app docs hub (`/docs/…`): the repository's own `docs/` rendered at build time, with a
 * sidebar, working links between documents, GitHub-style heading anchors and a source link. No
 * Platform reads: it needs no fixture.
 */

test('d1. /docs/ is the guides index, and its links stay in the app', async ({ page }) => {
  const { errors } = collectPageErrors(page)
  await page.goto('/docs/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'User guides', level: 1 })).toBeVisible()
  const nav = page.getByRole('navigation', { name: 'Docs' }).first()
  await expect(nav.getByRole('link', { name: 'All guides' })).toHaveAttribute('aria-current', 'page')
  // A link in the Markdown (`[Quick start](quick-start.md)`) is an in-app route, not GitHub's.
  const quick = page.getByRole('article').getByRole('link', { name: 'Quick start', exact: true }).first()
  await expect(quick).toHaveAttribute('href', '/docs/quick-start/')
  await quick.click()
  await expect(page).toHaveURL(/\/docs\/quick-start\/$/)
  await expect(page.getByRole('heading', { name: 'Quick start', level: 1 })).toBeVisible()
  await expect(page.getByRole('link', { name: /View or edit it on GitHub/ })).toHaveAttribute('href', /blob\/master\/docs\/guides\/quick-start\.md$/)
  expect(errors, errors.join('\n')).toEqual([])
})

test('d2. a link to a section of another document lands on that heading', async ({ page }) => {
  await page.goto('/docs/identity-and-keys/#replacing-it-after-a-lost-device', { waitUntil: 'domcontentloaded' })
  const heading = page.locator('#user-content-replacing-it-after-a-lost-device')
  await expect(heading).toBeInViewport()
  // The sidebar's next page follows the catalog order.
  await expect(page.getByTestId('docs-next')).toContainText('What things cost')
})

test('d3. the header and footer link the docs hub', async ({ page }) => {
  await page.goto('/explore/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('banner').getByRole('link', { name: 'Docs', exact: true })).toHaveAttribute('href', '/docs/')
  await page.getByRole('contentinfo').getByRole('link', { name: 'User guides' }).click()
  await expect(page).toHaveURL(/\/docs\/$/)
})

test('d5. a link to a section of another document, followed in the app, lands on that heading', async ({ page }) => {
  await page.goto('/docs/quick-start/', { waitUntil: 'domcontentloaded' })
  const link = page.getByRole('article').locator('a[href="/docs/identity-and-keys/#limited-keys"]').first()
  await link.click()
  await expect(page).toHaveURL(/\/docs\/identity-and-keys\/#limited-keys$/)
  await expect(page.locator('#user-content-limited-keys')).toBeInViewport()
})

for (const theme of ['dark', 'light'] as const) {
  test(`d4. a11y: a docs page (${theme}) has no serious/critical axe violations`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.addInitScript((t) => localStorage.setItem('theme', t), theme)
    await page.goto('/docs/costs/', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'What things cost', level: 1 })).toBeVisible()
    await shot(page, `docs-costs-${theme}`)
    const serious = await runAxe(page, `docs-${theme}`)
    expect(serious, serious.map((v) => `${v.id}: ${v.help}`).join('\n')).toEqual([])
  })
}
