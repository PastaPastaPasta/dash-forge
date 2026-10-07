import { test, expect, type Page } from '@playwright/test'
import { collectPageErrors, shot } from './helpers'

/**
 * The address bar's short URL against Next's real router (CJ-6), with no network: Platform is
 * never reached, so a repo page stays on the header it draws from its address alone (L-54), whose
 * tabs are links built from the route the page reads. Runs on any build:
 *
 *   E2E_PORT=<free port> pnpm exec playwright test short-url-bar.spec.ts
 *
 * With no repo read, the page cannot know the repo is public, so the app does not shorten the
 * address itself here; {@link shorten} makes the call `useShortAddressBar` makes
 * (`hooks/use-route.ts`). `discovery-urls.spec.ts` g7 covers the whole flow on a devnet.
 */

/** Hold the Platform SDK and every other host: no repo resolves, nothing errors. */
async function offline(page: Page): Promise<void> {
  await page.route(
    (url) => url.hostname !== '127.0.0.1' || /evo-sdk|\.wasm$/.test(url.pathname),
    () => undefined,
  )
}

/** The app's rewrite: the short URL in the address bar, keeping the router's own history state. */
async function shorten(page: Page, short: string): Promise<void> {
  await page.evaluate((to) => window.history.replaceState(window.history.state, '', to), short)
  await expect(page).toHaveURL(short)
}

/** A tab of the address-only header. */
const tab = (page: Page, name: string) => page.getByTestId('repo-shell-header').getByRole('link', { name, exact: true })

/** A flag on the window: still set means no page load happened since. */
const mark = (page: Page): Promise<void> => page.evaluate(() => void ((window as { __spa?: number }).__spa = 1))
const sameDocument = (page: Page): Promise<boolean> => page.evaluate(() => (window as { __spa?: number }).__spa === 1)

test.beforeEach(async ({ page }) => offline(page))

test('sb-1. a short address bar: the page still reads its route; tabs, Back and Forward keep working', async ({ page }) => {
  const { errors } = collectPageErrors(page)
  await page.goto('/repo/issues/?owner=alice&name=project&q=is%3Aclosed&page=2', { waitUntil: 'domcontentloaded' })
  await expect(tab(page, 'Issues')).toHaveAttribute('aria-current', 'page')
  await mark(page)

  await shorten(page, '/alice/project/issues?q=is%3Aclosed&page=2')
  // The page reads the canonical route: its links still address the repo, and its title names it.
  await expect(tab(page, 'Pull requests')).toHaveAttribute('href', '/repo/pulls/?owner=alice&name=project')
  await expect(page).toHaveTitle(/alice\/project/)

  // In-app navigation, with no page load.
  await tab(page, 'Pull requests').click()
  await expect(page).toHaveURL('/repo/pulls/?owner=alice&name=project')
  await expect(tab(page, 'Pull requests')).toHaveAttribute('aria-current', 'page')
  await shorten(page, '/alice/project/pulls')
  await shot(page, 'cj6-short-pulls')

  // Back restores the short URL into the router: the page reads the route it stands for.
  await page.goBack()
  await expect(page).toHaveURL('/alice/project/issues?q=is%3Aclosed&page=2')
  await expect(tab(page, 'Issues')).toHaveAttribute('aria-current', 'page')
  await expect(tab(page, 'Code')).toHaveAttribute('href', '/repo/?owner=alice&name=project')
  await expect(page).toHaveTitle(/Issues · alice\/project/)

  await page.goForward()
  await expect(page).toHaveURL('/alice/project/pulls')
  await expect(tab(page, 'Pull requests')).toHaveAttribute('aria-current', 'page')

  // A link followed from a restored short URL opens its route.
  await tab(page, 'Releases').click()
  await expect(page).toHaveURL('/repo/releases/?owner=alice&name=project')
  await expect(tab(page, 'Releases')).toHaveAttribute('aria-current', 'page')
  await page.goBack()
  await expect(page).toHaveURL('/alice/project/pulls')
  await expect(tab(page, 'Pull requests')).toHaveAttribute('aria-current', 'page')
  expect(await sameDocument(page), 'every step stayed in the page').toBe(true)
  expect(errors, errors.join('\n')).toEqual([])
})

test('sb-2. reloading a short URL opens its route, its query and fragment kept', async ({ page }) => {
  const { errors } = collectPageErrors(page)
  await page.goto('/repo/pull/?owner=alice&name=project&number=7&tab=files&repo=R1', { waitUntil: 'domcontentloaded' })
  await expect(tab(page, 'Pull requests')).toHaveAttribute('aria-current', 'page')
  await shorten(page, '/alice/project/pull/7/files?repo=R1')
  await page.evaluate(() => (window.location.hash = 'diff-1'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  // The 404 page's shim opens the route; the app then shows the short URL again once the repo
  // resolves (with no Platform here, it stays on the route).
  await expect(page).toHaveURL('/repo/pull/?owner=alice&name=project&number=7&tab=files&repo=R1#diff-1')
  await expect(tab(page, 'Pull requests')).toHaveAttribute('aria-current', 'page')
  await expect(tab(page, 'Code')).toHaveAttribute('href', '/repo/?owner=alice&name=project&repo=R1')
  expect(errors, errors.join('\n')).toEqual([])
})
