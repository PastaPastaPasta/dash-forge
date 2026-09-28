import AxeBuilder from '@axe-core/playwright'
import { expect, type Browser, type Locator, type Page, type ConsoleMessage } from '@playwright/test'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The devnet the build under test reads (`E2E_DEVNET`, default moutai). Must match the
 * default in playwright.config.ts, which builds the app for it.
 */
export const E2E_DEVNET = process.env['E2E_DEVNET'] || 'moutai'

/** The MAINTAINER test identity: a maintainer of {@link DEMO} and the owner of {@link EMPTY}. */
export const MAINTAINER = 'AFbkc2KjmmGFvKUDTXqu94XU5BVrD3p7QQu19TSCqeHb'

/**
 * The forge-v2 READ fixture, written only by `forge-contracts/scripts/seed-v2-fixture.mjs`:
 * repo `forge-v2-demo` owned by OWNER (maintainers OWNER + MAINTAINER, writer COLLAB); main =
 * README.md, src/main.rs, lib/util.ts, docs/rules.md; branch feature/greeting; tag v0.1.0; a
 * published objectLocator; issue #1 open + labelled `question`, #2 closed by its author, #3
 * closed + labelled `docs`, #4 open; PR #1 open with MAINTAINER's approval, PR #2 merged; PR #3
 * by CONTRIB (not a member), the review-parity fixture: opened as a draft, head moved to c3 by
 * the author (`headUpdate`), MAINTAINER requested, MAINTAINER's request-changes review with one
 * multi-line inline comment (`reviewId`), CONTRIB's reply, the thread resolved by the author, the
 * review dismissed by OWNER; a branch `policy`; one star.
 * Only its seeder writes it (v2-writes w6 adds OWNER's approval to PR #1, nothing else; the
 * live test `lib/repo/v2.live.test.ts` writes its own scratch repo).
 * Override with E2E_V2_OWNER / E2E_V2_NAME.
 */
export const DEMO = {
  owner: process.env['E2E_V2_OWNER'] ?? '5999iJiaZLMEb6KbjXYFDDYjwGWssatToUTJbXvXhxBp',
  name: process.env['E2E_V2_NAME'] ?? 'forge-v2-demo',
} as const

/**
 * The fixture's `forge-v2-empty`: a repo with nothing pushed (the empty-repo state). A fixture
 * seeded under other identities names its owner in E2E_V2_EMPTY_OWNER.
 */
export const EMPTY = { owner: process.env['E2E_V2_EMPTY_OWNER'] ?? MAINTAINER, name: 'forge-v2-empty' } as const

/** A repo route: `repoUrl('issue', '&number=2')` → `/repo/issue/?owner=…&name=…&number=2`. */
export function repoUrl(
  path = '',
  extra = '',
  repo: { readonly owner: string; readonly name: string } = DEMO,
): string {
  const q = `owner=${repo.owner}&name=${repo.name}${extra}`
  return path === '' ? `/repo/?${q}` : `/repo/${path}/?${q}`
}

const ROOT = resolve(__dirname, '../..')

/** The deployment record the build under test is made from (DAPI addresses, contract ids). */
export function deployment(): {
  dapiAddresses: string[]
  v2: { forgeCore: { contractId: string; contractGroupId: string }; forgeCollab: { contractId: string } }
} {
  return JSON.parse(readFileSync(join(ROOT, `forge-contracts/deployments/devnet-${E2E_DEVNET}.json`), 'utf8'))
}

/**
 * A connected evo-sdk in Node, for reading Platform independently of the app (`any`: the
 * module is imported by path at runtime, outside the app's typed import graph).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function nodeSdk(): Promise<any> {
  const evo = await import(pathToFileURL(join(ROOT, 'forge-web/node_modules/@dashevo/evo-sdk/dist/evo-sdk.module.js')).href)
  const sdk = new evo.EvoSDK({ network: 'devnet', trusted: true, devnetName: E2E_DEVNET, addresses: deployment().dapiAddresses })
  await sdk.connect()
  return sdk
}

export const SCREENSHOT_DIR = join(__dirname, 'screenshots')

export function shot(page: Page, name: string) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  return page.screenshot({ path: join(SCREENSHOT_DIR, `${name}.png`), fullPage: true })
}

/**
 * Collect console errors. Some noise is expected and benign in a WASM SPA hitting a live
 * devnet (transient DAPI request failures, favicon 404s, dev warnings). We only fail on
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

/** Wait for `success`, failing fast with the app's read-error text instead of a bare timeout. */
export async function expectLanded(page: Page, success: Locator, timeout = 45_000): Promise<void> {
  await expect(success.or(readErrorBanner(page))).toBeVisible({ timeout })
  if (await readErrorBanner(page).isVisible()) {
    throw new Error(`read error: ${await readErrorBanner(page).innerText()}`)
  }
}

