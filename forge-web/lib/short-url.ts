/**
 * Short URLs (`ux-dx-spec.md` §5.2).
 *
 * Canonical routes stay query-param (`/repo?owner=alice&name=project&ref=main&path=src`) so one
 * static build works on Pages and IPFS. The app renders and copies short URLs:
 *
 *   /alice/project
 *   /alice/project/tree/<ref>/<path>     /alice/project/blob/<ref>/<path>
 *   /alice/project/issues[/<n>|/new]     /alice/project/pulls, /alice/project/pull/<n>[/files|commits|checks]
 *   /alice/project/releases[/<tag>]      /alice/project/commits[/<ref>]
 *   /alice/project/releases/tag/<tag>    /alice/project/commit/<oid>
 *   /alice/project/commits/<ref>/<path>  (a path's History)   /alice/project/blame/<ref>/<path>
 *   /alice/project/branches, /tags, /stargazers, /labels, /milestones
 *   /alice/project/compare/<base>...<head>, /alice/project/compare/<head>  (GitHub's compare)
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
  // `/github.com/<owner>/<repo>` and `/gh/<owner>/<repo>`: the Forge mirror of a GitHub repo (CJ-3).
  'gh',
  'github.com',
  'index',
  // The IPFS variant reads `/ipfs/<cid>/` and `/ipns/<name>/` as its base path (scripts/ipfs-base.cjs).
  'ipfs',
  'ipns',
  'login',
  'mirror',
  'new',
  'notifications',
  'repo',
  'robots.txt',
  'settings',
  'start',
  'u',
]

/** A GitHub owner or repo segment the alias accepts (GitHub's own characters). */
const GITHUB_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * The page that opens a GitHub repo's Forge mirror (`app/github.com`), for `owner/name` and an
 * optional rest of a GitHub path (`issues/12`), which opens the same view of the mirror.
 */
export function upstreamAliasPath(owner: string, name: string, rest = ''): string {
  const q = new URLSearchParams({ owner, name })
  if (rest !== '') q.set('rest', rest)
  return `/github.com/?${q.toString()}`
}

export type ShortTarget =
  | { readonly kind: 'home' }
  | { readonly kind: 'tree' | 'blob' | 'blame'; readonly ref: string; readonly path?: string }
  | { readonly kind: 'commits'; readonly ref?: string; readonly path?: string }
  | { readonly kind: 'issues' | 'pulls' | 'releases' }
  | { readonly kind: 'issue'; readonly number: number }
  /** GitHub's `/issues/new`: the Issues list with its New issue composer open (QW3-063). */
  | { readonly kind: 'newIssue' }
  | { readonly kind: 'pull'; readonly number: number; readonly tab?: 'commits' | 'checks' | 'files' }
  | { readonly kind: 'release'; readonly tag: string }
  | { readonly kind: 'branches' | 'tags' | 'stargazers' | 'labels' | 'milestones' }
  | { readonly kind: 'commit'; readonly oid: string }
  | { readonly kind: 'compare'; readonly base?: string; readonly head: string }

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
    case 'blob':
    case 'blame': {
      const path = target.path ? pathSegs(target.path) : ''
      return `${base}/${target.kind}/${seg(target.ref)}${path ? `/${path}` : ''}`
    }
    case 'commits': {
      // A path's History needs the ref segment before it (GitHub's `/commits/<ref>/<path>`).
      const path = target.path ? pathSegs(target.path) : ''
      if (path) return `${base}/commits/${seg(target.ref ?? 'HEAD')}/${path}`
      return target.ref ? `${base}/commits/${seg(target.ref)}` : `${base}/commits`
    }
    case 'issues':
    case 'pulls':
    case 'releases':
    case 'branches':
    case 'tags':
    case 'stargazers':
    case 'labels':
    case 'milestones':
      return `${base}/${target.kind}`
    case 'issue':
      return `${base}/issues/${target.number}`
    case 'newIssue':
      return `${base}/issues/new`
    case 'pull':
      return `${base}/pull/${target.number}${target.tab ? `/${target.tab}` : ''}`
    case 'release':
      return `${base}/releases/${seg(target.tag)}`
    case 'commit':
      return `${base}/commit/${seg(target.oid)}`
    case 'compare':
      return `${base}/compare/${target.base ? `${seg(target.base)}...` : ''}${seg(target.head)}`
  }
}

