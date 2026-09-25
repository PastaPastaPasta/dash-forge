import { type Page, type ConsoleMessage } from '@playwright/test'
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
  name: process.env['E2E_FIXTURE_NAME'] ?? 'm1-5124',
} as const

export function repoUrl(path = ''): string {
  const q = `owner=${M1.owner}&name=${M1.name}`
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
