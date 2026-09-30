/**
 * The survivability drill, web host (roadmap Phase 1, launch criterion 3): take the host that
 * serves the web app down, and the same static build still runs from another origin — a second
 * static host, and the IPFS build through a gateway (kubo's subdomain gateway, the form a user
 * pinning the release would load) — and still reaches the repo owner's storage from there.
 *
 * The app is a static export with no backend of its own, so there is no server-side state to
 * lose: what can break is the build assuming its origin (absolute URLs, a base path) or the
 * storage refusing the new origin (CORS). Both are checked:
 *  - the landing page renders, hydrates (a client-side navigation), and the 23 MB SDK wasm —
 *    the heaviest asset — loads from the new origin, with no same-origin request failing;
 *  - from the IPFS origin, a ranged read of an object in a bucket configured with the CORS rules
 *    the app tells owners to paste (`lib/storage/cors.ts`), and a gateway read, both succeed.
 * The dead host itself is only a connection error in the browser (nothing of the app is left
 * there to explain it); "says why" is the other drills' part: `lib/view/survivability.drill.test.ts`
 * for browse, forge-core `src/survivability_tests.rs` for clone.
 *
 * Every request other than the page's own origin and the storage fixture is refused (no DAPI,
 * no devnet), so the run is deterministic. Needs `out/` (`pnpm build`) and the fixture
 * (`e2e-drill/fixture.ts`); opt-in with `FORGE_DRILL=1`.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

import { expect, test, type BrowserContext, type Page } from '@playwright/test'

import { corsFix } from '../lib/storage/cors'
import { DRILL_ON, GATEWAY, KUBO_CONTAINER, S3, createBucket, deleteBucket, docker, requireFixture, s3Admin, type CorsRule } from './fixture'

const WEB = join(__dirname, '..')
const OUT = join(WEB, 'out')

test.skip(!DRILL_ON, 'FORGE_DRILL=1 runs the survivability drill')

/** A free loopback port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      srv.close(() => (typeof addr === 'object' && addr !== null ? resolve(addr.port) : reject(new Error('no port'))))
    })
  })
}

/** Whether `url` answers at all. */
async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) })
    return true
  } catch {
    return false
  }
}

/** A static host serving `out/` the way GitHub Pages does (`e2e/static-server.mjs`), up. */
async function staticHost(): Promise<{ origin: string; proc: ChildProcess }> {
  const port = await freePort()
  const proc = spawn(process.execPath, ['e2e/static-server.mjs', '--port', String(port), '--root', 'out'], { cwd: WEB, stdio: 'ignore' })
  const origin = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100 && !(await reachable(`${origin}/`)); i++) await new Promise((r) => setTimeout(r, 100))
  expect(await reachable(`${origin}/`), `static host ${origin} did not start`).toBe(true)
  return { origin, proc }
}

/** Kill a static host and wait until nothing answers there. */
async function takeDown(host: { origin: string; proc: ChildProcess }): Promise<void> {
  host.proc.kill('SIGTERM')
  for (let i = 0; i < 100 && (await reachable(`${host.origin}/`)); i++) await new Promise((r) => setTimeout(r, 100))
  expect(await reachable(`${host.origin}/`), `${host.origin} still answers`).toBe(false)
}

/** Refuse every request that is not to `origins`: no chain, no third party. */
async function only(context: BrowserContext, origins: readonly string[]): Promise<void> {
  await context.route('**/*', (route) =>
    origins.includes(new URL(route.request().url()).origin) ? route.continue() : route.abort('blockedbyclient'),
  )
}

/**
 * The app runs from `origin`: the landing page renders, the SDK wasm loads from there, a
 * client-side navigation works, and no request to `origin` fails.
 */
