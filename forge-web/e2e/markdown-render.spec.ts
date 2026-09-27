import { test, expect } from '@playwright/test'
import { E2E_DEVNET, repoUrl, shot, waitForRepoResolved } from './helpers'

/**
 * README, release-note and comment rendering on the showcase repos imported on moutai
 * (D-051, D-052, D-053, D-056):
 *
 *   E2E_DEVNET=moutai pnpm exec playwright test markdown-render.spec.ts
 */

const FD = { owner: 'A9SDYE5MzimZGRMNfEJZYvxArYneQ3t5zJYYiwmZHD3u', name: 'fd' } as const
const GLOW = { owner: '4JWDayd36nyAYLg8mChid5bMkYa49nzCPbX8vb6ACNz4', name: 'glow' } as const
const RIPGREP = { owner: '541TCG56DE7YESd6WWxymLTgkMRH2zKP7Adrnw8oVrUk', name: 'ripgrep' } as const
const PREACT = { owner: 'qrUbjpBNDWpFscytpp8w9Uw87DV7hSzH5CW7ux9ERCz', name: 'preact' } as const

test.describe('markdown rendering (showcase repos)', () => {
  test.skip(E2E_DEVNET !== 'moutai', 'the showcase repos are imported on moutai')

  test('md-1. the fd README: badges, relative links and a repo image (D-051)', async ({ page }) => {
    await page.goto(repoUrl('', '', FD), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    const readme = page.locator('section[aria-label="README"]')
    await expect(readme).toBeVisible({ timeout: 60_000 })
    // Badges are images inside links, not raw `[![…](…)](…)` text.
    await expect(readme).not.toContainText('[![')
    await expect(readme.locator('a[href*="github.com/sharkdp/fd/actions"] img')).toHaveCount(1)
    // Relative links go to the repo's blob view; none is left as "#".
    await expect(readme.locator('a[href*="/repo/blob"][href*="path=LICENSE-MIT"]')).toHaveCount(1)
    await expect(readme.locator('a[href="#"]')).toHaveCount(0)
    // `doc/screencast.svg` is read from the repo's own objects, not fetched from a host.
    const demo = readme.getByTestId('repo-image')
    await expect(demo).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => demo.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
    expect(await demo.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/)
    // Escapes: `[\*](…)` is a link reading "*".
    await expect(readme).not.toContainText('\\*')
    // GitHub heading anchors.
    await expect(readme.locator('#user-content-how-to-use')).toHaveCount(1)
    await shot(page, 'md-01-fd-readme')
  })

  test('md-2. glow v1.3.0 notes: raw <img> and <kbd> render, autolinks stop at the quote (D-052)', async ({ page }) => {
    await page.goto(repoUrl('release', '&tag=v1.3.0', GLOW), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    const release = page.getByTestId('release').first()
    await expect(release).toBeVisible({ timeout: 60_000 })
    await expect(release).not.toContainText('<img')
    await expect(release.locator('kbd')).toHaveText('tab')
    const img = release.locator('img[src="https://stuff.charm.sh/glow/glow-1.3-tabs.gif"]')
    await expect(img).toHaveAttribute('referrerpolicy', 'no-referrer')
    await expect(img).toHaveAttribute('width', '600')
    // The reference link `[Glamour][glam]` resolves.
    await expect(release.locator('a[href="https://github.com/charmbracelet/glamour"]')).toHaveCount(1)
    for (const href of await release.locator('a').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href))) {
      expect(href).not.toMatch(/%22$|"$/)
    }
    await shot(page, 'md-02-glow-release')
  })

  test('md-3. an image in a PR comment waits for a click, then loads that host (D-053)', async ({ page }) => {
    const external: string[] = []
    page.on('request', (r) => {
      if (r.url().includes('coveralls.io')) external.push(r.url())
    })
    await page.goto(repoUrl('pull', '&number=5269', PREACT), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    const gate = page.getByTestId('gated-image').filter({ hasText: 'coveralls.io' }).first()
    await expect(gate).toBeVisible({ timeout: 60_000 })
    await page.waitForTimeout(1000)
    expect(external).toEqual([])
    await gate.getByRole('button', { name: /Load images from coveralls\.io/ }).click()
    await expect(page.locator('img[src*="coveralls.io"]').first()).toHaveAttribute('referrerpolicy', 'no-referrer')
    await expect.poll(() => external.length).toBeGreaterThan(0)
  })

  test('md-4. an imported asset the browser cannot fetch offers the origin link (D-056)', async ({ page }) => {
    await page.goto(repoUrl('release', '&tag=15.0.0', RIPGREP), { waitUntil: 'domcontentloaded' })
    await waitForRepoResolved(page)
    const asset = page.getByTestId('release-asset').filter({ hasText: 'aarch64-apple-darwin.tar.gz' }).filter({ hasNotText: '.sha256' }).first()
    await expect(asset).toBeVisible({ timeout: 60_000 })
    await asset.getByRole('button', { name: /Download/ }).click()
    const direct = asset.getByTestId('direct-download')
    await expect(direct).toBeVisible({ timeout: 60_000 })
    await expect(direct.locator('a[href^="https://github.com/BurntSushi/ripgrep/releases/download/15.0.0/"]')).toHaveCount(1)
    await expect(direct).toContainText('Check a downloaded file')
  })
})
