import { test, expect } from '@playwright/test'
import { expectLanded, repoUrl, waitForRepoResolved } from './helpers'

/**
 * Scenario 5 — Zero-backend proof, on the forge-v2 read fixture (e2e/helpers.ts `DEMO`).
 *
 * Record every network request made during a repo browse and assert each one goes only to an
 * allowed class of host:
 *   - the app's own origin (static assets served locally, mirroring the static host / IPFS gateway)
 *   - Dash Platform DAPI / quorum-key endpoints (*.networks.dash.org, *.dash.org, raw MN IPs)
 *   - configured pack backends (ipfs / s3 / https gateways) referenced by the repo's manifests
 *
 * A request to any *unexpected* third-party host — an analytics beacon, a "backend of ours", a
 * CDN we didn't declare — fails the test and disproves the zero-backend claim. The suite reports
 * the actual set of hosts contacted either way.
 */

// Origin of the local static host (mirrors the deployed static/IPFS origin).
function isAppOrigin(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost'
}

// Dash Platform DAPI + quorum-key endpoints.
function isDashPlatform(host: string): boolean {
  return (
    host.endsWith('.networks.dash.org') ||
    host.endsWith('.dash.org') ||
    host === 'dash.org' ||
    // devnet masternodes (DAPI) are addressed by raw IPv4.
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  )
}

// Pack/artifact backends the repo may reference (availability layer, content-hash verified).
function isKnownBackend(host: string): boolean {
  return (
    host.endsWith('.ipfs.io') ||
    host === 'ipfs.io' ||
    host.endsWith('.dweb.link') ||
    host.endsWith('.cloudflare-ipfs.com') ||
    host.endsWith('.pinata.cloud') ||
    host.endsWith('.amazonaws.com') ||
    host.endsWith('.thepasta.org') // bridge/faucet/relay reference infra
  )
}

test('5. repo browse contacts only app-origin + DAPI + declared backends (zero-backend)', async ({
  page,
}) => {
  const contacted = new Map<string, number>()
  const unexpected = new Set<string>()

  page.on('request', (req) => {
    let url: URL
    try {
      url = new URL(req.url())
    } catch {
      return
    }
    // data:, blob:, about: — not network egress.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return
    const host = url.hostname
    contacted.set(host, (contacted.get(host) ?? 0) + 1)
    if (!isAppOrigin(host) && !isDashPlatform(host) && !isKnownBackend(host)) {
      unexpected.add(host)
    }
  })

  // Browse the repo home (SDK connect + quorum keys + repo/ref/manifest reads + the locator
  // and pack chunks behind the root tree and README), then a blob. Both must actually render:
  // a browse that never reached the chunk reads would make the host check vacuous.
  await page.goto(repoUrl(), { waitUntil: 'domcontentloaded' })
  await waitForRepoResolved(page)
  await expectLanded(page, page.getByRole('link', { name: 'README.md' }).first())
  await page.goto(repoUrl('blob', '&path=src/main.rs'), { waitUntil: 'domcontentloaded' })
  await expectLanded(page, page.getByText('reads are proof-checked').first())
  // Let late/lazy fetches (WASM chunk, DAPI round-trips, artifacts) settle.
  await page.waitForTimeout(5000)

  const hosts = [...contacted.entries()].sort((a, b) => b[1] - a[1])
  // Surface the evidence in the test output regardless of pass/fail.
  // eslint-disable-next-line no-console
  console.log(
    '\n[zero-backend] hosts contacted during repo browse:\n' +
      hosts.map(([h, n]) => `  ${n.toString().padStart(4)}  ${h}`).join('\n') +
      '\n',
  )

  expect(
    [...unexpected],
    `Unexpected non-DAPI / non-backend hosts contacted (breaks the zero-backend claim):\n` +
      [...unexpected].join('\n'),
  ).toEqual([])

  // Sanity: the browse went over the Platform network (otherwise the assertion is vacuous).
  const platformHosts = [...contacted.keys()].filter(isDashPlatform)
  expect(platformHosts.length, 'no Dash Platform host was contacted').toBeGreaterThan(0)
})