async function expectAppRuns(page: Page, origin: string): Promise<void> {
  const failed: string[] = []
  const onResponse = (r: { url(): string; status(): number }): void => {
    if (r.url().startsWith(`${origin}/`) && r.status() >= 400) failed.push(`${r.status()} ${r.url()}`)
  }
  const onFailed = (r: { url(): string; failure(): { errorText: string } | null }): void => {
    if (r.url().startsWith(`${origin}/`)) failed.push(`${r.failure()?.errorText ?? 'failed'} ${r.url()}`)
  }
  page.on('response', onResponse)
  page.on('requestfailed', onFailed)
  try {
    const wasm = page.waitForResponse((r) => r.url().startsWith(`${origin}/`) && /\/_next\/static\/wasm\/[^/]+\.wasm$/.test(r.url()), { timeout: 90_000 })
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { level: 1 })).toContainText('no server to trust')
    expect((await wasm).status(), 'the SDK wasm').toBe(200)
    await page.getByRole('link', { name: /Explore/ }).first().click()
    await expect(page).toHaveURL(`${origin}/explore/`)
    expect(failed, `requests to ${origin} failed`).toEqual([])
  } finally {
    page.off('response', onResponse)
    page.off('requestfailed', onFailed)
  }
}

test('the web app survives its host going down: another static host and the IPFS build serve it', async ({ page, context }) => {
  expect(existsSync(join(OUT, 'index.html')), 'build the app first (pnpm build)').toBe(true)
  await requireFixture()

  // The IPFS build: the static export added to the kubo fixture, loaded through its subdomain
  // gateway (`<cid>.ipfs.localhost`), where the build sits at the origin root as it would for
  // a user who pinned it.
  docker('exec', KUBO_CONTAINER, 'rm', '-rf', '/tmp/forge-site')
  docker('cp', `${OUT}/.`, `${KUBO_CONTAINER}:/tmp/forge-site`)
  const cid = docker('exec', KUBO_CONTAINER, 'ipfs', 'add', '-r', '-Q', '--cid-version=1', '/tmp/forge-site')
  expect(cid).toMatch(/^bafy[a-z2-7]+$/)
  const gw = new URL(GATEWAY)
  const ipfsOrigin = `${gw.protocol}//${cid}.ipfs.localhost:${gw.port}`

  const primary = await staticHost()
  const secondary = await staticHost()
  await only(context, [primary.origin, secondary.origin, ipfsOrigin, new URL(S3).origin, gw.origin])
  try {
    await expectAppRuns(page, primary.origin)

    // The host goes down.
    await takeDown(primary)
    await expect(page.goto(`${primary.origin}/`)).rejects.toThrow(/ERR_CONNECTION_REFUSED/)

    // The same build, from elsewhere.
    await expectAppRuns(page, secondary.origin)
    await expectAppRuns(page, ipfsOrigin)

    // From the IPFS origin, the owner's storage still answers: a bucket configured with the
    // CORS rules the app tells owners to paste, and the gateway.
    // Configured for the primary host's origin: the read rule is any origin, so the IPFS
    // build reads it too. A bucket with no CORS rules is the control: the browser refuses it.
    const rules = (JSON.parse(corsFix('minio', 'bucket', primary.origin).text) as { CORSRules: CorsRule[] }).CORSRules
    const bucket = await createBucket('webhost', rules)
    const control = await createBucket('webhost-nocors')
    const body = new TextEncoder().encode('pack bytes the IPFS build reads')
    const key = 'packs/probe.pack'
    for (const b of [bucket, control]) {
      const put = await s3Admin('PUT', `/${b}/${key}`, [], body)
      expect(put.ok, `put: HTTP ${put.status}`).toBe(true)
    }
    try {
      await page.goto(`${ipfsOrigin}/`, { waitUntil: 'domcontentloaded' })
      const reads = await page.evaluate(
        async ([object, uncorsed, gateway]) => {
          const ranged = await fetch(object as string, { headers: { Range: 'bytes=0-3' } })
          const refused = await fetch(uncorsed as string, { headers: { Range: 'bytes=0-3' } }).then(
            () => 'read',
            () => 'refused',
          )
          const viaGateway = await fetch(gateway as string)
          return {
            ranged: ranged.status,
            contentRange: ranged.headers.get('content-range'),
            head: await ranged.text(),
            control: refused,
            gateway: viaGateway.status,
          }
        },
        [`${S3}/${bucket}/${key}`, `${S3}/${control}/${key}`, `${GATEWAY}/ipfs/${cid}/index.html`],
      )
      expect(reads).toEqual({ ranged: 206, contentRange: `bytes 0-3/${body.length}`, head: 'pack', control: 'refused', gateway: 200 })
    } finally {
      await deleteBucket(bucket, [key])
      await deleteBucket(control, [key])
    }
  } finally {
    primary.proc.kill('SIGTERM')
    secondary.proc.kill('SIGTERM')
  }
})
