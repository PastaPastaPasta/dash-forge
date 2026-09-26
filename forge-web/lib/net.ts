/**
 * Which URLs may be recorded on chain, and which a reader may fetch.
 *
 * Anything a `packManifest` records is read by every visitor's browser, so it must be a public
 * https URL: never plain http, never this machine or a private network. Otherwise one owner's
 * manifest could make every reader's browser send requests to its own local services (blind
 * GET-CSRF, port probing), and a copy only its uploader can reach would count as "stored".
 * Loopback http is fine only for what the user's own browser talks to directly while setting
 * up storage (a local kubo API, a local MinIO endpoint), never for what gets published.
 */

/**
 * Whether `hostname` names this machine or a private / link-local network.
 *
 * Literal addresses and reserved names only: a page cannot resolve DNS, so a public name that
 * resolves to a private address (`127.0.0.1.nip.io`, DNS rebinding) passes. That residual is
 * bounded by the rest of the design: every byte read is hash-checked, requests carry no
 * credentials, and responses are opaque to other origins.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  if (h.includes(':')) {
    // IPv6: loopback, unspecified, unique-local fc00::/7, link-local fe80::/10, v4-mapped.
    return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:')
  }
  return false
}

/** Whether `url` is a public https URL (what readers may fetch and a manifest may record). */
export function isPublicHttpsUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && !isPrivateHost(u.hostname) && u.username === '' && u.password === ''
  } catch {
    return false
  }
}

/**
 * Whether a manifest may record `uri`: a public https URL, or a non-HTTP locator browsers do
 * not fetch directly (`ipfs://`, `s3://`, `platform://`).
 */
export function isRecordableUri(uri: string): boolean {
  if (/^(ipfs|s3|platform):\/\//i.test(uri)) return true
  return isPublicHttpsUrl(uri)
}
