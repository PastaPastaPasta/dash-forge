/**
 * Short URLs (`ux-dx-spec.md` §5.2).
 *
 * Canonical routes stay query-param (`/repo?owner=alice&name=project&ref=main&path=src`) so one
 * static build works on Pages and IPFS. The app renders and copies short URLs:
 *
 *   /alice/project
 *   /alice/project/tree/<ref>/<path>     /alice/project/blob/<ref>/<path>
 *   /alice/project/issues[/<n>]          /alice/project/pulls, /alice/project/pull/<n>[/files|commits|checks]
 *   /alice/project/releases[/<tag>]      /alice/project/commits[/<ref>]
 *   /alice/project/releases/tag/<tag>    /alice/project/commit/<oid>
 *   /alice/project/branches, /tags, /stargazers
 *
 * `?q=` on `/issues` carries GitHub's search qualifiers through (the shim appends the query
 * string, and the Issues page lifts `is:closed label:bug …` out of `q`).
 *
 * A static host answers a short URL with `404.html`, whose inline {@link SHORT_URL_SHIM}
 * rewrites it to the canonical route. A ref containing `/` travels as one `%2F`-encoded
 * segment, so `/tree/feature%2Fx/src` is unambiguous without knowing the repo's refs.
 */

/**
 * First path segments that are the app's own routes or static files, never an owner. Every
 * top-level route in `app/`, plus the ones other launch work adds.
 */
export const RESERVED_SEGMENTS: readonly string[] = [
  '_next',
  '404',
  'api',
  'explore',
  'favicon.ico',
  'index',
  'login',
  'mirror',
  'new',
  'notifications',
  'repo',
  'robots.txt',
  'settings',
  'u',
]

export type ShortTarget =
  | { readonly kind: 'home' }
  | { readonly kind: 'tree' | 'blob'; readonly ref: string; readonly path?: string }
  | { readonly kind: 'commits'; readonly ref?: string }
  | { readonly kind: 'issues' | 'pulls' | 'releases' }
  | { readonly kind: 'issue'; readonly number: number }
  | { readonly kind: 'pull'; readonly number: number; readonly tab?: 'commits' | 'checks' | 'files' }
  | { readonly kind: 'release'; readonly tag: string }
  | { readonly kind: 'branches' | 'tags' | 'stargazers' }
  | { readonly kind: 'commit'; readonly oid: string }

const seg = (s: string): string => encodeURIComponent(s)
const pathSegs = (p: string): string =>
  p
    .split('/')
    .filter((s) => s !== '')
    .map(seg)
    .join('/')

/** The short path (no base path, no origin) for a repo view. */
export function shortRepoPath(repo: { readonly owner: string; readonly name: string }, target: ShortTarget = { kind: 'home' }): string {
  const base = `/${seg(repo.owner)}/${seg(repo.name)}`
  switch (target.kind) {
    case 'home':
      return base
    case 'tree':
    case 'blob': {
      const path = target.path ? pathSegs(target.path) : ''
      return `${base}/${target.kind}/${seg(target.ref)}${path ? `/${path}` : ''}`
    }
    case 'commits':
      return target.ref ? `${base}/commits/${seg(target.ref)}` : `${base}/commits`
    case 'issues':
    case 'pulls':
    case 'releases':
    case 'branches':
    case 'tags':
    case 'stargazers':
      return `${base}/${target.kind}`
    case 'issue':
      return `${base}/issues/${target.number}`
    case 'pull':
      return `${base}/pull/${target.number}${target.tab ? `/${target.tab}` : ''}`
    case 'release':
      return `${base}/releases/${seg(target.tag)}`
    case 'commit':
      return `${base}/commit/${seg(target.oid)}`
  }
}

/** An owner (identity id or DPNS label) and a repo name the shim accepts ({@link SHORT_URL_EXPAND_SOURCE}). */
const OWNER_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9-]*$/
const NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Whether `repo` has a short URL the shim expands back to it: an owner or name the shim refuses
 * (`alice.dash`), a reserved owner (`repo`), or a `?repo=` pin (the short form cannot carry it)
 * needs the canonical query route instead.
 */
export function hasShortUrl(repo: { readonly owner: string; readonly name: string; readonly repoId?: string }): boolean {
  return (
    !repo.repoId &&
    OWNER_SEGMENT.test(repo.owner) &&
    NAME_SEGMENT.test(repo.name) &&
    !RESERVED_SEGMENTS.includes(repo.owner.toLowerCase())
  )
}

