# Hosting the web app: cache and compression settings

The web app is a static export (`forge-web/out`). forge.dashhq.org is deployed by `.github/workflows/pages.yml` to GitHub Pages, behind Cloudflare. GitHub Pages sets its own headers and cannot be configured. Cloudflare in front of it can override them. These are the settings to apply there, and what each fixes.

## What is served today (measured 2026-09-29)

| Asset | Encoding | Cache-Control |
|---|---|---|
| HTML (`/repo/` …) | br | `max-age=600` |
| `/_next/static/chunks/*.js` | br or gzip | `max-age=14400` (4 h) or `max-age=600` |
| `/_next/static/wasm/wasm_sdk_bg.<hash>.wasm` (23.4 MB) | br 7.19 MB / gzip 8.18 MB | `max-age=600`, `cf-cache-status: DYNAMIC` |

Two consequences:
- **The wasm is not cached at the edge.** `DYNAMIC` means Cloudflare does not cache `.wasm` by default, so every cold visitor pulls it from GitHub Pages.
- **Browsers revalidate after 10 minutes** everything under `/_next/static/`. Those files have content hashes in their names and never change.

On a slow link (400 ms, 50 KB/s) that is over 90 s before the app is usable (L-54).

## Settings for the Cloudflare zone of forge.dashhq.org

### 1. Cache the hashed build output forever

Every file under `/_next/static/` has a content hash in its name (Next's `[contenthash]`, and `static/wasm/[name].[contenthash:16].wasm`), so a changed file always has a new name.

Rules → **Cache Rules** → Create rule:
- **When:** URI Path starts with `/_next/static/`
- **Cache eligibility:** Eligible for cache
- **Edge TTL:** Ignore cache-control header and use this TTL → 1 year, with a **Status Code TTL** for `400`–`599` → No cache. Without the status override a path requested before a deploy published it would stay a cached 404 for a year.
- **Browser TTL:** Override origin → 1 year

Rules → **Transform Rules** → Modify Response Header → Create rule:
- **When:** URI Path starts with `/_next/static/` **and** Response status code (`http.response.code`) equals `200`
- **Set static:** `Cache-Control` = `public, max-age=31536000, immutable`

The second rule matters because the browser TTL override alone does not add `immutable`. Without it, a reload revalidates every chunk. The status condition keeps `immutable` off a 404 and off Cloudflare's own error pages, which response header rules also reach. Header rules run after the cache decision, so they change what the browser keeps, not what the edge caches.

Cloudflare lists `http.response.code` as a response field, and says response fields are readable in the response-header phase, but availability "depends on the exact Cloudflare feature and your plan". If the expression builder does not offer it for this rule, leave the Transform Rule out. Browsers then get the 1-year browser TTL without `immutable`: a reload revalidates, but a normal navigation still reads the cache.

### 2. Cache the wasm at the edge

The Cache Rule above also covers the wasm: the path matches, and "Eligible for cache" overrides Cloudflare's extension list, which excludes `.wasm`. Verify it with:

```sh
curl -sI -H 'Accept-Encoding: br' https://forge.dashhq.org/_next/static/wasm/<file>.wasm | grep -i -E 'cf-cache-status|cache-control|content-encoding'
```

Expect `cf-cache-status: HIT` on a second request, `content-encoding: br`, and the immutable Cache-Control.

### 3. Compression

Cloudflare compresses what it serves by default (Brotli, falling back to gzip), and `application/wasm` is among the types it compresses: the measurements above show `br` served. To choose the algorithms explicitly, use **Rules → Compression Rules** (the older Speed → Optimization toggle is superseded by them):
- **When:** URI Path starts with `/_next/static/`
- **Then:** Custom, in this order: Zstandard, Brotli, Auto. `Auto` must be last: a list with no algorithm the browser accepts sends the response uncompressed.

Verify what a current browser gets (it offers all of them):

```sh
curl -s -o /dev/null -D - -H 'Accept-Encoding: gzip, deflate, br, zstd' https://forge.dashhq.org/_next/static/wasm/<file>.wasm | grep -i -E 'content-encoding|cf-cache-status'
```

Cloudflare asks the origin for gzip or Brotli only and recompresses at the edge, so zstd needs no origin support.

- **Brotli sizes:** Cloudflare's on-the-fly brotli gives 7.19 MB for the wasm. A precompressed brotli-11 file is 5.2 MB, but Cloudflare does not serve precompressed files from a GitHub Pages origin.
- **To go below 7.19 MB,** host the static assets somewhere that serves `.br` files, for example Cloudflare Pages or R2 with `Content-Encoding: br` set on upload. That is a hosting change, not a setting.

### 4. HTML stays short-lived

Leave HTML (`/`, `/repo/…`) at the origin's `max-age=600`, or shorter. A deploy changes which hashed chunks the HTML names. Old chunks stay available for two generations (`pages.yml` merges them), so a stale HTML page still loads.

### 5. Headers the app needs (already provided)

The app sets its CSP in a `<meta>` tag. COOP/COEP are not required on Pages: the SDK runs without threads.

If a future host sets headers, set these on every response:
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: credentialless`

`next.config.js` `headers()` does the same in development.

## Other static hosts (IPFS gateways, S3, nginx)

The same rules apply:
- `/_next/static/**` → `Cache-Control: public, max-age=31536000, immutable`
- brotli (or gzip) for `.js`, `.css`, `.wasm`
- `application/wasm` as the wasm MIME type, which the browser needs to compile while streaming
- HTML short-lived

For nginx. `add_header` in a `location` replaces every `add_header` inherited from the `server`, so a location that sets Cache-Control must repeat the other headers the site sends:

```nginx
server {
  add_header Cross-Origin-Opener-Policy "same-origin" always;
  add_header Cross-Origin-Embedder-Policy "credentialless" always;

  location /_next/static/ {
    # Repeated here: this location's add_header replaces the server's.
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "credentialless" always;
    add_header Cache-Control "public, max-age=31536000, immutable";
    brotli_static on;   # ngx_brotli; serves .br files built next to the originals
    gzip_static on;
  }
}
```

nginx's stock `mime.types` maps `.wasm` to `application/wasm` (added in May 2021, nginx ticket #1606; check your `mime.types` for the line). If it is missing, add `application/wasm wasm;` to that file rather than a `types { … }` block in a `server` or `location`, which would replace the inherited map instead of extending it.
