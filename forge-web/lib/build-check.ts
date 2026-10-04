/**
 * Whether this copy of the app is a build this repository published: its `forge-manifest.json`
 * (every file's SHA-256, scripts/build-manifest.mjs) has a GitHub build-provenance attestation
 * from this repository's CI (the Pages deploy, or a release). The private-repo unlock shows a
 * notice when it does not (docs/guides/verify-the-app.md).
 *
 * This is a check for honest mistakes and unofficial copies, not a defence: a malicious build
 * can skip it or lie. `dg verify-app` checks a site from outside, file by file.
 */

import { REPO_URL } from './build-info'
import { GITHUB_API } from './mirror/wizard'
import { BASE_PATH } from './short-url'

export type BuildCheck = 'published' | 'unpublished' | 'unknown'

const REPO = REPO_URL.replace('https://github.com/', '')

/** The site root this page was served under: the IPFS variant sets a <base>, a host build has its base path. */
export function siteRoot(doc: Pick<Document, 'baseURI' | 'querySelector'>, loc: Pick<Location, 'origin'>): string {
  return doc.querySelector('base') !== null ? new URL('.', doc.baseURI).href : `${loc.origin}${BASE_PATH}/`
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Check the build at `root` (see the module comment). `unknown` when the manifest or GitHub could
 * not be read (offline, rate-limited): no notice then, since nothing was learned.
 */
export async function checkBuild(root: string, fetchImpl: typeof fetch = fetch): Promise<BuildCheck> {
  let manifest: ArrayBuffer
  try {
    const res = await fetchImpl(new URL('forge-manifest.json', root).href, { cache: 'no-store' })
    if (res.status === 404) return 'unpublished'
    if (!res.ok) return 'unknown'
    manifest = await res.arrayBuffer()
  } catch {
    return 'unknown'
  }
  try {
    const digest = hex(await crypto.subtle.digest('SHA-256', manifest))
    const res = await fetchImpl(`${GITHUB_API}/repos/${REPO}/attestations/sha256:${digest}`, { headers: { Accept: 'application/vnd.github+json' } })
    if (res.status === 404) return 'unpublished'
    if (!res.ok) return 'unknown'
    const body = (await res.json()) as { attestations?: unknown[] }
    return Array.isArray(body.attestations) && body.attestations.length > 0 ? 'published' : 'unpublished'
  } catch {
    return 'unknown'
  }
}

let once: Promise<BuildCheck> | null = null

/** {@link checkBuild} of the page's own build, once per page load; asked again after an `unknown`. */
export function checkThisBuild(): Promise<BuildCheck> {
  const run = (once ??= checkBuild(siteRoot(document, location)))
  void run.then((r) => {
    if (r === 'unknown' && once === run) once = null
  })
  return run
}