/**
 * An owner (identity id, DPNS label, or full DPNS name such as `alice.dash`, L-82) and a repo
 * name the shim accepts ({@link SHORT_URL_EXPAND_SOURCE}).
 */
const OWNER_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9.-]*$/
const NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Whether this build hands out short URLs. Not the IPFS variant (`pnpm build:ipfs`): a short URL
 * opens only through the `404.html` shim, and IPFS gateways do not serve `404.html` for a missing
 * path, so its Copy link and permalinks use the canonical routes, which are real pages.
 */
const SHORT_URLS = process.env.FORGE_IPFS_BUILD !== '1'

/**
 * Whether `repo`'s owner and name have a short path the shim expands back to them: an owner or
 * name the shim refuses (`.hidden`) or a reserved owner (`repo`) needs the canonical route.
 */
function hasShortPath(repo: { readonly owner: string; readonly name: string }): boolean {
  return SHORT_URLS && OWNER_SEGMENT.test(repo.owner) && NAME_SEGMENT.test(repo.name) && !RESERVED_SEGMENTS.includes(repo.owner.toLowerCase())
}

/**
 * Whether `repo` has a short URL with no query string: {@link hasShortPath}, and no `?repo=` pin
 * (permalinks, which add their own path segments, need it bare).
 */
export function hasShortUrl(repo: { readonly owner: string; readonly name: string; readonly repoId?: string }): boolean {
  return !repo.repoId && hasShortPath(repo)
}

/** The base path this build is served under (`NEXT_PUBLIC_BASE_PATH`, e.g. `/dash-forge`). */
export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '')

/**
 * The link Copy link copies (L-55), absolute for the current origin in a browser: the short URL,
 * keeping a `?repo=` pin as its query string (the shim carries the query through, so the link
 * still opens that exact repo); the canonical query route when the owner or name has no short
 * form.
 */
export function shortRepoUrl(repo: { readonly owner: string; readonly name: string; readonly repoId?: string }, target?: ShortTarget): string {
  const pin = repo.repoId ? `?repo=${encodeURIComponent(repo.repoId)}` : ''
  const path = BASE_PATH + (hasShortPath(repo) ? `${shortRepoPath(repo, target)}${pin}` : canonicalPath(repo, target))
  return typeof window === 'undefined' ? path : `${window.location.origin}${path}`
}

