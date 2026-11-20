/**
 * Cloudflare Web Analytics, for a hosted build that opts in (forge.dashhq.org does: docs/hosting.md
 * §6). `NEXT_PUBLIC_CF_BEACON_TOKEN` is the site token from the Cloudflare dashboard (public: it
 * ships in every page). Unset, the build has no beacon, which is the default for self-hosted and
 * IPFS builds.
 *
 * The page carries the beacon itself, so every byte of it is in the build manifest. Cloudflare's
 * automatic setup may inject a second copy at the edge: `dg verify-app` removes exactly that tag,
 * and it never runs twice (docs/hosting.md §6). The script is pinned to one version and its SRI hash, and the page CSP allows that exact URL
 * and nothing else from Cloudflare: the origin keeps the signing-key vault, so a third-party
 * script must not change under it. To move to a newer beacon, take `src` and `integrity` from the tag
 * Cloudflare injects and update both.
 */
export const CF_BEACON_SRC =
  'https://static.cloudflareinsights.com/beacon.min.js/vce701823e78c4301a35b7e07294d87301792088814092'
export const CF_BEACON_INTEGRITY =
  'sha512-UKNk8GbxkABxKcXYuLkO16EleLGUkcvJWtpSNmExE0Too3ZaFAxTscNWEc1OdAv5/BikHawapSCaiD2XCmp+Bw=='

export interface CfBeacon {
  readonly src: string
  readonly integrity: string
  /**
   * The `data-cf-beacon` attribute, as in the snippet Cloudflare gives for manual installation:
   * the token alone. Without `version` the beacon reports to cloudflareinsights.com, not to the
   * zone's own /cdn-cgi/rum (which automatic setup serves), and it counts client-side navigations.
   */
  readonly config: string
}

/** The beacon a build with these environment values carries, or null for none (pure, for the tests). */
export function cfBeacon(token: string | undefined, ipfsBuild: boolean): CfBeacon | null {
  if (!token) return null
  if (!/^[0-9a-f]{32}$/.test(token)) throw new Error('NEXT_PUBLIC_CF_BEACON_TOKEN is not a Cloudflare Web Analytics site token (32 lowercase hex characters)')
  if (ipfsBuild) throw new Error('the IPFS build carries no analytics; unset NEXT_PUBLIC_CF_BEACON_TOKEN')
  return { src: CF_BEACON_SRC, integrity: CF_BEACON_INTEGRITY, config: JSON.stringify({ token }) }
}

export const CF_BEACON = cfBeacon(process.env.NEXT_PUBLIC_CF_BEACON_TOKEN, process.env.FORGE_IPFS_BUILD === '1')
