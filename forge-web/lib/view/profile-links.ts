/**
 * Profile addresses (D-222): `/u/?id=<identity id>` names an identity exactly; `/u/?name=` takes a
 * DPNS name (and, as before, an identity id). Links built from an identity id use `?id=`, so a
 * DPNS label that happens to look like an id can never stand in for one.
 */

/** A profile by identity id. */
export function identityHref(identityId: string, page: '' | 'followers' | 'following' = ''): string {
  return `/u/${page === '' ? '' : `${page}/`}?id=${encodeURIComponent(identityId)}`
}

/** A profile link's text: the URL without `https://` and a lone trailing `/`. */
export function linkLabel(url: string): string {
  return url.replace(/^https:\/\//, '').replace(/^([^/?#]+)\/$/, '$1')
}