/** The canonical query route of a short target (what the shim would expand it to). */
function canonicalPath(repo: { readonly owner: string; readonly name: string; readonly repoId?: string }, target: ShortTarget = { kind: 'home' }): string {
  const q = new URLSearchParams({ owner: repo.owner, name: repo.name })
  if (repo.repoId) q.set('repo', repo.repoId)
  const route = (r: string, extra: Record<string, string | undefined> = {}): string => {
    for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v)
    return `/repo${r}/?${q.toString()}`
  }
  switch (target.kind) {
    case 'home':
      return route('')
    case 'tree':
    case 'blob':
    case 'blame':
    case 'commits':
      return route(`/${target.kind}`, { ref: target.ref, path: target.path })
    case 'issues':
    case 'pulls':
    case 'releases':
    case 'branches':
    case 'tags':
    case 'stargazers':
    case 'labels':
    case 'milestones':
      return route(`/${target.kind}`)
    case 'issue':
      return route('/issue', { number: String(target.number) })
    case 'newIssue':
      return route('/issues', { new: '1' })
    case 'pull':
      return route('/pull', { number: String(target.number), tab: target.tab })
    case 'release':
      return route('/release', { tag: target.tag })
    case 'commit':
      return route('/commit', { oid: target.oid })
    case 'compare':
      return route('/compare', { base: target.base, head: target.head })
  }
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
  // \`/github.com/<owner>/<repo>[/<rest>]\` (or \`/gh/…\`): the page that finds that repo's Forge mirror.
  var host = owner.toLowerCase();
  if ((host === 'github.com' || host === 'gh') && parts.length >= 3) {
    var ghRepo = dec(parts[2]);
    if (ghRepo === null || !${GITHUB_SEGMENT}.test(name) || !${GITHUB_SEGMENT}.test(ghRepo)) return null;
    var ghRest = parts.slice(3).join('/');
    return base + '/github.com/?owner=' + encodeURIComponent(name) + '&name=' + encodeURIComponent(ghRepo.replace(/\\.git$/, '')) + (ghRest ? '&rest=' + encodeURIComponent(ghRest) : '');
  }
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
  // HEAD (the default branch in a GitHub URL) is the default ref: no ref param.
  var ref = arg === 'HEAD' ? '' : arg;
  if ((kind === 'tree' || kind === 'blob' || kind === 'blame') && rest.length >= 2) {
    return q('/repo/' + kind + '/', ['ref', ref, 'path', tail.join('/')]);
  }
  if (kind === 'commits' && tail.length > 0) return q('/repo/commits/', ['ref', ref, 'path', tail.join('/')]);
  // GitHub's compare: \`<base>...<head>\` (or \`..\`), or \`<head>\` against the default branch. A ref
  // may hold \`/\` unencoded here (\`compare/main...feature/x\`), so the rest of the path is the spec.
  if (kind === 'compare' && rest.length >= 2) {
    var spec = [arg].concat(tail).join('/');
    var dots = spec.indexOf('...'), two = spec.indexOf('..');
    var cut = dots >= 0 ? dots : two, len = dots >= 0 ? 3 : 2;
    var cmpBase = cut >= 0 ? spec.slice(0, cut) : '', cmpHead = cut >= 0 ? spec.slice(cut + len) : spec;
    if (cmpHead === '' || (cut >= 0 && cmpBase === '')) return null;
    return q('/repo/compare/', ['base', cmpBase, 'head', cmpHead]);
  }
  if ((kind === 'pull' || kind === 'pulls') && number && tail.length === 1 && /^(files|commits|checks)$/.test(tail[0])) {
    return q('/repo/pull/', ['number', number, 'tab', tail[0]]);
  }
  if (tail.length > 0) return null;
  if (kind === 'commits') return q('/repo/commits/', ['ref', ref]);
  if (kind === 'issues' && rest.length === 1) return q('/repo/issues/', []);
  if (kind === 'issues' && arg === 'new') return q('/repo/issues/', ['new', '1']);
  if (kind === 'issues' && number) return q('/repo/issue/', ['number', number]);
  if (kind === 'pulls' && rest.length === 1) return q('/repo/pulls/', []);
  if ((kind === 'pull' || kind === 'pulls') && number) return q('/repo/pull/', ['number', number]);
  if (kind === 'releases' && rest.length === 1) return q('/repo/releases/', []);
  if (kind === 'releases') return q('/repo/release/', ['tag', arg]);
  if ((kind === 'branches' || kind === 'tags' || kind === 'stargazers' || kind === 'compare' || kind === 'labels' || kind === 'milestones') && rest.length === 1) return q('/repo/' + kind + '/', []);
  if (kind === 'commit' && /^[0-9a-fA-F]{4,40}$/.test(arg)) return q('/repo/commit/', ['oid', arg.toLowerCase()]);
  return null;
}`

/** The inline script for `404.html`: rewrite a short URL in place, keeping the fragment. */
export function shortUrlShimScript(base: string = BASE_PATH): string {
  return `(function(){var expand=${SHORT_URL_EXPAND_SOURCE};var to=expand(location.pathname,${JSON.stringify(
    base,
  )},${JSON.stringify(RESERVED_SEGMENTS)});if(to){document.documentElement.setAttribute('data-short-url','1');location.replace(to+(location.search?'&'+location.search.slice(1):'')+location.hash);}})();`
}
