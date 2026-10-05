/**
 * The optional notification service this build names (`NEXT_PUBLIC_NOTIFY_URL`), kept apart from
 * `./client` so a page can ask whether there is one without loading the signing code.
 */

/**
 * The configured service, or null when this build has none. `process.env.NEXT_PUBLIC_*` must be
 * written out literally: Next inlines it at build time.
 */
export const NOTIFY_URL: string | null = normalizeUrl(process.env.NEXT_PUBLIC_NOTIFY_URL)

/** An https URL without a trailing slash (http only for a loopback test service), else null. */
export function normalizeUrl(raw: string | undefined): string | null {
  const v = raw?.trim()
  if (!v) return null
  try {
    const u = new URL(v)
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}
