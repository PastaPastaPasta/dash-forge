import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright config for the Forge Web e2e suite.
 *
 * Tests run headless Chromium against the LOCAL static build (`out/`) served on
 * port 4321 — same bytes deployed to GitHub Pages / IPFS, but local for speed and
 * request-interception control. The build targets a forge-v2 **devnet** (`E2E_DEVNET`,
 * default `moutai`), so the specs exercise real on-chain data: the read fixture that
 * `forge-contracts/scripts/seed-v2-fixture.mjs` seeds there (e2e/helpers.ts `DEMO`).
 * Testnet has no forge-v2 deployment, so a testnet build has nothing to read.
 *
 * The WASM SDK loads lazily post-paint and connects to the devnet's DAPI, so data pages
 * need a generous timeout; the per-test timeout is bumped accordingly.
 */

const PORT = Number(process.env.E2E_PORT ?? 4321)
const BASE_URL = `http://127.0.0.1:${PORT}`

/** The devnet the build under test reads. Keep the default in step with e2e/helpers.ts. */
const DEVNET = process.env.E2E_DEVNET || 'moutai'
const BUILD_ENV = `NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=${DEVNET} `

export default defineConfig({
  testDir: './e2e',
  // Real devnet round-trips (SDK connect + proof-verified reads) are slow; be generous.
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/report' }]],
  outputDir: 'e2e/test-results',
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // Deterministic desktop viewport for the read-path + a11y specs.
    viewport: { width: 1280, height: 900 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Safari's engine, for the flows whose storage and passkey behaviour differ there.
      name: 'webkit',
      testMatch: /signin-resilience\.spec\.ts/,
      use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 900 } },
    },
  ],
  // Build (if needed) then serve out/ with a hermetic, dependency-free static server
  // (sets COOP/COEP for the WASM SDK and mirrors trailingSlash routing). If you already
  // have a fresh out/ built for the same devnet, set E2E_SKIP_BUILD=1 to skip the rebuild
  // and just serve it.
  webServer: {
    command: process.env.E2E_SKIP_BUILD
      ? `node e2e/static-server.mjs --port ${PORT}`
      : `${BUILD_ENV}pnpm build && node e2e/static-server.mjs --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
