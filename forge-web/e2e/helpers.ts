import AxeBuilder from '@axe-core/playwright'
import { expect, type Browser, type Locator, type Page, type ConsoleMessage, type Request } from '@playwright/test'
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
export const MAINTAINER = 'Ehyw8VygZh5LjjYHUbKqgyJamgetiVPLFnJewrfmgQUs'

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
  owner: process.env['E2E_V2_OWNER'] ?? 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr',
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

/**
 * The showcase mirrors' owners (`evidence/showcase` in the QA harness), by DPNS label. A devnet
 * reset re-mints them under new identity ids but the same names, so specs resolve the names
 * instead of hardcoding ids. `E2E_SHOWCASE_<KEY>` (an identity id) overrides one.
 */
export const SHOWCASE_OWNERS = {
  SHARKDP: 'unofficial-sharkdp-mirror',
  JQLANG: 'unofficial-jqlang-mirror',
  PREACTJS: 'unofficial-preactjs-mirror',
  CHARMBRACELET: 'unofficial-charmbracelet-mirror',
  JUNEGUNN: 'unofficial-junegunn-mirror',
  BURNTSUSHI: 'unofficial-burntsushi-mirror',
} as const

const showcaseOwnerCache = new Map<string, Promise<string>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let showcaseSdk: Promise<any> | undefined

/**
 * A showcase repo `{ owner, name }` whose owner is the identity id its DPNS name resolves to
 * (read in Node through evo-sdk, independent of the app), or `E2E_SHOWCASE_<KEY>` when set.
 * Throws when the name does not resolve, which means the showcase is not mirrored on this devnet.
 */
export async function showcaseRepo(
  key: keyof typeof SHOWCASE_OWNERS,
  name: string,
): Promise<{ readonly owner: string; readonly name: string }> {
  const override = process.env[`E2E_SHOWCASE_${key}`]
  if (override) return { owner: override, name }
  let owner = showcaseOwnerCache.get(key)
  if (owner === undefined) {
    const label = `${SHOWCASE_OWNERS[key]}.dash`
    showcaseSdk ??= nodeSdk()
    owner = showcaseSdk.then(async (sdk) => {
      const id = await sdk.dpns.resolveName(label)
      if (!id) throw new Error(`${label} does not resolve on ${E2E_DEVNET}: the showcase mirrors are not there (set E2E_SHOWCASE_${key})`)
      return String(id)
    })
    showcaseOwnerCache.set(key, owner)
  }
  return { owner: await owner, name }
}

export const SCREENSHOT_DIR = join(__dirname, 'screenshots')

export function shot(page: Page, name: string) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  return page.screenshot({ path: join(SCREENSHOT_DIR, `${name}.png`), fullPage: true })
}

export const DAPI_METHOD = /\/org\.dash\.platform\.dapi\.v0\.Platform\/(\w+)$/

/** Count the DAPI requests of `page` by gRPC method, from now on (P-1, #72). */
export function countDapi(page: Page): Map<string, number> {
  const counts = new Map<string, number>()
  page.on('request', (request: Request) => {
    const method = DAPI_METHOD.exec(request.url())?.[1]
    if (method !== undefined) counts.set(method, (counts.get(method) ?? 0) + 1)
  })
  return counts
}

/**
 * Count the `getDocuments` requests of `page` that query `documentType`, from now on. A
 * gRPC-web body is protobuf: the document type name travels as its plain bytes, so a byte
 * match isolates one type's queries (`packManifest` is a browse resolve's listing). A name that
 * is a prefix of another (`event` / `eventX`) would over-count; the forge types used here are not.
 */
export function countDocumentQueries(page: Page, documentType: string): { readonly count: () => number } {
  const needle = Buffer.from(documentType)
  let n = 0
  page.on('request', (request: Request) => {
    if (DAPI_METHOD.exec(request.url())?.[1] !== 'getDocuments') return
    if (request.postDataBuffer()?.includes(needle)) n++
  })
  return { count: () => n }
}

/** One `getDocuments` request, decoded far enough to classify it (the v1 wire, evo-sdk 4.2). */
export interface DocumentsRequest {
  readonly documentType: string
  /** Each where clause's field, and for an `in` the number of values. */
  readonly where: readonly { readonly field: string; readonly inCount: number | null }[]
}

function readVarint(b: Uint8Array, at: number): [number, number] {
  let v = 0
  let shift = 0
  for (;;) {
    const x = b[at++] as number
    v += (x & 0x7f) * 2 ** shift
    shift += 7
    if ((x & 0x80) === 0) return [v, at]
  }
}

/** The length-delimited fields of a protobuf message, `[field number, bytes]`; other wire types are skipped. */
function protoFields(b: Uint8Array): [number, Uint8Array][] {
  const out: [number, Uint8Array][] = []
  let at = 0
  while (at < b.length) {
    let key: number
    ;[key, at] = readVarint(b, at)
    const wire = key & 7
    if (wire === 0) [, at] = readVarint(b, at)
    else if (wire === 2) {
      let len: number
      ;[len, at] = readVarint(b, at)
      out.push([key >>> 3, b.subarray(at, at + len)])
      at += len
    } else if (wire === 1) at += 8
    else if (wire === 5) at += 4
    else break
  }
  return out
}

const fieldOf = (fields: readonly [number, Uint8Array][], n: number): Uint8Array | undefined => fields.find(([f]) => f === n)?.[1]
const text = (b: Uint8Array | undefined): string => (b ? Buffer.from(b).toString('utf8') : '')

