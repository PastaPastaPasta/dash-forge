import AxeBuilder from '@axe-core/playwright'
import { expect, type Browser, type Page, type ConsoleMessage } from '@playwright/test'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Real testnet fixture: the nightly READ fixture, written only by
 * `e2e/cli/seed-read-fixture.sh` (reserved in e2e/README.md). `main` holds one deterministic
 * commit (README.md, src/, lib/) stored on Platform with no browse index, so the fallback
 * clone is what the browse specs exercise. Never point these specs at a repo another suite
 * writes: the storage e2e once left packs on a laptop's MinIO in the shared CLI repo, and
 * every browse spec failed on them. Override with E2E_FIXTURE_OWNER / E2E_FIXTURE_NAME.
 */
export const M1 = {
  owner: process.env['E2E_FIXTURE_OWNER'] ?? '8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB',
  // The seeder's override (NIGHTLY_FIXTURE_REPO) applies here too, so a renamed fixture is
  // seeded and read as the same repo.
  name: process.env['E2E_FIXTURE_NAME'] ?? process.env['NIGHTLY_FIXTURE_REPO'] ?? 'm1-5124',
} as const

/** The devnet this run's build targets (`E2E_DEVNET`), or '' for the default testnet build. */
export const E2E_DEVNET = process.env['E2E_DEVNET'] ?? ''

/** Skip a testnet-fixture spec on a devnet build (and vice versa). */
export const ON_TESTNET = E2E_DEVNET === ''

/**
 * The repo the opt-in WRITE spec (auth-write, E2E_WRITE=1) creates issues on — never the read
 * fixture above, which only its seeder may write (its issues page is asserted on). This is
 * the CLI suite's DEPLOYER-owned repo, which test runs already write to. Override with
 * E2E_WRITE_FIXTURE_NAME. See e2e/README.md.
 */
export const WRITE_FIXTURE = {
  owner: M1.owner,
  name: process.env['E2E_WRITE_FIXTURE_NAME'] ?? 'm1-75299',
} as const

export function repoUrl(path = '', repo: { owner: string; name: string } = M1): string {
  const q = `owner=${repo.owner}&name=${repo.name}`
  if (path === '') return `/repo/?${q}`
  return `/repo/${path}/?${q}`
}

export const SCREENSHOT_DIR = join(__dirname, 'screenshots')

export function shot(page: Page, name: string) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  return page.screenshot({ path: join(SCREENSHOT_DIR, `${name}.png`), fullPage: true })
}

/**
 * Collect console errors. Some noise is expected and benign in a WASM SPA hitting a live
 * testnet (transient DAPI request failures, favicon 404s, dev warnings). We only fail on
 * errors that indicate the *page itself* broke.
 */
export function collectPageErrors(page: Page): { errors: string[]; consoleErrors: string[] } {
  const errors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  return { errors, consoleErrors }
}

/**
 * Locator for the app's read-error state ("That read did not land", "Could not reach Platform").
 * The app currently renders this whenever a proof-verified SDK read rejects.
 */
export function readErrorBanner(page: Page) {
  return page
    .getByText(/did not land|could not reach platform|that read|read failed/i)
    .first()
}

/**
 * Wait until the repo scaffold has finished the "Connecting to Platform" / "Resolving …"
 * loading shell — i.e. the WASM SDK connected and the registry listing resolved. Resolves
 * when either real content or an explicit terminal state (error / not-found) is on screen.
 */
export async function waitForRepoResolved(page: Page, timeout = 60_000): Promise<void> {
  await page
    .getByText(/Connecting to Platform|Resolving /i)
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 })
    .catch(() => {
      /* the shell may already be gone if the SDK was warm */
    })
  await page
    .getByText(/Connecting to Platform|Resolving /i)
    .first()
    .waitFor({ state: 'hidden', timeout })
    .catch(() => {
      /* fall through — assertions below decide pass/fail */
    })
}

/**
 * Run axe (WCAG 2.1 A/AA) and return the serious/critical violations; everything is logged.
 * Target: 0 serious/critical on every page.
 */
export async function runAxe(page: import('@playwright/test').Page, label: string) {
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

/** A devnet test identity file (~/.config/dash-forge/test-identities/devnet-<name>/). */
export function idFile(name: string): string {
  return join(homedir(), '.config/dash-forge/test-identities', `devnet-${E2E_DEVNET}`, `${name}.identity.json`)
}

export const PASSPHRASE = 'e2e passphrase for the vault'

/**
 * A fresh browser context signed in as `name`: the identity file is imported once — its master
 * key registers a limited key for this browser, which the vault keeps under a passphrase.
 */
export async function signedIn(browser: Browser, name: string, path = '/'): Promise<Page> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(path, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /^sign in$/i }).first().click()
  await page.getByTestId('tile-import').click()
  await page.setInputFiles('input[type="file"]', idFile(name))
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
  await page.getByLabel('Repeat passphrase').fill(PASSPHRASE)
  await page.getByRole('button', { name: /create this browser's key/i }).click()
  await expect(page.getByTestId('funds-pill')).toBeVisible({ timeout: 120_000 })
  return page
}

/** After a reload: unlock the vault this context already holds. */
export async function unlock(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^sign in$/i }).first().click()
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
  await page.getByRole('button', { name: /^unlock$/i }).click()
  await expect(page.getByTestId('funds-pill')).toBeVisible({ timeout: 60_000 })
}
