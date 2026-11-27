/**
 * The Cloudflare Worker that answers a short URL with HTTP 200 (`infra/pages-deep-links/`).
 *
 * GitHub Pages answers every path it has no file for with `404.html` and status 404, which the
 * 404.html shim turns into the app ({@link SHORT_URL_EXPAND_SOURCE}); a person never sees the
 * difference, but link previews, crawlers and `curl` stop at the 404. Pages cannot rewrite or
 * change that status. A Worker in front of it can: it passes every response through unchanged,
 * except a 404 for a path the shim expands, which it sends with status 200 (same body and
 * headers). It runs the shim's own source, so the two never disagree on what is an app route.
 *
 * `infra/pages-deep-links/worker.js` is this function's output, checked by
 * `deep-link-worker.test.ts` (regenerate with `UPDATE_DEEP_LINK_WORKER=1`).
 */

import { RESERVED_SEGMENTS, SHORT_URL_EXPAND_SOURCE } from './short-url'

export function deepLinkWorkerSource(): string {
  return `// Generated from forge-web/lib/deep-link-worker.ts: do not edit (docs/hosting.md, "Deep links").
const expand = ${SHORT_URL_EXPAND_SOURCE};
const RESERVED = ${JSON.stringify(RESERVED_SEGMENTS)};

export default {
  async fetch(request) {
    const response = await fetch(request);
    if (response.status !== 404 || (request.method !== 'GET' && request.method !== 'HEAD')) return response;
    if (expand(new URL(request.url).pathname, '', RESERVED) === null) return response;
    return new Response(response.body, { status: 200, statusText: 'OK', headers: response.headers });
  },
};
`
}
