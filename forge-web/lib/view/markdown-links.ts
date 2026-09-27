/**
 * Where a Markdown link or image points, once the renderer knows which repo file it came from
 * (D-051), and whether an image may load without a click (D-053).
 */

/** A path in the repo, from a link relative to the file at `fromDir` ('' = root). Null when it climbs out. */
export function resolveRepoPath(fromDir: string, relative: string): string | null {
  const parts = fromDir.split('/').filter((p) => p !== '')
  for (const seg of relative.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else parts.push(seg)
  }
  return parts.join('/')
}

/** A relative href split into its path and its `?query` / `#fragment` tail (the tail is dropped for repo reads). */
export function splitHref(href: string): { path: string; fragment: string } {
  const hash = href.indexOf('#')
  const q = href.indexOf('?')
  const cut = [hash, q].filter((n) => n >= 0).reduce((a, b) => Math.min(a, b), href.length)
  let path = href.slice(0, cut)
  try {
    path = decodeURIComponent(path)
  } catch {
    /* keep it as written */
  }
  return { path, fragment: hash >= 0 ? href.slice(hash + 1) : '' }
}

/** The host of an absolute http(s) URL (lowercase), or null. */
export function urlHostOf(src: string): string | null {
  try {
    const u = new URL(src)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname.toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * `http://host/x` as `https://host/x`: the site is served over https, where a plain-http image
 * is mixed content (blocked, or auto-upgraded with a console warning). Hosts that still only
 * serve http fail either way, and the renderer then links to the image instead.
 */
export function upgradeHttp(src: string): string {
  return /^http:\/\//i.test(src) ? `https://${src.slice(7)}` : src
}

/** Hosts the viewer chose to always load images from, kept in this browser only. */
export const IMAGE_HOSTS_KEY = 'forge.imageHosts.v1'

/** Parse the stored always-allow list: lowercase host names, capped. */
export function parseImageHosts(raw: string | null): string[] {
  if (raw === null) return []
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string' && /^[a-z0-9.-]{1,253}$/.test(h)).slice(0, 500) : []
  } catch {
    return []
  }
}
