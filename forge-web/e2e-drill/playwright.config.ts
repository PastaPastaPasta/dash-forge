import { defineConfig, devices } from '@playwright/test'

/**
 * The survivability drill's web-host spec (`web-host.spec.ts`): the static build (`out/`, built
 * first) served from two ordinary hosts and as an IPFS build through the kubo fixture. No chain,
 * no devnet: every request that is not the page's own origin or the storage fixture is refused,
 * so the run is deterministic. The spec starts and kills its own hosts; nothing to serve here.
 *
 * `FORGE_DRILL=1 pnpm exec playwright test -c e2e-drill/playwright.config.ts` (see
 * `e2e-drill/fixture.ts` for the endpoints).
 */
export default defineConfig({
  testDir: '.',
  testMatch: /\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    headless: true,
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
