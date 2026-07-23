import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright config for the Forge Web e2e suite.
 *
 * Tests run headless Chromium against the LOCAL static build (`out/`) served on
 * port 4321 — same bytes deployed to GitHub Pages / IPFS, but local for speed and
 * request-interception control. The app talks to Dash Platform **testnet** (the
 * app default, `DEFAULT_NETWORK`), so read-path specs exercise real on-chain data.
 *
 * The WASM SDK loads lazily post-paint and connects to testnet DAPI, so data pages
 * need a generous timeout; the per-test timeout is bumped accordingly.
 */

const PORT = Number(process.env.E2E_PORT ?? 4321)
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './e2e',
  // Real testnet round-trips (SDK connect + proof-verified reads) are slow; be generous.
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
  ],
  // Build (if needed) then serve out/ with a hermetic, dependency-free static server
  // (sets COOP/COEP for the WASM SDK and mirrors trailingSlash routing). If you already
  // have a fresh out/, set E2E_SKIP_BUILD=1 to skip the rebuild and just serve it.
  webServer: {
    command: process.env.E2E_SKIP_BUILD
      ? `node e2e/static-server.mjs --port ${PORT}`
      : `pnpm build && node e2e/static-server.mjs --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
