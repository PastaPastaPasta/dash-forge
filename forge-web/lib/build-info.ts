/**
 * "About this build" (the footer): the commit this build is from, and, when it is served from
 * IPFS, the CID it was loaded as, to compare with a release's (docs/guides/verify-the-app.md).
 *
 * The CID is what the URL says. The app cannot know its own CID (a build cannot contain its
 * own hash), and a public gateway could serve other bytes under any CID: only a node of your
 * own checks the bytes against the CID it serves. The guide says so.
 */

/** The full commit id the build was made from ('' when built without git). next.config.js. */
export const BUILD_COMMIT: string = process.env.FORGE_BUILD_COMMIT ?? ''

export const REPO_URL = 'https://github.com/PastaPastaPasta/dash-forge'

// A base32 CIDv1 (`bafy…`, `bafk…`) or a base58 CIDv0 (`Qm…`), as gateways put them in URLs.
const CID = /^(?:b[a-z2-7]{58,}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/

/**
 * The CID in a URL the app was loaded from: `https://<cid>.ipfs.<gateway>/` (subdomain),
 * `https://<gateway>/ipfs/<cid>/` (path), or `ipfs://<cid>/` (a browser with native IPFS).
 * Null for anything else, including `/ipns/` names and DNSLink hosts, which name no CID.
 */
export function servedCid(loc: Pick<Location, 'protocol' | 'hostname' | 'pathname'>): string | null {
  const candidates = [
    loc.protocol === 'ipfs:' ? loc.hostname : null,
    /^([^.]+)\.ipfs\./.exec(loc.hostname)?.[1] ?? null,
    /^\/ipfs\/([^/]+)/.exec(loc.pathname)?.[1] ?? null,
  ]
  return candidates.find((c): c is string => c !== null && CID.test(c)) ?? null
}

/** The verify guide as of this build's commit (master when the commit is unknown). */
export function verifyGuideUrl(commit: string = BUILD_COMMIT): string {
  return `${REPO_URL}/blob/${commit || 'master'}/docs/guides/verify-the-app.md`
}

/** The build's commit on GitHub, or null when unknown. */
export function commitUrl(commit: string = BUILD_COMMIT): string | null {
  return commit ? `${REPO_URL}/commit/${commit}` : null
}

/** `bafybeigd…x5ra`: enough of a CID to recognise, the whole of it in the title. */
export function shortCid(cid: string): string {
  return cid.length > 20 ? `${cid.slice(0, 10)}…${cid.slice(-6)}` : cid
}