/**
 * Decode a `getDocuments` gRPC-web body (5-byte frame header, then `GetDocumentsRequest`) as
 * `platform.proto` defines v1: `document_type` 2, `where_clauses` 3 (`WhereClause`: `field` 1,
 * `value` 3; an `IN`'s value is a `list`, field 7, of values). Null for another shape (v0).
 */
export function decodeDocumentsRequest(body: Buffer | null): DocumentsRequest | null {
  if (body === null || body.length < 6) return null
  const [versionField, inner] = protoFields(body.subarray(5))[0] ?? []
  if (versionField !== 2 || !inner) return null
  const fields = protoFields(inner)
  return {
    documentType: text(fieldOf(fields, 2)),
    where: fields
      .filter(([f]) => f === 3)
      .map(([, clause]) => {
        const c = protoFields(clause)
        const value = fieldOf(c, 3)
        const list = value ? fieldOf(protoFields(value), 7) : undefined
        const inCount = list ? protoFields(list).filter(([f]) => f === 1).length : null
        return { field: text(fieldOf(c, 1)), inCount }
      }),
  }
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
 * Answer the run's inline storage question ("Waiting for your choice: store the pack … on Dash
 * Platform?") if the upload step asks before `done` shows. It asks only after the pack is built
 * (seconds in), so this waits for either; `isVisible` alone would not wait.
 */
export async function answerStorageQuestion(page: Page, done: Locator, timeout = 180_000): Promise<void> {
  const ask = page.getByTestId('storage-question')
  await expect(ask.or(done)).toBeVisible({ timeout })
  if (await ask.isVisible()) {
    await expect(ask.locator('xpath=ancestor::li[1]')).toHaveAttribute('data-state', 'waiting')
    await ask.getByRole('button', { name: /sign & store on platform/i }).click()
  }
}

/**
 * The merge box's Storage row, before the merge: the spec identities configure no storage, so the
 * pack goes to Platform and "Allow storing on Platform" is pre-checked with a DASH price.
 */
export async function expectPlatformPreAllowed(panel: Locator): Promise<void> {
  const row = panel.getByTestId('storage-row')
  await expect(row).toContainText('Dash Platform (no storage configured)', { timeout: 120_000 })
  await expect(row.getByTestId('allow-platform')).toBeChecked()
  await expect(row.getByTestId('cost-preview')).toContainText('DASH')
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

/**
 * Open the sign-in sheet and wait for `ready` in it. One click: a tap before hydration is caught
 * and replayed by the app itself (#115), so a click that opens nothing is a product bug, not
 * something to retry here.
 */
async function openSignIn(page: Page, ready: Locator): Promise<void> {
  // "Sign in", or "Session locked — Unlock" when this browser holds a locked key.
  await page.getByRole('banner').getByRole('button', { name: /^sign in$|unlock$/i }).first().click()
  await ready.waitFor({ state: 'visible', timeout: 30_000 })
}

/** Import the identity file once: the master key registers a limited key for this browser. */
export async function importIdentity(page: Page, name: string): Promise<void> {
  await openSignIn(page, page.getByTestId('tile-import'))
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

/**
 * After a page load: be signed in with the vault this context holds. The session an earlier
 * page load kept is picked up by itself (no prompt); a locked one (a context restored from a
 * saved state, whose wrapping key does not survive the copy) is unlocked with the passphrase.
 */
export async function unlock(page: Page): Promise<void> {
  const pill = page.getByTestId('funds-pill')
  const locked = page.getByRole('banner').getByTestId('session-unlock')
  await expect(pill.or(locked).or(page.getByRole('banner').getByRole('button', { name: /^sign in$/i }))).toBeVisible({ timeout: 60_000 })
  if (await pill.isVisible()) return
  const passphrase = page.getByLabel('Passphrase', { exact: true })
  await openSignIn(page, passphrase)
  await passphrase.fill(PASSPHRASE)
  await page.getByRole('button', { name: /^unlock$/i }).click()
  await expect(pill).toBeVisible({ timeout: 60_000 })
}

/** The header's funds pill (signed in) and its "Session locked — Unlock" button. */
export const FUNDS_PILL = 'funds-pill'
export const SESSION_UNLOCK = 'session-unlock'

/** Signed in: the funds pill, and no Unlock in the header, after the page settles. */
export async function expectSignedIn(page: Page): Promise<void> {
  await expect(page.getByTestId(FUNDS_PILL)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('banner').getByTestId(SESSION_UNLOCK)).toHaveCount(0)
}

/** Locked: the header's Unlock, and no funds pill, after the page settles. */
export async function expectLocked(page: Page): Promise<void> {
  await expect(page.getByRole('banner').getByTestId(SESSION_UNLOCK)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId(FUNDS_PILL)).toHaveCount(0)
}

/**
 * The kept session record this origin holds for devnet (the IndexedDB row a reload picks up;
 * lib/auth/session-resume.ts), or null when nothing is kept. Rejects on an IndexedDB error.
 */
export function readKeptSession(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(
    () =>
      new Promise<Record<string, unknown> | null>((resolve, reject) => {
        const req = indexedDB.open('dash-forge')
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const db = req.result
          const get = db.transaction('vault').objectStore('vault').get('session:devnet')
          get.onerror = () => {
            db.close()
            reject(get.error)
          }
          get.onsuccess = () => {
            db.close()
            resolve((get.result as Record<string, unknown> | undefined) ?? null)
          }
        }
      }),
  )
}
