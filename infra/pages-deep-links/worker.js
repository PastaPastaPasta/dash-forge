// Generated from forge-web/lib/deep-link-worker.ts: do not edit (docs/hosting.md, "Deep links").
const expand = function (pathname, base, reserved) {
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
  // `/github.com/<owner>/<repo>[/<rest>]` (or `/gh/…`): the page that finds that repo's Forge mirror.
  var host = owner.toLowerCase();
  if ((host === 'github.com' || host === 'gh') && parts.length >= 3) {
    var ghRepo = dec(parts[2]);
    if (ghRepo === null || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ghRepo)) return null;
    var ghRest = parts.slice(3).join('/');
    return base + '/github.com/?owner=' + encodeURIComponent(name) + '&name=' + encodeURIComponent(ghRepo.replace(/\.git$/i, '')) + (ghRest ? '&rest=' + encodeURIComponent(ghRest) : '');
  }
  // A pasted clone URL ends in `.git`. No repo name does (the contract's `nameNotDotGit`), so one
  // trailing `.git` is the clone form of the name, not part of it.
  if (name.length > 4 && /\.git$/i.test(name)) name = name.slice(0, -4);
  if (reserved.indexOf(owner.toLowerCase()) >= 0) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(owner) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
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
  // GitHub's compare: `<base>...<head>` (or `..`), or `<head>` against the default branch. A ref
  // may hold `/` unencoded here (`compare/main...feature/x`), so the rest of the path is the spec.
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
  // GitHub's policy page, `/security/policy`.
  if (kind === 'security' && arg === 'policy' && rest.length === 2) return q('/repo/security/', []);
  if (tail.length > 0) return null;
  if (kind === 'commits') return q('/repo/commits/', ['ref', ref]);
  if (kind === 'issues' && rest.length === 1) return q('/repo/issues/', []);
  if (kind === 'issues' && arg === 'new') return q('/repo/issues/', ['new', '1']);
  if (kind === 'issues' && number) return q('/repo/issue/', ['number', number]);
  if (kind === 'pulls' && rest.length === 1) return q('/repo/pulls/', []);
  if ((kind === 'pull' || kind === 'pulls') && number) return q('/repo/pull/', ['number', number]);
  if (kind === 'releases' && rest.length === 1) return q('/repo/releases/', []);
  // GitHub's `/<owner>/<repo>/settings`: a short form of its own is not made (no short URL is
  // shown for Settings), but the address people try opens the page.
  if (kind === 'settings' && rest.length === 1) return q('/repo/settings/', []);
  if (kind === 'boards' && rest.length === 1) return q('/repo/boards/', []);
  if (kind === 'boards' && number && rest.length === 2) return q('/repo/board/', ['b', number]);
  if (kind === 'releases') return q('/repo/release/', ['tag', arg]);
  if ((kind === 'branches' || kind === 'tags' || kind === 'stargazers' || kind === 'compare' || kind === 'labels' || kind === 'milestones' || kind === 'security') && rest.length === 1) return q('/repo/' + kind + '/', []);
  if (kind === 'commit' && /^[0-9a-fA-F]{4,40}$/.test(arg)) return q('/repo/commit/', ['oid', arg.toLowerCase()]);
  return null;
};
const RESERVED = [".well-known","_next","404","api","connect","docs","explore","favicon.ico","gh","github.com","icons","index","ipfs","ipns","licenses","login","manifest.webmanifest","mirror","networks","new","notifications","notify-sw.js","og.png","org","private","repo","robots.txt","settings","start","third-party-licenses.txt","u","wasm-sdk-licenses.txt"];

export default {
  async fetch(request) {
    const response = await fetch(request);
    if (response.status !== 404 || (request.method !== 'GET' && request.method !== 'HEAD')) return response;
    if (expand(new URL(request.url).pathname, '', RESERVED) === null) return response;
    return new Response(response.body, { status: 200, statusText: 'OK', headers: response.headers });
  },
};