/**
 * Wait until the repo scaffold has finished the "Connecting to Platform" / "Resolving …"
 * loading shell — i.e. the WASM SDK connected and the forge-v2 `repo` document resolved.
 * Resolves when either real content or an explicit terminal state (error / not-found) is on
 * screen.
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
  // axe reads computed colours: mid-way through a fade-in (the sign-in modal's 150 ms) text is
  // blended with the backdrop and fails contrast it passes once shown. Let finite animations end
  // first (infinite ones, such as a spinner, never do and are not waited for). Best effort: WebKit
  // can report a repeating skeleton pulse with a finite end, so give up after 5 s rather than fail.
  await page
    .waitForFunction(
      () => document.getAnimations().every((a) => a.playState !== 'running' || (a.effect?.getComputedTiming().endTime ?? Infinity) === Infinity),
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => undefined)
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

/**
 * Where a spec's own identities live when it must not write as the shared fixtures
 * (`E2E_IDENTITY_DIR`, the same variable the CLI suite honours); unset: the fixture pool.
 */
const IDENTITY_DIR = process.env['E2E_IDENTITY_DIR'] || ''

/** A devnet test identity file (~/.config/dash-forge/test-identities/devnet-<name>/, or E2E_IDENTITY_DIR). */
export function idFile(name: string): string {
  if (IDENTITY_DIR) return join(IDENTITY_DIR, `${name}.identity.json`)
  return join(homedir(), '.config/dash-forge/test-identities', `devnet-${E2E_DEVNET}`, `${name}.identity.json`)
}

/** The identity id recorded in {@link idFile}. */
export function idOf(name: string): string {
  return (JSON.parse(readFileSync(idFile(name), 'utf8')) as { identityId: string }).identityId
}

/**
 * {@link idOf}, or '' when the identity file is missing, for a spec's top-level constants: the
 * spec's own `test.skip` then says why, instead of the whole file failing to load.
 */
export function idOrEmpty(name: string): string {
  return existsSync(idFile(name)) ? idOf(name) : ''
}

/**
 * Why a spec that writes to the read fixture must not run, or null. Identities of the spec's own
 * (E2E_IDENTITY_DIR) are meant to write to their own copy of the fixture: pointing them at the
 * shared one (DEMO / EMPTY left at their defaults) would write onto a repo only its seeder may.
 */
export function fixtureWriteBlocked(uses: 'demo' | 'empty' | 'both' = 'both'): string | null {
  if (!IDENTITY_DIR) return null
  const demo = uses !== 'empty' && !process.env['E2E_V2_OWNER']
  const empty = uses !== 'demo' && !process.env['E2E_V2_EMPTY_OWNER']
  if (demo || empty) {
    return `E2E_IDENTITY_DIR is set: also point ${demo ? 'E2E_V2_OWNER' : 'E2E_V2_EMPTY_OWNER'} at the fixture copy those identities seeded`
  }
  return null
}

export const PASSPHRASE = 'e2e passphrase for the vault'

/**
 * Where a signed-in browser's storage (the encrypted vault record in IndexedDB, nothing in
 * plaintext) is kept between runs, per devnet identity, so the specs reuse one limited key
 * per identity instead of registering a new one on every test (identities would otherwise
 * accumulate keys without bound). Gitignored (e2e/.playwright/).
 */
export function stateFile(name: string): string {
  // A spec's own identities (E2E_IDENTITY_DIR) must not reuse a fixture's saved vault.
  const who = IDENTITY_DIR ? `${name}-${idOf(name).slice(0, 8)}` : name
  return join(__dirname, '.playwright', 'auth', `devnet-${E2E_DEVNET}-${who}.json`)
}

/** Import the identity file once: the master key registers a limited key for this browser. */
export async function importIdentity(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /^sign in$/i }).first().click()
  await page.getByTestId('tile-import').click()
  await page.setInputFiles('input[type="file"]', idFile(name))
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
  await page.getByLabel('Repeat passphrase').fill(PASSPHRASE)
  await page.getByRole('button', { name: /create this browser's key/i }).click()
  await expect(page.getByTestId('funds-pill')).toBeVisible({ timeout: 120_000 })
}

/**
 * A browser context signed in as `name`. The first time, the identity file is imported (one
 * new limited key); afterwards the saved vault is restored and unlocked with the passphrase.
 * If the stored key stopped working (expired, disabled), it is imported again.
 */
export async function signedIn(browser: Browser, name: string, path = '/'): Promise<Page> {
  const saved = stateFile(name)
  const context = await browser.newContext(existsSync(saved) ? { storageState: saved } : {})
  const page = await context.newPage()
  await page.goto(path, { waitUntil: 'domcontentloaded' })
  let reused = false
  if (existsSync(saved)) {
    try {
      await unlock(page)
      reused = true
    } catch {
      await page.keyboard.press('Escape')
    }
  }
  if (!reused) {
    await importIdentity(page, name)
    mkdirSync(join(__dirname, '.playwright', 'auth'), { recursive: true, mode: 0o700 })
    await context.storageState({ path: saved, indexedDB: true })
  }
  return page
}

/** After a reload: unlock the vault this context already holds. */
export async function unlock(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^sign in$/i }).first().click()
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
  await page.getByRole('button', { name: /^unlock$/i }).click()
  await expect(page.getByTestId('funds-pill')).toBeVisible({ timeout: 60_000 })
}