/** The base path this build is served under (`NEXT_PUBLIC_BASE_PATH`, e.g. `/dash-forge`). */
export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '')

/** The absolute short URL for the current origin (browser only; the path alone elsewhere). */
export function shortRepoUrl(repo: { readonly owner: string; readonly name: string }, target?: ShortTarget): string {
  const path = `${BASE_PATH}${shortRepoPath(repo, target)}`
  return typeof window === 'undefined' ? path : `${window.location.origin}${path}`
}

/**
 * The 404.html shim: a self-contained function over `(pathname, base, reserved)` returning the
 * canonical href, or null when the path is not a short repo URL. Plain ES2017 in a string so
 * the exact bytes the page runs are the bytes the unit tests execute.
 */
export const SHORT_URL_EXPAND_SOURCE = `function (pathname, base, reserved) {
  var p = pathname;
  if (base) {
    if (p !== base && p.indexOf(base + '/') !== 0) return null;
    p = p.slice(base.length);
  }
  var parts = p.split('/').filter(function (s) { return s !== ''; });
  if (parts.length < 2) return null;
  var dec = function (s) { try { return decodeURIComponent(s); } catch (e) { return null; } };
  var owner = dec(parts[0]), name = dec(parts[1]);
  if (owner === null || name === null) return null;
  if (reserved.indexOf(owner.toLowerCase()) >= 0) return null;
  if (!${OWNER_SEGMENT}.test(owner) || !${NAME_SEGMENT}.test(name)) return null;
  var q = function (route, extra) {
    var s = 'owner=' + encodeURIComponent(owner) + '&name=' + encodeURIComponent(name);
    for (var i = 0; i < extra.length; i += 2) {
      if (extra[i + 1] !== '') s += '&' + extra[i] + '=' + encodeURIComponent(extra[i + 1]);
    }
    return base + route + '?' + s;
  };
  var rest = parts.slice(2);
  var kind = rest[0], arg = rest.length > 1 ? dec(rest[1]) : '';
  if (arg === null) return null;
  var tail = [];
  for (var i = 2; i < rest.length; i++) { var d = dec(rest[i]); if (d === null) return null; tail.push(d); }
  var number = /^[1-9][0-9]{0,9}$/.test(arg) ? arg : null;
  if (rest.length === 0) return q('/repo/', []);
  if (kind === 'releases' && arg === 'tag' && tail.length === 1) return q('/repo/release/', ['tag', tail[0]]);
  if ((kind === 'tree' || kind === 'blob') && rest.length >= 2) {
    return q('/repo/' + kind + '/', ['ref', arg, 'path', tail.join('/')]);
  }
  if ((kind === 'pull' || kind === 'pulls') && number && tail.length === 1 && /^(files|commits|checks)$/.test(tail[0])) {
    return q('/repo/pull/', ['number', number, 'tab', tail[0]]);
  }
  if (tail.length > 0) return null;
  if (kind === 'commits') return q('/repo/commits/', ['ref', arg]);
  if (kind === 'issues' && rest.length === 1) return q('/repo/issues/', []);
  if (kind === 'issues' && number) return q('/repo/issue/', ['number', number]);
  if (kind === 'pulls' && rest.length === 1) return q('/repo/pulls/', []);
  if ((kind === 'pull' || kind === 'pulls') && number) return q('/repo/pull/', ['number', number]);
  if (kind === 'releases' && rest.length === 1) return q('/repo/releases/', []);
  if (kind === 'releases') return q('/repo/release/', ['tag', arg]);
  if ((kind === 'branches' || kind === 'tags' || kind === 'stargazers') && rest.length === 1) return q('/repo/' + kind + '/', []);
  if (kind === 'commit' && /^[0-9a-fA-F]{4,40}$/.test(arg)) return q('/repo/commit/', ['oid', arg.toLowerCase()]);
  return null;
}`

/** The inline script for `404.html`: rewrite a short URL in place, keeping the fragment. */
export function shortUrlShimScript(base: string = BASE_PATH): string {
  return `(function(){var expand=${SHORT_URL_EXPAND_SOURCE};var to=expand(location.pathname,${JSON.stringify(
    base,
  )},${JSON.stringify(RESERVED_SEGMENTS)});if(to){document.documentElement.setAttribute('data-short-url','1');location.replace(to+(location.search?'&'+location.search.slice(1):'')+location.hash);}})();`
}
